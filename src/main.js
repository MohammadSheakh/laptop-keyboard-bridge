const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const { WebSocket, WebSocketServer } = require('ws');
const {
  DEFAULT_PORT,
  makePairingCode,
  parsePort,
  makeWebSocketUrl,
  canCompleteSwitch
} = require('./core');

const SWITCH_SHORTCUT = 'Ctrl + Alt + A';
const EMERGENCY_SHORTCUT = 'Ctrl + Alt + Esc';
const MAX_WS_PAYLOAD = 8 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024;
const HEARTBEAT_MS = 3000;
const runtimePlatform = process.platform;
const AUTO_START_ARG = '--autostart';
const launchedFromAutoStart = process.argv.includes(AUTO_START_ARG);

let uIOhook = null;
let UiohookKey = {};
let nativeInputError = null;

try {
  ({ uIOhook, UiohookKey } = require('@fainthit/uiohook-napi-suppress'));
} catch (error) {
  nativeInputError = error;
}

const validKeycodes = new Set(
  Object.values(UiohookKey).filter((value) => Number.isInteger(value))
);

let mainWindow = null;
let receiverServer = null;
let receiverCode = null;
let receiverPort = DEFAULT_PORT;
let receiverClients = new Set();
let receiverHeartbeatTimer = null;

let senderSocket = null;
let senderAuthorized = false;
let senderHeartbeatTimer = null;
let senderAlive = false;
let senderHookRunning = false;
let senderTarget = 'laptop';
let senderPendingTarget = null;
let senderPendingReason = null;
let senderHeldKeys = new Set();
let exclusiveSuppressId = null;
let switchShortcutSuppressId = null;
let exclusiveSuppressionEnabled = false;

