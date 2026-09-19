const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

function makeHarness(platform = 'win32', options = {}) {
  const handlers = new Map();
  const notifications = [];
  const sockets = [];
  const servers = [];
  const nativeEvents = new EventEmitter();
  const injected = [];
  const suppressions = new Map();
  const loginSettings = [];
  let suppressionId = 0;

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closeCalled = false;
      this.terminateCalled = false;
      sockets.push(this);
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    }

    receive(payload) {
      this.emit('message', Buffer.from(JSON.stringify(payload)));
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.closeCalled = true;
      this.readyState = MockWebSocket.CLOSING;
    }

    terminate() {
      this.terminateCalled = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    ping() {}
  }

  class MockWebSocketServer extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.closed = false;
      servers.push(this);
      queueMicrotask(() => this.emit('listening'));
    }

    close(callback) {
      this.closed = true;
      callback?.();
    }
  }

  const uIOhook = Object.assign(nativeEvents, {
    start() {},
    stop() {},
    keyToggle(keycode, action) { injected.push({ keycode, action }); },
    registerSuppress(rules) {
      const id = ++suppressionId;
      suppressions.set(id, { rules, enabled: true });
      return id;
    },
    toggleSuppress(id, enabled) {
      const entry = suppressions.get(id);
      if (!entry) throw new Error('unknown suppression');
      entry.enabled = Boolean(enabled);
    },
    unregisterSuppress(id) { suppressions.delete(id); }
  });

  const UiohookKey = {
    A: 30,
    W: 17,
    Ctrl: 29,
    CtrlRight: 3613,
    Alt: 56,
    AltRight: 3640,
    Escape: 1
  };

  class MockBrowserWindow {
    static windows = [];
    static getAllWindows() { return MockBrowserWindow.windows; }

    constructor() {
      this.destroyed = false;
      this.webContents = {
        send: (channel, payload) => notifications.push({ channel, payload }),
        setWindowOpenHandler() {},
        on() {}
      };
      MockBrowserWindow.windows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    loadFile() {}
  }

  class MockApp extends EventEmitter {
    constructor() {
      super();
      this.isPackaged = Boolean(options.packaged);
    }
    whenReady() { return Promise.resolve(); }
    quit() {}
    setLoginItemSettings(settings) { loginSettings.push(settings); }
  }

  const electronMock = {
    app: new MockApp(),
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle(channel, fn) { handlers.set(channel, fn); }
    }
  };

  const originalLoad = Module._load;
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'ws') return { WebSocket: MockWebSocket, WebSocketServer: MockWebSocketServer };
    if (request === '@fainthit/uiohook-napi-suppress') return { uIOhook, UiohookKey };
    return originalLoad.call(this, request, parent, isMain);
  };

  const mainPath = path.resolve(__dirname, '../src/main.js');
  delete require.cache[mainPath];
  require(mainPath);

  Module._load = originalLoad;
  Object.defineProperty(process, 'platform', { value: originalPlatform });

  return {
    handlers,
    notifications,
    sockets,
    servers,
    uIOhook,
    UiohookKey,
    injected,
    suppressions,
    loginSettings
  };
}

async function authorizeSender(harness, host = '192.168.1.20') {
  const connect = harness.handlers.get('sender:connect');
  const promise = connect(null, { host, port: 39393, code: '123456' });
  const socket = harness.sockets.at(-1);
  socket.open();
  assert.deepEqual(socket.sent.at(-1), { type: 'auth', code: '123456' });
  socket.receive({ type: 'auth-ok', platform: 'linux' });
  await promise;
  return socket;
}

test('stale close from an old socket cannot tear down a newer sender connection', async () => {
  const h = makeHarness('win32');
  const first = await authorizeSender(h, '192.168.1.20');

  const secondPromise = h.handlers.get('sender:connect')(null, {
    host: '192.168.1.21',
    port: 39393,
    code: '123456'
  });
  const second = h.sockets.at(-1);
  second.open();
  second.receive({ type: 'auth-ok', platform: 'linux' });
  await secondPromise;

  first.readyState = first.constructor.CLOSED;
  first.emit('close');

  const state = await h.handlers.get('sender:set-sharing')(null, true);
  assert.equal(state.target, 'pc');
  assert.equal(state.exclusive, true);

  h.handlers.get('sender:disconnect')();
});

