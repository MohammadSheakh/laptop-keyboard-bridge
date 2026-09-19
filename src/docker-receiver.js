'use strict';

const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { DEFAULT_PORT, makePairingCode, parsePort } = require('./core');
const { mapUiohookToEvdev } = require('./linux-keymap');

const MAX_WS_PAYLOAD = 8 * 1024;
const HEARTBEAT_MS = 3000;
const MAX_HELPER_BUFFER = 64 * 1024;
const HELPER_PATH = process.env.KEYBRIDGE_UINPUT_HELPER || '/usr/local/bin/keybridge-uinput-helper';
const BIND_HOST = process.env.KEYBRIDGE_BIND || '0.0.0.0';
const PORT = parsePort(process.env.KEYBRIDGE_PORT, DEFAULT_PORT);
const CONFIGURED_CODE = String(process.env.KEYBRIDGE_PAIRING_CODE || '').trim();

if (CONFIGURED_CODE && !/^\d{6}$/.test(CONFIGURED_CODE)) {
  throw new Error('KEYBRIDGE_PAIRING_CODE must be exactly 6 digits.');
}

let pairingCode = CONFIGURED_CODE || makePairingCode();
let activeClient = null;
let heartbeatTimer = null;
let shuttingDown = false;

class UinputInjector {
  constructor(helperPath) {
    this.helperPath = helperPath;
    this.child = null;
    this.ready = false;
    this.pending = [];
  }

  async start() {
    if (this.child) return;

    this.child = spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[uinput] ${chunk}`);
    });

    this.child.on('exit', (code, signal) => {
      this.ready = false;
      this.child = null;
      if (!shuttingDown) {
        console.error(`[keybridge] uinput helper exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    });

    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for uinput helper.')), 5000);

      const onData = (chunk) => {
        output += chunk.toString();
        if (output.includes('KEYBRIDGE_READY')) {
          clearTimeout(timeout);
          this.child.stdout.off('data', onData);
          this.ready = true;
          resolve();
        }
      };

      this.child.stdout.on('data', onData);
      this.child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once('exit', (code) => {
        if (!this.ready) {
          clearTimeout(timeout);
          reject(new Error(`uinput helper exited before ready (code=${code}).`));
        }
      });
    });
  }

  keyToggle(uiohookCode, action) {
    if (!this.ready || !this.child?.stdin?.writable) {
      throw new Error('uinput helper is not ready.');
    }

    const evdevCode = mapUiohookToEvdev(uiohookCode);
    if (evdevCode === null) return false;

    const value = action === 'down' ? 1 : action === 'up' ? 0 : null;
    if (value === null) return false;

    if (this.child.stdin.writableLength > MAX_HELPER_BUFFER) {
      throw new Error('uinput helper input buffer is congested.');
    }

    // A false return value only means Node crossed the stream high-water mark;
    // the chunk itself is still queued. Do not treat that already-queued key
    // event as a failed write or it could become impossible to release safely.
    this.child.stdin.write(`${evdevCode} ${value}\n`);
    return true;
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill('SIGTERM'); } catch {}
    this.child = null;
    this.ready = false;
  }
}

const injector = new UinputInjector(HELPER_PATH);

function safeParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function resetPairingCode() {
  pairingCode = CONFIGURED_CODE || makePairingCode();
  console.log(`[keybridge] pairing code: ${pairingCode}`);
}

function releasePressedKeys(client) {
  if (!client?.pressedKeys) return;
  for (const keycode of client.pressedKeys) {
    try { injector.keyToggle(keycode, 'up'); } catch (error) {
      console.error(`[keybridge] failed to release key ${keycode}: ${error.message}`);
    }
  }
  client.pressedKeys.clear();
}

function disconnectClient(client, code = 1000, reason = 'Disconnected') {
  if (!client) return;
  releasePressedKeys(client);
  try { client.ws.close(code, reason); } catch {}
}

async function main() {
  await injector.start();

  const server = new WebSocketServer({
    host: BIND_HOST,
    port: PORT,
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: false
  });

  server.on('connection', (ws, request) => {
    const client = {
      ws,
      authorized: false,
      pressedKeys: new Set(),
      alive: true,
      address: request.socket.remoteAddress || 'unknown'
    };

    ws.on('pong', () => { client.alive = true; });

    ws.on('message', (raw) => {
      client.alive = true;
      const msg = safeParse(raw);
      if (!msg || typeof msg !== 'object') return;

      if (!client.authorized) {
        if (msg.type !== 'auth') {
          ws.close(4001, 'Authenticate first');
          return;
        }

        if (activeClient) {
          ws.send(JSON.stringify({ type: 'auth-busy' }));
          ws.close(4003, 'Receiver already paired');
          return;
        }

        if (pairingCode && String(msg.code) === pairingCode) {
          client.authorized = true;
          activeClient = client;
          pairingCode = null;
          ws.send(JSON.stringify({ type: 'auth-ok', platform: 'linux' }));
          console.log(`[keybridge] paired sender ${client.address}`);
        } else {
          ws.send(JSON.stringify({ type: 'auth-failed' }));
          ws.close(4001, 'Invalid pairing code');
        }
        return;
      }

      if (msg.type === 'key') {
        if (!Number.isInteger(msg.keycode)) return;
        if (msg.action !== 'down' && msg.action !== 'up') return;

        try {
          if (!injector.keyToggle(msg.keycode, msg.action)) return;
          if (msg.action === 'down') client.pressedKeys.add(msg.keycode);
          else client.pressedKeys.delete(msg.keycode);
        } catch (error) {
          console.error(`[keybridge] input injection failed: ${error.message}`);
          disconnectClient(client, 1011, 'Input injection failed');
        }
      } else if (msg.type === 'release-all') {
        releasePressedKeys(client);
      }
    });

    ws.on('close', () => {
      releasePressedKeys(client);
      if (activeClient === client) {
        activeClient = null;
        resetPairingCode();
      }
    });

    ws.on('error', (error) => {
      console.error(`[keybridge] websocket error from ${client.address}: ${error.message}`);
      releasePressedKeys(client);
    });
  });

  server.on('error', (error) => {
    console.error(`[keybridge] receiver server error: ${error.message}`);
    process.exitCode = 1;
  });

  heartbeatTimer = setInterval(() => {
    if (!activeClient) return;
    if (!activeClient.alive) {
      console.warn('[keybridge] sender heartbeat timed out; releasing keys');
      releasePressedKeys(activeClient);
      try { activeClient.ws.terminate(); } catch {}
      return;
    }
    activeClient.alive = false;
    try { activeClient.ws.ping(); } catch {
      try { activeClient.ws.terminate(); } catch {}
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  console.log(`[keybridge] Docker receiver listening on ${BIND_HOST}:${PORT}`);
  console.log(`[keybridge] pairing code: ${pairingCode}`);
  console.log('[keybridge] input backend: Linux /dev/uinput');
  console.log('[keybridge] transport is unencrypted; use only on a trusted private LAN');

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[keybridge] shutting down');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    disconnectClient(activeClient, 1001, 'Receiver shutting down');
    activeClient = null;
    server.close(() => {
      injector.stop();
      process.exit(0);
    });
    setTimeout(() => {
      injector.stop();
      process.exit(0);
    }, 1500).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(`[keybridge] fatal: ${error.stack || error.message}`);
  injector.stop();
  process.exit(1);
});
