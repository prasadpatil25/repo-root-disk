// What a keypress sends to a terminal.
//
// A terminal is not a form field. It does not collect a line and submit it: it
// sends the bytes a key produces, the moment the key is pressed, and displays
// whatever comes back. Everything that looks like editing happens on the far
// side.
//
// That division is worth stating because it decides what this file must not do.
//
// The kernel's line discipline sits between the terminal and the program. In
// canonical mode it buffers input by line, implements backspace, word-erase and
// line-kill itself, and hands the program a whole line only when Enter arrives.
// It also echoes: the characters appearing as you type are sent back by the tty,
// not drawn by the terminal. A terminal that echoed locally as well would show
// every character twice, and would show them even when the far side had switched
// echo off to read a password.
//
// Programs that need every keystroke, a shell with line editing or a full-screen
// editor, put the tty in raw mode: no buffering, no echo, no interpretation. The
// terminal cannot tell which mode is in force and does not need to. It sends the
// same bytes either way.
//
// Multiline needs no support here at all. A shell reading `for i in 1 2 3; do`
// sees an incomplete command, prints its secondary prompt, and keeps reading.
// An unclosed quote or a trailing backslash does the same. All of that is the
// shell's parser; the terminal only carries bytes.

const ESC = 0x1b;

/** Keys whose byte sequence is fixed. */
const SIMPLE = {
  // Terminals send carriage return for Enter, not line feed. The tty's ICRNL
  // flag turns it into a newline for the program, which is why a raw-mode
  // program still sees Enter correctly.
  Enter: [0x0d],
  Tab: [0x09],
  Escape: [ESC],
  // Backspace sends DEL on essentially every modern terminal; the tty's erase
  // character is set to match. Sending 0x08 instead reaches programs that treat
  // it as "move left" and does not erase.
  Backspace: [0x7f]
};

/** Keys that send an escape sequence. */
const CSI = {
  ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D",
  Home: "H", End: "F"
};

/** Keys that send a numbered escape sequence. */
const TILDE = {
  Insert: "2", Delete: "3", PageUp: "5", PageDown: "6"
};

const FUNCTION = {
  // F1 to F4 are the older two-character form; F5 upward are numbered.
  F1: [ESC, 0x4f, 0x50], F2: [ESC, 0x4f, 0x51],
  F3: [ESC, 0x4f, 0x52], F4: [ESC, 0x4f, 0x53],
  F5: null, F6: null, F7: null, F8: null,
  F9: null, F10: null, F11: null, F12: null
};
const FUNCTION_NUMBERS = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };

/**
 * The bytes a key event sends, or null when the terminal should ignore it.
 *
 * Returning null rather than an empty array matters: the caller uses it to
 * decide whether to prevent the browser's own handling. A key we do not send
 * should keep working as a browser shortcut.
 *
 * @param {Object} event a KeyboardEvent, or anything with the same fields
 * @returns {number[]|null}
 */
export function keyToBytes(event) {
  const { key, ctrlKey, altKey, metaKey } = event;

  // Leave the browser's own shortcuts alone. Copy and paste in particular must
  // not be swallowed: a terminal that eats ctrl-c has no way to copy text, which
  // is why real ones bind copy to ctrl-shift-c.
  if (metaKey) return null;

  if (ctrlKey && !altKey) {
    // Control characters are the letter with the top three bits cleared, which
    // is what makes ctrl-c 0x03 and ctrl-d 0x04.
    if (key.length === 1) {
      const upper = key.toUpperCase();
      const code = upper.charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) return [code & 0x1f];
      // ctrl-space sends NUL, which programs read as a null byte.
      if (key === " ") return [0x00];
    }
    if (key === "[") return [ESC];
    return null;
  }

  if (altKey) {
    // Alt sends the key prefixed by escape, which is how meta has always been
    // carried over a byte stream.
    const inner = keyToBytes({ ...event, altKey: false });
    return inner ? [ESC, ...inner] : null;
  }

  if (SIMPLE[key]) return [...SIMPLE[key]];
  if (CSI[key]) return [ESC, 0x5b, CSI[key].charCodeAt(0)];
  if (TILDE[key]) return [ESC, 0x5b, TILDE[key].charCodeAt(0), 0x7e];
  if (key in FUNCTION) {
    if (FUNCTION[key]) return [...FUNCTION[key]];
    const n = String(FUNCTION_NUMBERS[key]);
    return [ESC, 0x5b, ...[...n].map((c) => c.charCodeAt(0)), 0x7e];
  }

  // A single printable character, which for anything outside ASCII is several
  // bytes. Keys like "Shift" and "CapsLock" arrive with multi-character names
  // and are not text.
  if ([...key].length === 1) return [...new TextEncoder().encode(key)];

  return null;
}

/**
 * Bytes for pasted or typed text.
 *
 * Newlines become carriage returns, because that is what pressing Enter sends
 * and a paste should be indistinguishable from typing. Pasting a multi-line
 * script therefore runs each line, exactly as it would if typed, and a shell
 * reading an unfinished construct keeps reading with its secondary prompt.
 */
export function textToBytes(text) {
  return [...new TextEncoder().encode(text.replace(/\r\n|\n/g, "\r"))];
}

/**
 * Whether a paste needs confirming.
 *
 * Pasted text is executed as it arrives, so a paste carrying a newline runs
 * whatever preceded it without the user pressing anything. That is a well known
 * way to get someone to run a command they did not read, and terminals that care
 * about it warn before a multi-line paste rather than after.
 */
export function pasteNeedsConfirming(text) {
  return /\r|\n/.test(text.trim());
}
