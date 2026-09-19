const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PORT,
  makePairingCode,
  parsePort,
  normalizeHost,
  makeWebSocketUrl,
  canCompleteSwitch
} = require('../src/core');

test('makePairingCode returns exactly six digits', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(makePairingCode(), /^\d{6}$/);
  }
});

test('parsePort accepts valid values and rejects invalid values', () => {
  assert.equal(parsePort(undefined), DEFAULT_PORT);
  assert.equal(parsePort('39393'), 39393);
  assert.equal(parsePort(1), 1);
  assert.equal(parsePort(65535), 65535);

  for (const value of [0, -1, 65536, '3.5', 'abc']) {
    assert.throws(() => parsePort(value), /Port must be an integer/);
  }
});

test('normalizeHost accepts hostnames/IPs but rejects URL-like input', () => {
  assert.equal(normalizeHost(' 192.168.1.10 '), '192.168.1.10');
  assert.equal(normalizeHost('linux-pc.local'), 'linux-pc.local');
  assert.throws(() => normalizeHost(''), /Enter the PC/);
  assert.throws(() => normalizeHost('ws://192.168.1.10'), /without a URL/);
  assert.throws(() => normalizeHost('linux-pc.local/path'), /without a URL/);
});

test('makeWebSocketUrl supports IPv4, hostnames, and IPv6', () => {
  assert.equal(makeWebSocketUrl('192.168.1.10', 39393), 'ws://192.168.1.10:39393');
  assert.equal(makeWebSocketUrl('linux-pc.local', 39393), 'ws://linux-pc.local:39393');
  assert.equal(makeWebSocketUrl('2001:db8::1', 39393), 'ws://[2001:db8::1]:39393');
});

test('switch cannot complete until every physically held key is released', () => {
  const held = new Set([1, 2, 3]);
  assert.equal(canCompleteSwitch(held), false);
  held.delete(1);
  held.delete(2);
  assert.equal(canCompleteSwitch(held), false);
  held.delete(3);
  assert.equal(canCompleteSwitch(held), true);
});