function assertNativeInputAvailable() {
  if (!uIOhook) {
    const detail = nativeInputError?.message ? ` ${nativeInputError.message}` : '';
    throw new Error(`Native keyboard support failed to load.${detail}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 760,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (launchedFromAutoStart) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.minimize === 'function') {
        mainWindow.minimize();
      }
    }, 500).unref?.();
  }
}

function configureWindowsLoginStartup() {
  if (runtimePlatform !== 'win32' || !app.isPackaged) return;
  if (process.env.KEYBRIDGE_DISABLE_AUTOSTART === '1') return;
  if (typeof app.setLoginItemSettings !== 'function') return;

  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      args: [AUTO_START_ARG]
    });
  } catch (error) {
    console.warn(`Could not enable Windows login startup: ${error.message}`);
  }
}

function notify(channel, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getLanIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }

  return [...new Set(addresses)];
}

function getPlatformInfo() {
  return {
    platform: runtimePlatform,
    arch: process.arch,
    release: os.release(),
    linuxSession: runtimePlatform === 'linux'
      ? String(process.env.XDG_SESSION_TYPE || 'unknown').toLowerCase()
      : null,
    switchShortcut: SWITCH_SHORTCUT,
    emergencyShortcut: EMERGENCY_SHORTCUT,
    launchedFromAutoStart,
    nativeInputAvailable: Boolean(uIOhook),
    nativeInputError: nativeInputError?.message || null
  };
}

function safeParse(message) {
  try {
    return JSON.parse(message.toString());
  } catch {
    return null;
  }
}

function releasePressedKeys(client) {
  if (!client?.pressedKeys || !uIOhook) return;

  for (const keycode of client.pressedKeys) {
    try {
      uIOhook.keyToggle(keycode, 'up');
    } catch {
      // Best-effort cleanup only.
    }
  }

  client.pressedKeys.clear();
}

function authorizedReceiverClient() {
  return [...receiverClients].find((client) => client.authorized) || null;
}

function stopReceiverHeartbeat() {
  if (receiverHeartbeatTimer) {
    clearInterval(receiverHeartbeatTimer);
    receiverHeartbeatTimer = null;
  }
}

function startReceiverHeartbeat() {
  stopReceiverHeartbeat();
  receiverHeartbeatTimer = setInterval(() => {
    for (const client of receiverClients) {
      if (!client.alive) {
        releasePressedKeys(client);
        try { client.ws.terminate(); } catch {}
        continue;
      }

      client.alive = false;
      try { client.ws.ping(); } catch {
        try { client.ws.terminate(); } catch {}
      }
    }
  }, HEARTBEAT_MS);
  receiverHeartbeatTimer.unref?.();
}

async function startReceiver(port = DEFAULT_PORT) {
  assertNativeInputAvailable();
  if (receiverServer) return getReceiverState();

  receiverPort = parsePort(port);
  receiverCode = makePairingCode();

  try {
    await new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '0.0.0.0',
        port: receiverPort,
        maxPayload: MAX_WS_PAYLOAD,
        perMessageDeflate: false
      });

      const onStartupError = (error) => {
        try { server.close(); } catch {}
        reject(error);
      };

      server.once('error', onStartupError);
      server.once('listening', () => {
        server.off('error', onStartupError);
        receiverServer = server;
        resolve();
      });

      server.on('connection', (ws, request) => {
        const client = {
          ws,
          authorized: false,
          pressedKeys: new Set(),
          address: request.socket.remoteAddress || 'unknown',
          alive: true
        };

        receiverClients.add(client);

        ws.on('pong', () => {
          client.alive = true;
        });

        ws.on('message', (raw) => {
          client.alive = true;
          const msg = safeParse(raw);
          if (!msg || typeof msg !== 'object') return;

          if (!client.authorized) {
            if (msg.type !== 'auth') {
              ws.close(4001, 'Authenticate first');
              return;
            }

            if (authorizedReceiverClient()) {
              ws.send(JSON.stringify({ type: 'auth-busy' }));
              ws.close(4003, 'Receiver already paired');
              return;
            }

            if (receiverCode && String(msg.code) === receiverCode) {
              client.authorized = true;
              receiverCode = null;
              ws.send(JSON.stringify({ type: 'auth-ok', platform: runtimePlatform }));
              notify('receiver:state', getReceiverState());
              notify('receiver:client-status', {
                connected: true,
                address: client.address,
                clientCount: 1
              });
            } else {
              ws.send(JSON.stringify({ type: 'auth-failed' }));
              ws.close(4001, 'Invalid pairing code');
            }
            return;
          }

          if (msg.type === 'key') {
            if (!Number.isInteger(msg.keycode) || !validKeycodes.has(msg.keycode)) return;
            if (msg.action !== 'down' && msg.action !== 'up') return;

            try {
              uIOhook.keyToggle(msg.keycode, msg.action);
              if (msg.action === 'down') client.pressedKeys.add(msg.keycode);
              else client.pressedKeys.delete(msg.keycode);
            } catch (error) {
              notify('receiver:error', { message: error.message });
            }
          } else if (msg.type === 'release-all') {
            releasePressedKeys(client);
          }
        });

        ws.on('close', () => {
          const wasAuthorized = client.authorized;
          releasePressedKeys(client);
          receiverClients.delete(client);

          if (wasAuthorized && receiverServer && !authorizedReceiverClient()) {
            receiverCode = makePairingCode();
            notify('receiver:state', getReceiverState());
          }

          notify('receiver:client-status', {
            connected: Boolean(authorizedReceiverClient()),
            clientCount: authorizedReceiverClient() ? 1 : 0
          });
        });

        ws.on('error', () => releasePressedKeys(client));
      });
    });
  } catch (error) {
    receiverServer = null;
    receiverCode = null;
    throw error;
  }

  startReceiverHeartbeat();

  if (runtimePlatform === 'linux' && String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') {
    notify('receiver:warning', {
      message: 'Wayland detected. This build uses libuiohook/XTest-style injection and is intended for X11. Native Wayland apps may reject injected keys.'
    });
  }

  notify('receiver:state', getReceiverState());
  return getReceiverState();
}

async function stopReceiver() {
  stopReceiverHeartbeat();

  for (const client of receiverClients) {
    releasePressedKeys(client);
    try { client.ws.terminate(); } catch {}
  }
  receiverClients.clear();

  const server = receiverServer;
  receiverServer = null;
  receiverCode = null;

  if (server) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  notify('receiver:state', getReceiverState());
  return getReceiverState();
}

function getReceiverState() {
  const authorized = authorizedReceiverClient();
  return {
    running: Boolean(receiverServer),
    port: receiverPort,
    pairingCode: receiverCode,
    addresses: getLanIPv4Addresses(),
    clientCount: authorized ? 1 : 0,
    platformInfo: getPlatformInfo()
  };
}


function stopSenderHeartbeat() {
  if (senderHeartbeatTimer) {
    clearInterval(senderHeartbeatTimer);
    senderHeartbeatTimer = null;
  }
  senderAlive = false;
}

function recoverSenderLocally(reason = 'network-recovery') {
  senderPendingTarget = null;
  senderPendingReason = null;
  senderHeldKeys.clear();
  senderTarget = 'laptop';
  try { setExclusiveSuppression(false); } catch {}
  return notifySenderTarget(reason);
}

function startSenderHeartbeat(ws) {
  stopSenderHeartbeat();
  senderAlive = true;

  ws.on('pong', () => {
    if (senderSocket === ws) senderAlive = true;
  });

  senderHeartbeatTimer = setInterval(() => {
    if (senderSocket !== ws || ws.readyState !== WebSocket.OPEN || !senderAuthorized) {
      stopSenderHeartbeat();
      return;
    }

    if (!senderAlive) {
      recoverSenderLocally('heartbeat-timeout');
      try { ws.terminate(); } catch {}
      stopSenderHeartbeat();
      return;
    }

    senderAlive = false;
    try { ws.ping(); } catch {
      recoverSenderLocally('heartbeat-error');
      try { ws.terminate(); } catch {}
      stopSenderHeartbeat();
    }
  }, HEARTBEAT_MS);
  senderHeartbeatTimer.unref?.();
}

function senderSend(payload) {
  if (!senderSocket || senderSocket.readyState !== WebSocket.OPEN || !senderAuthorized) {
    if (senderTarget === 'pc') recoverSenderLocally('connection-unavailable');
    return false;
  }

  if (senderSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
    notify('sender:error', { message: 'Connection is congested. Keyboard control returned to the laptop.' });
    const socket = senderSocket;
    recoverSenderLocally('connection-congested');
    try { socket.terminate(); } catch {}
    return false;
  }

  try {
    senderSocket.send(JSON.stringify(payload));
    return true;
  } catch {
    const socket = senderSocket;
    recoverSenderLocally('send-error');
    try { socket?.terminate(); } catch {}
    return false;
  }
}

function uniqueUiohookKeycodes() {
  return [...validKeycodes];
}

function installWindowsSuppression() {
  assertNativeInputAvailable();
  if (runtimePlatform !== 'win32') return;
  if (exclusiveSuppressId !== null && switchShortcutSuppressId !== null) return;
  if (typeof uIOhook.registerSuppress !== 'function' || typeof uIOhook.toggleSuppress !== 'function') {
    throw new Error('This build does not support exclusive Windows keyboard suppression.');
  }

  const allKeys = uniqueUiohookKeycodes().map((keycode) => ({ keycode }));
  const exclusiveRules = [
    ...allKeys,
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true }
  ];

  exclusiveSuppressId = uIOhook.registerSuppress(exclusiveRules);
  uIOhook.toggleSuppress(exclusiveSuppressId, false);

  switchShortcutSuppressId = uIOhook.registerSuppress([
    { keycode: UiohookKey.A, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
  ]);
  uIOhook.toggleSuppress(switchShortcutSuppressId, true);
}

function removeWindowsSuppression() {
  if (runtimePlatform !== 'win32' || !uIOhook) return;

  try {
    if (exclusiveSuppressId !== null) uIOhook.unregisterSuppress(exclusiveSuppressId);
  } catch {}
  try {
    if (switchShortcutSuppressId !== null) uIOhook.unregisterSuppress(switchShortcutSuppressId);
  } catch {}

  exclusiveSuppressId = null;
  switchShortcutSuppressId = null;
  exclusiveSuppressionEnabled = false;
}

function setExclusiveSuppression(enabled) {
  if (!enabled && exclusiveSuppressId === null) {
    exclusiveSuppressionEnabled = false;
    return;
  }

  if (runtimePlatform !== 'win32') {
    if (enabled) throw new Error('Exclusive keyboard switching is currently implemented for a Windows sender.');
    return;
  }

  installWindowsSuppression();
  uIOhook.toggleSuppress(exclusiveSuppressId, Boolean(enabled));
  exclusiveSuppressionEnabled = Boolean(enabled);
}

function senderTargetState(reason = 'state') {
  return {
    enabled: senderTarget === 'pc',
    target: senderTarget,
    pendingTarget: senderPendingTarget,
    exclusive: exclusiveSuppressionEnabled,
    reason,
    switchShortcut: SWITCH_SHORTCUT
  };
}

function notifySenderTarget(reason = 'state') {
  const state = senderTargetState(reason);
  notify('sender:target-status', state);
  notify('sender:sharing-status', { enabled: state.enabled, target: state.target });
  return state;
}

function finalizePendingSwitch() {
  if (!senderPendingTarget || !canCompleteSwitch(senderHeldKeys)) return senderTargetState('waiting-for-keys');

  const nextTarget = senderPendingTarget;
  const reason = senderPendingReason || 'switch';
  senderPendingTarget = null;
  senderPendingReason = null;

  try {
    if (nextTarget === 'pc') {
      setExclusiveSuppression(true);
      senderTarget = 'pc';
    } else {
      setExclusiveSuppression(false);
      senderTarget = 'laptop';
    }
    return notifySenderTarget(reason);
  } catch (error) {
    senderTarget = 'laptop';
    senderPendingTarget = null;
    senderPendingReason = null;
    try { setExclusiveSuppression(false); } catch {}
    notify('sender:error', { message: error.message });
    return notifySenderTarget('error');
  }
}

function requestSenderTarget(target, reason = 'button') {
  if (target !== 'laptop' && target !== 'pc') throw new Error('Unknown keyboard target.');
  if (target === 'pc' && !senderAuthorized) throw new Error('Connect and pair with the receiver first.');

  if (target === senderTarget && !senderPendingTarget) {
    return senderTargetState(reason);
  }

  if (target === 'laptop' && senderTarget === 'pc') {
    senderSend({ type: 'release-all' });
  }

  senderPendingTarget = target;
  senderPendingReason = reason;
  notifySenderTarget('switch-pending');
  return finalizePendingSwitch();
}

function requestHotkeySwitch() {
  if (!senderAuthorized || senderPendingTarget) return;
  const target = senderTarget === 'laptop' ? 'pc' : 'laptop';
  requestSenderTarget(target, 'hotkey');
}

function isSwitchShortcut(event) {
  return event.keycode === UiohookKey.A && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}

function isEmergencyShortcut(event) {
  return event.keycode === UiohookKey.Escape && event.ctrlKey && event.altKey;
}

function handleKeyDown(event) {
  senderHeldKeys.add(event.keycode);

  if (isEmergencyShortcut(event) && senderTarget === 'pc') {
    notify('sender:emergency-stop', {});
    requestSenderTarget('laptop', 'emergency');
    return;
  }

  if (isSwitchShortcut(event)) {
    requestHotkeySwitch();
    return;
  }

  if (senderPendingTarget) return;
  if (senderTarget === 'pc') senderSend({ type: 'key', action: 'down', keycode: event.keycode });
}

function handleKeyUp(event) {
  senderHeldKeys.delete(event.keycode);

  if (senderPendingTarget) {
    finalizePendingSwitch();
    return;
  }

  if (senderTarget === 'pc') senderSend({ type: 'key', action: 'up', keycode: event.keycode });
}

if (uIOhook) {
  uIOhook.on('keydown', handleKeyDown);
  uIOhook.on('keyup', handleKeyUp);
}

function startSenderHook() {
  assertNativeInputAvailable();
  if (!senderAuthorized) throw new Error('Connect and pair with the receiver first.');

  if (runtimePlatform === 'win32') installWindowsSuppression();

  if (!senderHookRunning) {
    uIOhook.start();
    senderHookRunning = true;
  }

  senderTarget = 'laptop';
  senderPendingTarget = null;
  senderPendingReason = null;
  senderHeldKeys.clear();
  setExclusiveSuppression(false);
  notifySenderTarget('connected');
}

function stopSenderHook({ releaseRemote = true } = {}) {
  if (releaseRemote) senderSend({ type: 'release-all' });

  senderPendingTarget = null;
  senderPendingReason = null;
  senderHeldKeys.clear();
  senderTarget = 'laptop';

  try { setExclusiveSuppression(false); } catch {}

  if (senderHookRunning && uIOhook) {
    try { uIOhook.stop(); } catch {}
    senderHookRunning = false;
  }

  removeWindowsSuppression();
  notifySenderTarget('stopped');
}

function disconnectSender() {
  stopSenderHeartbeat();
  stopSenderHook({ releaseRemote: true });
  senderAuthorized = false;

  const socket = senderSocket;
  senderSocket = null;
  if (socket) {
    try { socket.close(1000, 'Disconnected by user'); } catch {}
  }

  notify('sender:connection-status', { connected: false });
  return { connected: false };
}

async function connectSender({ host, port, code }) {
  assertNativeInputAvailable();
  disconnectSender();

  const targetPort = parsePort(port);
  const targetCode = String(code || '').trim();
  const url = makeWebSocketUrl(host, targetPort);

  if (!/^\d{6}$/.test(targetCode)) throw new Error('Pairing code must be 6 digits.');

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD });
    senderSocket = ws;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (senderSocket === ws) senderSocket = null;
        try { ws.terminate(); } catch {}
        reject(new Error('Connection timed out. Check IP, port, and firewall.'));
      }
    }, 6000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', code: targetCode })));

    ws.on('message', (raw) => {
      if (senderSocket !== ws) return;
      const msg = safeParse(raw);
      if (!msg) return;

      if (msg.type === 'auth-ok') {
        clearTimeout(timeout);
        senderAuthorized = true;
        try {
          startSenderHook();
        } catch (error) {
          senderAuthorized = false;
          senderSocket = null;
          try { ws.terminate(); } catch {}
          if (!settled) {
            settled = true;
            reject(error);
          }
          return;
        }

        if (!settled) {
          settled = true;
          const result = {
            connected: true,
            host: String(host || '').trim(),
            port: targetPort,
            receiverPlatform: msg.platform || 'unknown'
          };
          startSenderHeartbeat(ws);
          notify('sender:connection-status', result);
          resolve(result);
        }
      } else if (msg.type === 'auth-failed') {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('Pairing code was rejected.'));
        }
      } else if (msg.type === 'auth-busy') {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('The receiver is already paired with another sender.'));
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (senderSocket !== ws) return;

      senderSocket = null;
      senderAuthorized = false;
      stopSenderHeartbeat();
      stopSenderHook({ releaseRemote: false });
      notify('sender:connection-status', { connected: false });

      if (!settled) {
        settled = true;
        reject(new Error('Connection closed before pairing completed.'));
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      if (senderSocket !== ws) return;
      if (!settled) {
        settled = true;
        reject(new Error(`Could not connect: ${error.message}`));
      }
    });
  });
}

ipcMain.handle('network:info', () => ({ addresses: getLanIPv4Addresses(), defaultPort: DEFAULT_PORT }));
ipcMain.handle('platform:info', () => getPlatformInfo());
ipcMain.handle('receiver:start', (_event, args) => startReceiver(args?.port));
ipcMain.handle('receiver:stop', () => stopReceiver());
ipcMain.handle('receiver:state', () => getReceiverState());
ipcMain.handle('sender:connect', (_event, args) => connectSender(args || {}));
ipcMain.handle('sender:disconnect', () => disconnectSender());
ipcMain.handle('sender:set-sharing', (_event, enabled) => requestSenderTarget(enabled ? 'pc' : 'laptop', 'button'));
ipcMain.handle('sender:target', () => senderTargetState());

app.whenReady().then(() => {
  configureWindowsLoginStartup();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  disconnectSender();
  void stopReceiver();
});

app.on('window-all-closed', () => {
  if (runtimePlatform !== 'darwin') app.quit();
});
