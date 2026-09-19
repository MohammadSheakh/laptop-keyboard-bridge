const test = require('node:test');
const assert = require('node:assert/strict');
const { mapUiohookToEvdev } = require('../src/linux-keymap');

test('ordinary set-1 keys map directly to Linux evdev codes', () => {
  assert.equal(mapUiohookToEvdev(0x001E), 30); // A
  assert.equal(mapUiohookToEvdev(0x0011), 17); // W
  assert.equal(mapUiohookToEvdev(0x0038), 56); // Left Alt
});

test('extended navigation and modifier keys are remapped correctly', () => {
  assert.equal(mapUiohookToEvdev(0xE048), 103); // ArrowUp
  assert.equal(mapUiohookToEvdev(0x0E1D), 97); // Right Ctrl
  assert.equal(mapUiohookToEvdev(0x0E38), 100); // Right Alt
  assert.equal(mapUiohookToEvdev(0x0E5B), 125); // Left Meta
});

test('F13-F24 use Linux evdev function-key codes, not libuiohook scan codes', () => {
  assert.equal(mapUiohookToEvdev(0x005B), 183); // F13
  assert.equal(mapUiohookToEvdev(0x0063), 186); // F16
  assert.equal(mapUiohookToEvdev(0x006B), 194); // F24
});

test('numpad navigation aliases map to physical keypad keys', () => {
  assert.equal(mapUiohookToEvdev(0xEE4F), 79); // KP1
  assert.equal(mapUiohookToEvdev(0xEE52), 82); // KP0
});

test('unknown or malformed keycodes are rejected', () => {
  assert.equal(mapUiohookToEvdev(999999), null);
  assert.equal(mapUiohookToEvdev('30'), null);
});
