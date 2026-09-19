const crypto = require('crypto');
const net = require('net');

const DEFAULT_PORT = 39393;

function makePairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === '') return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535.');
  }

  return port;
}

function normalizeHost(value) {
  const host = String(value || '').trim();
  if (!host) throw new Error('Enter the PC IP address or hostname.');
  if (host.includes('://') || /[/?#]/.test(host)) {
    throw new Error('Enter only the PC IP address or hostname, without a URL or path.');
  }
  return host;
}

function makeWebSocketUrl(hostValue, portValue) {
  const host = normalizeHost(hostValue);
  const port = parsePort(portValue);
  const formattedHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `ws://${formattedHost}:${port}`;
}

function canCompleteSwitch(heldKeys) {
  return heldKeys.size === 0;
}

module.exports = {
  DEFAULT_PORT,
  makePairingCode,
  parsePort,
  normalizeHost,
  makeWebSocketUrl,
  canCompleteSwitch
};
