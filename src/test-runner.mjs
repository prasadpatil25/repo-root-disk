// Tests for knowing when a guest command has finished.
//
// These reproduce the failure that broke a real sync: a poll landing while the
// command was still being echoed, at the single byte where the echo ended with
// a character a prompt also ends with.
//
// Run with: node src/test-runner.mjs

import { makeRunner } from "./guest/runner.js";
import { rc, atPrompt } from "./guest/fs.js";

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

/**
 * A console that delivers its reply one character at a time, so a poll can land
 * anywhere inside it. That is the only way to catch the fault this file is about.
 */
function dribblingGuest({ reply, perTick = 1 }) {
  let out = "";
  let queued = "";
  const guest = {
    send(text) {
      // A real console echoes what it was sent, then the command's output.
      queued += text.replace(/\n$/, "") + "\r\n" + reply;
    },
    tail: () => out,
    reset() { out = ""; },
    tick() {
      out += queued.slice(0, perTick);
      queued = queued.slice(perTick);
      return queued.length > 0;
    },
    drain() { while (guest.tick()); }
  };
  return guest;
}

// --------------------------------------------------------------- atPrompt

console.log("\ndeciding whether the guest is at a prompt");
{
  check("a prompt after a completed line counts", atPrompt("output\n~% "));
  check("a prompt with nothing before it does not", !atPrompt("~% "));
  // The exact fault: mid-echo, the tail ends with the $ of "echo rc=$?".
  check("a command being echoed is not a prompt",
        !atPrompt("mount | grep -q ' /disk/dev '; echo rc=$"));
  // Even once the echo has wrapped, a long line is not a prompt.
  check("a wrapped command line is not a prompt",
        !atPrompt("chroot /disk /bin/sh -c 'apk add --allow-untrusted --no-network'\n" +
                  " /var/cache/packages/vim-9.1.0707-r0.apk 2>&1; echo rc=$"));
  check("a short continuation that ends in $ is still refused when it is the whole tail",
        !atPrompt("; echo rc=$"));
  check("an empty tail is not a prompt", !atPrompt(""));
  check("a hash prompt counts", atPrompt("done\n# "));
}

// ----------------------------------------------------------- the fault

console.log("\nthe fault that broke a sync");
{
  // Drive the console one character at a time and poll at every step. Without a
  // marker to wait for, some poll lands on the $ and returns a truncated tail.
  const command = "mount | grep -q ' /disk/dev '";
  const sent = `${command}; echo rc=$?`;
  const guest = dribblingGuest({ reply: "rc=0\r\n~% " });

  let firedEarly = false;
  guest.send(sent);
  while (guest.tick()) {
    const naive = /[#$%>]\s*$/.test(guest.tail());
    if (naive && !/rc=\d/.test(guest.tail())) { firedEarly = true; break; }
  }
  check("matching a bare prompt character does fire before the output arrives",
        firedEarly, "the fault did not reproduce, so the test proves nothing");
}
{
  // The same stream, judged the way the code now judges it.
  const sent = "mount | grep -q ' /disk/dev '; echo rc=$?";
  const guest = dribblingGuest({ reply: "rc=0\r\n~% " });
  let firedEarly = false;
  guest.send(sent);
  while (guest.tick()) {
    if (/rc=\d/.test(guest.tail()) === false && atPrompt(guest.tail())) firedEarly = true;
  }
  check("neither the marker nor atPrompt fires early on the same stream", !firedEarly);
}

// ---------------------------------------------------------------- runner

console.log("\nrunning a command");
{
  const guest = dribblingGuest({ reply: "rc=0\r\n~% ", perTick: 3 });
  const run = makeRunner({ send: guest.send, tail: guest.tail, reset: guest.reset, pollMs: 1 });
  const pending = rc(run, "mount | grep -q ' /disk/dev '");
  const timer = setInterval(() => { if (!guest.tick()) clearInterval(timer); }, 1);
  const result = await pending;
  clearInterval(timer);
  eq("the exit status comes back", result.code, 0);
  check("and the echoed command is not returned as output", result.output === "", result.output);
}
{
  const guest = dribblingGuest({ reply: "a-value\r\nrc=0\r\n~% ", perTick: 4 });
  const run = makeRunner({ send: guest.send, tail: guest.tail, reset: guest.reset, pollMs: 1 });
  const pending = rc(run, "cat /disk/etc/alpine-release");
  const timer = setInterval(() => { if (!guest.tick()) clearInterval(timer); }, 1);
  const result = await pending;
  clearInterval(timer);
  eq("real output survives", result.output, "a-value");
}
{
  const guest = dribblingGuest({ reply: "rc=1\r\n~% ", perTick: 5 });
  const run = makeRunner({ send: guest.send, tail: guest.tail, reset: guest.reset, pollMs: 1 });
  const pending = rc(run, "test -f /nowhere");
  const timer = setInterval(() => { if (!guest.tick()) clearInterval(timer); }, 1);
  const result = await pending;
  clearInterval(timer);
  check("a failing command reports its status, not an error", result.ok === false);
}
{
  // No marker: the prompt fallback is what decides.
  const guest = dribblingGuest({ reply: "hello\r\n~% ", perTick: 2 });
  const run = makeRunner({ send: guest.send, tail: guest.tail, reset: guest.reset, pollMs: 1 });
  const pending = run("echo hello");
  const timer = setInterval(() => { if (!guest.tick()) clearInterval(timer); }, 1);
  const out = await pending;
  clearInterval(timer);
  check("a command with no marker still finishes at the prompt", out.includes("hello"), out);
}
{
  const guest = dribblingGuest({ reply: "never a prompt" });
  const run = makeRunner({ send: guest.send, tail: guest.tail, reset: guest.reset, pollMs: 1 });
  guest.drain();
  let message = "";
  try { await run("hangs", { timeoutMs: 60 }); } catch (err) { message = err.message; }
  check("a command that never finishes times out rather than hanging",
        /did not finish within 60ms/.test(message), message);
}
{
  let sent = null;
  const run = makeRunner({ send: (t) => { sent = t; }, tail: () => "x\n~% ", pollMs: 1 });
  await run("ls");
  eq("the command is sent with a newline", sent, "ls\n");
}
{
  let threw = false;
  try { makeRunner({ tail: () => "" }); } catch { threw = true; }
  check("a runner with no way to send is refused", threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