test('switching to the PC waits for every held key, not only the shortcut keys', async () => {
  const h = makeHarness('win32');
  await authorizeSender(h);

  const { W, Ctrl, Alt, A } = h.UiohookKey;
  h.uIOhook.emit('keydown', { keycode: W, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  h.uIOhook.emit('keydown', { keycode: Ctrl, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false });
  h.uIOhook.emit('keydown', { keycode: Alt, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false });
  h.uIOhook.emit('keydown', { keycode: A, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false });

  let state = h.handlers.get('sender:target')();
  assert.equal(state.target, 'laptop');
  assert.equal(state.pendingTarget, 'pc');

  h.uIOhook.emit('keyup', { keycode: A });
  h.uIOhook.emit('keyup', { keycode: Alt });
  h.uIOhook.emit('keyup', { keycode: Ctrl });

  state = h.handlers.get('sender:target')();
  assert.equal(state.target, 'laptop');
  assert.equal(state.pendingTarget, 'pc');

  h.uIOhook.emit('keyup', { keycode: W });
  state = h.handlers.get('sender:target')();
  assert.equal(state.target, 'pc');
  assert.equal(state.pendingTarget, null);

  h.handlers.get('sender:disconnect')();
});

test('receiver accepts one sender, rejects a second, validates keycodes, and rotates pairing code', async () => {
  const h = makeHarness('linux');
  const start = h.handlers.get('receiver:start');
  const state = await start(null, { port: 39393 });
  assert.match(state.pairingCode, /^\d{6}$/);

  const server = h.servers[0];
  assert.equal(server.options.maxPayload, 8192);

  // Receiver peers only need EventEmitter/WebSocket-like methods; create one explicitly.
  const makePeer = () => {
    const peer = new EventEmitter();
    peer.sent = [];
    peer.send = (value) => peer.sent.push(JSON.parse(value));
    peer.close = () => {};
    peer.terminate = () => peer.emit('close');
    peer.ping = () => {};
    return peer;
  };

  const peer1 = makePeer();
  server.emit('connection', peer1, { socket: { remoteAddress: '192.168.1.10' } });
  peer1.emit('message', Buffer.from(JSON.stringify({ type: 'auth', code: state.pairingCode })));
  assert.equal(peer1.sent.at(-1).type, 'auth-ok');

  let pairedState = h.handlers.get('receiver:state')();
  assert.equal(pairedState.clientCount, 1);
  assert.equal(pairedState.pairingCode, null);

  const beforeInvalid = h.injected.length;
  peer1.emit('message', Buffer.from(JSON.stringify({ type: 'key', action: 'down', keycode: 999999 })));
  assert.equal(h.injected.length, beforeInvalid);

  peer1.emit('message', Buffer.from(JSON.stringify({ type: 'key', action: 'down', keycode: h.UiohookKey.A })));
  assert.deepEqual(h.injected.at(-1), { keycode: h.UiohookKey.A, action: 'down' });

  const peer2 = makePeer();
  server.emit('connection', peer2, { socket: { remoteAddress: '192.168.1.11' } });
  peer2.emit('message', Buffer.from(JSON.stringify({ type: 'auth', code: state.pairingCode })));
  assert.equal(peer2.sent.at(-1).type, 'auth-busy');

  peer1.emit('close');
  pairedState = h.handlers.get('receiver:state')();
  assert.equal(pairedState.clientCount, 0);
  assert.match(pairedState.pairingCode, /^\d{6}$/);
  assert.notEqual(pairedState.pairingCode, state.pairingCode);

  await h.handlers.get('receiver:stop')();
});


test('sender fails safe to the laptop when the WebSocket send buffer is congested', async () => {
  const h = makeHarness('win32');
  const socket = await authorizeSender(h);

  const state = await h.handlers.get('sender:set-sharing')(null, true);
  assert.equal(state.target, 'pc');

  socket.bufferedAmount = 128 * 1024;
  h.uIOhook.emit('keydown', {
    keycode: h.UiohookKey.W,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false
  });

  const recovered = h.handlers.get('sender:target')();
  assert.equal(recovered.target, 'laptop');
  assert.equal(recovered.exclusive, false);
  assert.equal(socket.terminateCalled, true);
});

test('packaged Windows build registers itself to start at user login', async () => {
  const h = makeHarness('win32', { packaged: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.loginSettings.length, 1);
  assert.equal(h.loginSettings[0].openAtLogin, true);
  assert.deepEqual(h.loginSettings[0].args, ['--autostart']);
});
