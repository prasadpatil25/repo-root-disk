// Tests for the serial terminal renderer, against a fake DOM.
//
// The faults this file pins down are the ones seen in a real session: escape
// sequences printed as text, a stray 0xFF rendered as a character, and a shell
// rewriting a line producing corruption instead of the rewrite.
//
// Control characters are written as character codes rather than as literals, so
// the source stays readable and there is no doubt about what is being fed in.
//
// Run with: node src/test-terminal.mjs

import { Terminal } from "./ui/terminal.js";

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

const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
const BS = String.fromCharCode(0x08);
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);

// --- a DOM small enough to reason about ---------------------------------------

function makeNode() {
  const node = {
    className: "", innerHTML: "", children: [],
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    get firstChild() { return this.children[0] || null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  };
  node.ownerDocument = { createElement: () => makeNode() };
  return node;
}

function makeTerm(options) {
  const root = makeNode();
  return { term: new Terminal(root, options), root };
}

/** Rendered markup, one entry per line. */
function html(term) {
  term.render();
  return term.el.children.map((n) => n.innerHTML);
}

/** Rendered text with markup stripped, which is what a reader sees. */
function text(term) {
  return html(term).map((s) => s.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

/** Feed a string as UTF-8 bytes, the way the emulator actually delivers it. */
function feedBytes(term, string) {
  for (const byte of new TextEncoder().encode(string)) term.writeByte(byte);
}

// ------------------------------------------------------------------ plain text

console.log("\nplain text");
{
  const { term } = makeTerm();
  term.write("hello\nworld");
  eq("lines are separated", text(term), ["hello", "world"]);
  eq("no markup where there are no attributes", html(term), ["hello", "world"]);
}
{
  const { term } = makeTerm();
  term.write("a <b> & c");
  eq("angle brackets and ampersands are escaped, not injected",
     html(term), ["a &lt;b&gt; &amp; c"]);
  eq("and read back as themselves", text(term), ["a <b> & c"]);
}

// -------------------------------------------------------------------- escapes

console.log("\nescape sequences are interpreted, never printed");
{
  const { term } = makeTerm();
  // Exactly what the guest sends for a coloured directory entry in ls output.
  term.write(ESC + "[1;34mbin" + ESC + "[m");
  const markup = html(term)[0];
  check("the sequence does not appear as text", !markup.includes("[1;34m"), markup);
  check("the name is wrapped in a styled span",
        markup === '<span class="t bold b">bin</span>', markup);
  eq("and reads as the bare name", text(term), ["bin"]);
}
{
  const { term } = makeTerm();
  term.write(ESC + "[31mred" + ESC + "[0m plain");
  eq("colour ends at the reset", text(term), ["red plain"]);
  check("only the coloured run is wrapped",
        html(term)[0] === '<span class="t r">red</span> plain', html(term)[0]);
}
{
  const { term } = makeTerm();
  term.write("a" + ESC + "[999;7;Zb");
  eq("an unrecognised sequence is swallowed whole", text(term), ["ab"]);
}
{
  const { term } = makeTerm();
  term.write("a" + ESC + "]0;a window title" + String.fromCharCode(0x07) + "b");
  eq("an OSC title is swallowed", text(term), ["ab"]);

  const other = makeTerm().term;
  other.write("a" + ESC + "]0;title" + ESC + "\\b");
  eq("including the ESC-backslash terminator", text(other), ["ab"]);
}
{
  const { term } = makeTerm();
  term.write("a" + ESC + "(Bb");   // ESC ( B is three bytes, not two
  eq("a charset designator, which carries an intermediate byte, is swallowed",
     text(term), ["ab"]);
}

// ---------------------------------------------------------------- stray bytes

console.log("\nbytes that are not text");
{
  const { term } = makeTerm();
  // 0xFF from a serial line that is still settling. This is the byte that
  // rendered as a character in the session that prompted this file. It is not
  // valid UTF-8, so it decodes to the replacement character rather than to a
  // control code, which is why dropping C0 and C1 alone is not enough.
  term.writeByte(0xff);
  feedBytes(term, "mount: mounting host9p on /mnt failed");
  eq("the stray byte leaves no character behind",
     text(term), ["mount: mounting host9p on /mnt failed"]);
}
{
  const { term } = makeTerm();
  feedBytes(term, "café — ✓");
  eq("multi-byte characters survive being delivered one byte at a time",
     text(term), ["café — ✓"]);
}
{
  const { term } = makeTerm();
  term.write("a" + NUL + "bc");
  eq("other control bytes are dropped", text(term), ["abc"]);
}

// ------------------------------------------------------------- cursor motion

console.log("\ncursor motion within a line");
{
  const { term } = makeTerm();
  term.write("progress 10%" + CR + "progress 90%");
  eq("a carriage return rewrites the line rather than appending",
     text(term), ["progress 90%"]);
}
{
  const { term } = makeTerm();
  // What a shell actually echoes when a key is rubbed out: back, space, back.
  term.write("abX" + BS + " " + BS + "c");
  eq("a rubbed-out character is erased rather than left behind",
     text(term), ["abc"]);
}
{
  const { term } = makeTerm();
  term.write("aaaaaaaaaa" + CR + "bbb" + ESC + "[K");
  eq("erase-to-end-of-line truncates the rewritten line", text(term), ["bbb"]);
}
{
  const { term } = makeTerm();
  term.write("col" + TAB + "umn");
  eq("a tab advances to the next stop", text(term), ["col     umn"]);
}
{
  const { term } = makeTerm();
  term.write("abcdef" + ESC + "[3GX");
  eq("absolute column positioning overwrites in place", text(term), ["abXdef"]);
}
{
  const { term } = makeTerm();
  term.write("old output\nmore" + ESC + "[2Jfresh");
  eq("clear-screen empties the scrollback", text(term), ["fresh"]);
}

// --------------------------------------------------------------- prompt match

console.log("\nthe tail used for prompt matching");
{
  const { term } = makeTerm();
  term.write(ESC + "[1;32m~%" + ESC + "[m ");
  check("a coloured prompt still looks like a prompt", /[#$%>]\s*$/.test(term.tail), term.tail);
  check("the tail carries no escape characters", !term.tail.includes(ESC), JSON.stringify(term.tail));
}
{
  const { term } = makeTerm();
  term.write("~% ");
  term.resetTail();
  check("resetting the tail leaves the screen alone", text(term).length === 1);
  eq("but does forget the prompt", term.tail, "");
}

// ----------------------------------------------------------------- scrollback

console.log("\nscrollback stays bounded");
{
  const { term, root } = makeTerm({ maxLines: 50 });
  for (let i = 0; i < 400; i++) term.write(`line ${i}\n`);
  check("older lines are discarded", root.children.length <= 51, `${root.children.length} nodes`);
  const shown = text(term).filter((s) => s);
  eq("and the most recent line is kept", shown[shown.length - 1], "line 399");
}
{
  // The whole reason for one node per line: a busy boot must not re-render the
  // entire scrollback on every frame.
  const { term, root } = makeTerm();
  for (let i = 0; i < 500; i++) term.write(`kernel message ${i}\n`);
  term.render();
  const before = root.children.map((n) => n.innerHTML);
  term.write("x");
  term.render();
  const after = root.children.map((n) => n.innerHTML);
  eq("writing one character touches one line node",
     after.filter((v, i) => v !== before[i]).length, 1);
}

// --------------------------------------------------------- progress meters

console.log("\na progress meter redrawing itself");
{
  // What apk emits while unpacking: a percentage and a growing bar, rewound with
  // a carriage return each time. A hundred of these must leave one line, not a
  // hundred concatenated ones.
  const { term, root } = makeTerm();
  for (let pct = 0; pct <= 100; pct += 10) {
    term.write(`${String(pct).padStart(3)}% ${"#".repeat(Math.floor(pct / 2.5))}${CR}`);
  }
  term.render();
  const line = root.children[0].textContent ?? text(term)[0];
  check("the meter collapses to a single line", root.children.length === 1,
        `${root.children.length} lines`);
  check("showing the last state it drew", text(term)[0].trim().startsWith("100%"), text(term)[0]);
  void line;
}
{
  // Writing something shorter after a rewind leaves the tail of what was there.
  // That is what a real terminal does, and why programs that care emit an erase
  // sequence rather than trusting the overwrite.
  const { term } = makeTerm();
  term.write(`100% ${"#".repeat(20)}${CR}OK`);
  eq("a short overwrite leaves the rest of the old line",
     text(term), ["OK0% ####################"]);

  const erased = makeTerm().term;
  erased.write(`100% ${"#".repeat(20)}${CR}OK${ESC}[K`);
  eq("unless the program erases to end of line", text(erased), ["OK"]);
}

// ------------------------------------------------------------ hidden tab

console.log("\na tab in the background still updates");
{
  // requestAnimationFrame does not fire while the page is not composited. If
  // the terminal schedules only through it, a boot the user tabbed away from
  // stops updating and comes back frozen.
  const { term, root } = makeTerm();
  root.ownerDocument.visibilityState = "hidden";
  let framesRequested = 0;
  globalThis.requestAnimationFrame = () => { framesRequested++; };  // never calls back

  term.write("kernel output while hidden");
  await new Promise((r) => setTimeout(r, 120));
  eq("no animation frame was relied on", framesRequested, 0);
  eq("the line rendered anyway", root.children[0].innerHTML, "kernel output while hidden");

  root.ownerDocument.visibilityState = "visible";
  const visible = makeTerm();
  visible.root.ownerDocument.visibilityState = "visible";
  visible.term.write("x");
  eq("a visible page does use animation frames", framesRequested, 1);
  delete globalThis.requestAnimationFrame;
}

// ------------------------------------------------------- the reported session

console.log("\nthe output from the session that prompted this");
{
  const { term } = makeTerm();
  const dir = (name) => ESC + "[1;34m" + name + ESC + "[m";

  term.writeByte(0xff);
  feedBytes(term,
    "mount: mounting host9p on /mnt failed: No such file or directory" + CR + "\n" +
    "Files send via emulator appear in /mnt/" + CR + "\n" +
    "~% ls" + CR + "\n" +
    dir("bin") + "      " + ESC + "[0;0mfoo" + ESC + "[m      " + dir("etc") + CR + "\n" +
    "% ");

  const lines = text(term);
  eq("the mount warning is clean", lines[0],
     "mount: mounting host9p on /mnt failed: No such file or directory");
  eq("the listing reads as names and spacing only", lines[3], "bin      foo      etc");
  check("no bracket sequence survives anywhere",
        !lines.some((l) => /\[\d/.test(l)), JSON.stringify(lines));
  check("directories are styled",
        html(term)[3].startsWith('<span class="t bold b">bin</span>'), html(term)[3]);
  check("the trailing prompt is matchable", /[#$%>]\s*$/.test(term.tail), JSON.stringify(term.tail));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
