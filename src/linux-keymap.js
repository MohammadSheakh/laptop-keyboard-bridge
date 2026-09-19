'use strict';

// libuiohook reports IBM PC set-1 style virtual keycodes. Most ordinary keys
// line up with Linux evdev codes, but extended/navigation/meta/F13+ keys do not.
// Keep this explicit so the Docker receiver never guesses a key mapping.
const IDENTITY_CODES = [
  0x0001, // Escape
  0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000A, 0x000B,
  0x000C, 0x000D, 0x000E, 0x000F,
  0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x0015, 0x0016, 0x0017, 0x0018, 0x0019,
  0x001A, 0x001B, 0x001C, 0x001D,
  0x001E, 0x001F, 0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027,
  0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F,
  0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039,
  0x003A,
  0x003B, 0x003C, 0x003D, 0x003E, 0x003F, 0x0040, 0x0041, 0x0042, 0x0043, 0x0044,
  0x0045, 0x0046, 0x0047, 0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E,
  0x004F, 0x0050, 0x0051, 0x0052, 0x0053,
  0x0057, 0x0058 // F11, F12
];

const UIOHOOK_TO_EVDEV = new Map(IDENTITY_CODES.map((code) => [code, code]));

const remaps = [
  // Navigation/edit keys.
  [0x0E47, 102], // Home
  [0xE048, 103], // ArrowUp
  [0x0E49, 104], // PageUp
  [0xE04B, 105], // ArrowLeft
  [0xE04D, 106], // ArrowRight
  [0x0E4F, 107], // End
  [0xE050, 108], // ArrowDown
  [0x0E51, 109], // PageDown
  [0x0E52, 110], // Insert
  [0x0E53, 111], // Delete

  // Extended keypad/modifier/meta keys.
  [0x0E1C, 96],  // NumpadEnter
  [0x0E1D, 97],  // CtrlRight
  [0x0E35, 98],  // NumpadDivide
  [0x0E37, 99],  // PrintScreen / SysRq
  [0x0E38, 100], // AltRight
  [0x0E5B, 125], // MetaLeft
  [0x0E5C, 126], // MetaRight

  // libuiohook distinguishes numpad navigation states with 0xEE prefixes.
  // Linux evdev exposes the underlying physical keypad key instead.
  [0xEE4F, 79], // NumpadEnd / KP1
  [0xEE50, 80], // NumpadArrowDown / KP2
  [0xEE51, 81], // NumpadPageDown / KP3
  [0xEE4B, 75], // NumpadArrowLeft / KP4
  [0xEE4D, 77], // NumpadArrowRight / KP6
  [0xEE47, 71], // NumpadHome / KP7
  [0xEE48, 72], // NumpadArrowUp / KP8
  [0xEE49, 73], // NumpadPageUp / KP9
  [0xEE52, 82], // NumpadInsert / KP0
  [0xEE53, 83], // NumpadDelete / KPDecimal

  // Linux assigns F13-F24 outside the original set-1 scan-code range.
  [0x005B, 183], // F13
  [0x005C, 184], // F14
  [0x005D, 185], // F15
  [0x0063, 186], // F16
  [0x0064, 187], // F17
  [0x0065, 188], // F18
  [0x0066, 189], // F19
  [0x0067, 190], // F20
  [0x0068, 191], // F21
  [0x0069, 192], // F22
  [0x006A, 193], // F23
  [0x006B, 194]  // F24
];

for (const [uiohookCode, evdevCode] of remaps) {
  UIOHOOK_TO_EVDEV.set(uiohookCode, evdevCode);
}

function mapUiohookToEvdev(keycode) {
  if (!Number.isInteger(keycode)) return null;
  return UIOHOOK_TO_EVDEV.get(keycode) ?? null;
}

function isSupportedUiohookKeycode(keycode) {
  return mapUiohookToEvdev(keycode) !== null;
}

module.exports = {
  UIOHOOK_TO_EVDEV,
  mapUiohookToEvdev,
  isSupportedUiohookKeycode
};
