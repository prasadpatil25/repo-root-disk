// Tests for what a keypress sends to a terminal.
//
// The values here are not arbitrary: they are what a real terminal emits, and a
// guest shell will not behave correctly if they are close but wrong. Backspace
// sending 0x08 instead of 0x7f moves the cursor without erasing; Enter sending
// a line feed instead of a carriage return misbehaves under raw mode.
//
// Run with: node src/test-keyboard.mjs

import { keyToBytes, textToBytes, pasteNeedsConfirming } from "./ui/keyboard.js";

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name); console.log("  FAIL  " + name + (detail ? "   [" + detail + "]" : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...mods });

// ------------------------------------------------------------------ printable

console.log("\nordinary typing");
{
  eq("a letter is its own byte", keyToBytes(key("a")), [0x61]);
  eq("so is a digit", keyToBytes(key("7")), [0x37]);
  eq("and a space", keyToBytes(key(" ")), [0x20]);
  eq("a character outside ASCII is several bytes",
     keyToBytes(key("é")), [0xc3, 0xa9]);
  eq("an emoji is four", keyToBytes(key("😀")), [0xf0, 0x9f, 0x98, 0x80]);
}
{
  // Modifier keys arrive as key events too and are not text.
  for (const name of ["Shift", "Control", "Alt", "CapsLock", "Meta"]) {
    check(`${name} sends nothing`, keyToBytes(key(name)) === null);
  }
}

// -------------------------------------------------------------------- editing

console.log("\nthe keys the line discipline acts on");
{
  // Terminals send carriage return; the tty turns it into a newline for the
  // program. Sending a line feed instead misbehaves the moment a program takes
  // the tty out of canonical mode.
  eq("Enter sends a carriage return, not a line feed", keyToBytes(key("Enter")), [0x0d]);
  // DEL, not backspace: the tty's erase character is set to match, and 0x08
  // reaches programs that read it as "move left" without erasing.
  eq("Backspace sends DEL", keyToBytes(key("Backspace")), [0x7f]);
  eq("Tab is a tab", keyToBytes(key("Tab")), [0x09]);
  eq("Escape is escape", keyToBytes(key("Escape")), [0x1b]);
}

// ------------------------------------------------------------------- control

console.log("\ncontrol keys");
{
  // A control character is the letter with its top bits cleared, which is what
  // makes these the numbers they are.
  eq("ctrl-c is 0x03, the interrupt", keyToBytes(key("c", { ctrlKey: true })), [0x03]);
  eq("ctrl-d is 0x04, end of file", keyToBytes(key("d", { ctrlKey: true })), [0x04]);
  eq("ctrl-z is 0x1a, suspend", keyToBytes(key("z", { ctrlKey: true })), [0x1a]);
  eq("ctrl-u is 0x15, kill line", keyToBytes(key("u", { ctrlKey: true })), [0x15]);
  eq("ctrl-w is 0x17, erase word", keyToBytes(key("w", { ctrlKey: true })), [0x17]);
  eq("ctrl-l is 0x0c, clear", keyToBytes(key("l", { ctrlKey: true })), [0x0c]);
  eq("case does not matter", keyToBytes(key("C", { ctrlKey: true })), [0x03]);
  eq("ctrl-space sends NUL", keyToBytes(key(" ", { ctrlKey: true })), [0x00]);
  eq("ctrl-bracket sends escape", keyToBytes(key("[", { ctrlKey: true })), [0x1b]);
  check("ctrl with a non-letter sends nothing",
        keyToBytes(key("F5", { ctrlKey: true })) === null);
}
{
  // The browser's own shortcuts have to keep working. A terminal that swallowed
  // the platform modifier would take copy and paste with it.
  for (const k of ["c", "v", "a", "r"]) {
    check(`the platform modifier leaves ${k} to the browser`,
          keyToBytes(key(k, { metaKey: true })) === null);
  }
}

// ------------------------------------------------------------------ sequences

console.log("\nkeys that send escape sequences");
{
  eq("up arrow", keyToBytes(key("ArrowUp")), [0x1b, 0x5b, 0x41]);
  eq("down arrow", keyToBytes(key("ArrowDown")), [0x1b, 0x5b, 0x42]);
  eq("right arrow", keyToBytes(key("ArrowRight")), [0x1b, 0x5b, 0x43]);
  eq("left arrow", keyToBytes(key("ArrowLeft")), [0x1b, 0x5b, 0x44]);
  eq("home", keyToBytes(key("Home")), [0x1b, 0x5b, 0x48]);
  eq("end", keyToBytes(key("End")), [0x1b, 0x5b, 0x46]);
  eq("delete", keyToBytes(key("Delete")), [0x1b, 0x5b, 0x33, 0x7e]);
  eq("page up", keyToBytes(key("PageUp")), [0x1b, 0x5b, 0x35, 0x7e]);
}
{
  eq("F1 uses the older form", keyToBytes(key("F1")), [0x1b, 0x4f, 0x50]);
  eq("F5 is numbered", keyToBytes(key("F5")), [0x1b, 0x5b, 0x31, 0x35, 0x7e]);
  eq("F12 is numbered too", keyToBytes(key("F12")), [0x1b, 0x5b, 0x32, 0x34, 0x7e]);
}
{
  // Meta has always been carried as an escape prefix over a byte stream.
  eq("alt prefixes with escape", keyToBytes(key("b", { altKey: true })), [0x1b, 0x62]);
  eq("alt with an arrow prefixes the whole sequence",
     keyToBytes(key("ArrowLeft", { altKey: true })), [0x1b, 0x1b, 0x5b, 0x44]);
  check("alt with a key that sends nothing sends nothing",
        keyToBytes(key("Shift", { altKey: true })) === null);
}

// ---------------------------------------------------------------------- paste

console.log("\npasting");
{
  eq("plain text is its bytes", textToBytes("ls -l"), [...Buffer.from("ls -l")]);
  // A paste should be indistinguishable from typing, and typing Enter sends CR.
  eq("a newline becomes a carriage return", textToBytes("a\nb"), [0x61, 0x0d, 0x62]);
  eq("so does a Windows line ending", textToBytes("a\r\nb"), [0x61, 0x0d, 0x62]);
  eq("a trailing newline runs the line", textToBytes("ls\n"), [0x6c, 0x73, 0x0d]);
}
{
  // A multi-line paste executes without the user pressing anything, which is a
  // well known way to get someone to run a line they did not read.
  check("a multi-line paste is worth confirming", pasteNeedsConfirming("ls\nrm -rf /"));
  check("so is one with a trailing newline mid-text", pasteNeedsConfirming("a\nb"));
  check("a single line is not", !pasteNeedsConfirming("ls -l"));
  check("nor is one with only a trailing newline",
        !pasteNeedsConfirming("ls -l\n"), "trailing newline alone is what Enter does anyway");
}

// ------------------------------------------------------- what multiline needs

console.log("\nmultiline needs nothing from the terminal");
{
  // The shell decides a command is incomplete and keeps reading. Every line of
  // this is the same Enter that ends a complete command; nothing about the
  // terminal changes between them.
  const typed = ["for i in 1 2 3; do", "  echo $i", "done"];
  const bytes = typed.flatMap((line) => [
    ...textToBytes(line), ...keyToBytes(key("Enter"))
  ]);
  const carriageReturns = bytes.filter((b) => b === 0x0d).length;
  eq("three lines send three carriage returns and nothing else special",
     carriageReturns, 3);
  check("and no escape sequence appears anywhere in them",
        !bytes.includes(0x1b), "the terminal is not interpreting the construct");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
