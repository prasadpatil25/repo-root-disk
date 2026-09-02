// Tests for the v86 device wrapper, against a fake emulator.
//
// The emulator itself needs a browser, but everything this wrapper does can be
// exercised offline: finding the buffer, intercepting writes, coalescing ranges,
// reading chunks back, and refusing the configurations that would corrupt a
// machine. Run with: node src/test-device.mjs

import { V86Device, serialFlush } from "./device/v86.js";
import { Machine, restore } from "./core/machine.js";
import { Governor } from "./core/governor.js";

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

const DISK = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;
const enc = new TextEncoder();

/** A buffer with v86's contract: get(offset, len, cb), set(offset, data, cb). */
function makeBuffer(size, { streamed = false } = {}) {
  const bytes = new Uint8Array(size);
  const buffer = {
    byteLength: size,
    load() { return Promise.resolve(); },
    get(offset, length, fn) { fn(bytes.subarray(offset, offset + length)); },
    set(offset, data, fn) { bytes.set(data, offset); if (fn) fn(); }
  };
  if (streamed) buffer.block_cache = new Map();
  return { buffer, bytes };
}

/** An emulator shaped like v86's, including the sound card decoy. */
function makeEmulator(buffer, { includeIde = true } = {}) {
  const sb16 = {
    // Same shape as a block buffer. A naive search finds this first.
    dma_syncbuffer: { get() {}, set() {}, load() {}, get_buffer() {} }
  };
  const ide = includeIde
    ? { primary: { master: { buffer }, slave: { buffer: null } }, secondary: { master: { buffer: null } } }
    : undefined;
  return {
    v86: { cpu: { devices: { sb16, ...(ide ? { ide } : {}) } } },
    _listeners: {},
    add_listener(event, fn) { (this._listeners[event] ||= []).push(fn); },
    serial0_send(text) { this._sent = (this._sent || "") + text; },
    emit(event, value) { for (const fn of this._listeners[event] || []) fn(value); }
  };
}

const noFlush = async () => {};

// ---------------------------------------------------------------- attachment

console.log("\nfinding the device");
{
  const { buffer } = makeBuffer(DISK);
  const emulator = makeEmulator(buffer);
  const device = new V86Device({ emulator, diskSize: DISK, flush: noFlush });
  check("attaches on the known path", device.attach());
  eq("and reports where it attached", device.bufferPath, "v86.cpu.devices.ide.primary.master.buffer");
  check("attaching twice is harmless", device.attach());
  check("an in-memory buffer is not reported as streamed", device.streamed === false);
}
{
  const { buffer } = makeBuffer(DISK, { streamed: true });
  const device = new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK, flush: noFlush });
  device.attach();
  check("a streamed buffer is recognised", device.streamed === true);
}
{
  // With no IDE device the search must not settle for the sound card, whose DMA
  // buffer has the same shape. Wrapping it would capture nothing at all.
  const device = new V86Device({
    emulator: makeEmulator(null, { includeIde: false }), diskSize: DISK, flush: noFlush
  });
  check("the sound card's buffer is not mistaken for the disk", !device.attach());
}
{
  const { buffer } = makeBuffer(DISK);
  const emulator = makeEmulator(buffer);
  const a = new V86Device({ emulator, diskSize: DISK, flush: noFlush });
  a.attach();
  const b = new V86Device({ emulator, diskSize: DISK, flush: noFlush });
  check("a second wrapper does not double-wrap", b.attach() && b.buffer === a.buffer);
  a.detach();
  check("detach restores the original method", typeof buffer.set === "function");
}

// ------------------------------------------------------------- configuration

console.log("\nrefusing configurations that would corrupt a machine");
{
  const { buffer } = makeBuffer(DISK);
  let refused = false;
  try { new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK }); }
  catch (err) { refused = /flush strategy is required/.test(err.message); }
  check("a device without a flush strategy is refused", refused);

  let misaligned = false;
  try { new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK + 1, flush: noFlush }); }
  catch (err) { misaligned = /multiple of 256/.test(err.message); }
  check("a misaligned disk size is refused", misaligned);
}

// ---------------------------------------------------------------- capture

console.log("\ncapturing writes");
{
  const { buffer, bytes } = makeBuffer(DISK);
  const device = new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK, flush: noFlush });
  device.attach();

  buffer.set(0, enc.encode("before capture is armed"));
  eq("writes before start() are ignored", device.pending().length, 0);

  device.start();
  buffer.set(1024, new Uint8Array(512));
  eq("a write is recorded once armed", device.pending().length, 1);
  eq("with its offset and length", device.pending()[0], { offset: 1024, length: 512 });

  buffer.set(1536, new Uint8Array(512));
  eq("an adjacent write coalesces", device.pending().length, 1);
  eq("into one wider range", device.pending()[0], { offset: 1024, length: 1024 });

  buffer.set(3 * 1024 * 1024, new Uint8Array(256));
  eq("a distant write starts a new range", device.pending().length, 2);

  eq("the payload still reached the underlying buffer", bytes[1024], 0);
  eq("byte accounting tracks the transfers", device.stats.bytes, 512 + 512 + 256);

  const sealed = device.seal();
  eq("sealing returns the epoch", sealed.length, 2);
  eq("and empties it", device.pending().length, 0);

  device.stop();
  buffer.set(2048, new Uint8Array(16));
  eq("writes after stop() are ignored", device.pending().length, 0);
}
{
  // Ranges, not payloads. A wrapper that kept copies would hold a second disk in
  // the tab; filling 220 MB is the case that makes this matter.
  const { buffer } = makeBuffer(DISK);
  const device = new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK, flush: noFlush });
  device.attach();
  device.start();
  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < 32; i++) buffer.set(i * 128 * 1024, payload);
  const recorded = JSON.stringify(device.pending()).length;
  check("the epoch stays tiny next to the data written", recorded < 2000,
        `${recorded} bytes of range log for 2 MB written`);
}

// ------------------------------------------------------------------ reading

console.log("\nreading chunks back");
{
  const { buffer, bytes } = makeBuffer(DISK);
  bytes.fill(0xCD);
  bytes.set(enc.encode("written on top of the base"), 0);
  const device = new V86Device({ emulator: makeEmulator(buffer), diskSize: DISK, flush: noFlush });
  device.attach();

  const chunk = await device.readChunk(0, CHUNK);
  eq("a chunk comes back at chunk size", chunk.length, CHUNK);
  eq("carrying what was written", new TextDecoder().decode(chunk.subarray(0, 26)),
     "written on top of the base");
  eq("and the base content behind it", chunk[100], 0xCD);

  const later = await device.readChunk(3, CHUNK);
  eq("an untouched chunk is base content, not zeros", later[0], 0xCD);

  let rejected = false;
  try { await device.readChunk(999, CHUNK); } catch { rejected = true; }
  check("reading past the device end is refused", rejected);

  let misaligned = false;
  try { await device.readChunk(0, 100); } catch (err) {
    misaligned = /multiple of 256/.test(err.message);
  }
  check("a misaligned chunk size is refused", misaligned);
}
{
  // The last chunk of a disk that is not a whole number of chunks.
  const size = 3 * CHUNK + 512;
  const { buffer } = makeBuffer(size);
  const device = new V86Device({ emulator: makeEmulator(buffer), diskSize: size, flush: noFlush });
  device.attach();
  const tail = await device.readChunk(3, CHUNK);
  eq("the final short chunk is clamped to the device", tail.length, 512);
}

// -------------------------------------------------------------- serial flush

console.log("\nflushing the guest");
{
  const { buffer } = makeBuffer(DISK);
  const emulator = makeEmulator(buffer);
  const flush = serialFlush(emulator, { prompt: /~%\s*$/, timeoutMs: 2000 });

  const done = flush();
  await new Promise((r) => setTimeout(r, 20));
  // The flush asks for an exit status rather than watching for a prompt.
  // Spotting a prompt is a guess about what output means, and this is the call
  // where guessing wrong loses the user's most recent writes.
  check("the flush command carries a status marker",
        (emulator._sent || "").includes("sync; echo flushed=$?"), emulator._sent);
  for (const ch of "\r\nflushed=0\r\n~% ") emulator.emit("serial0-output-byte", ch.charCodeAt(0));
  await done;
  check("it resolves on the status, not on the prompt", true);
}
{
  // A flush that failed must not be reported as success. Committing after one
  // writes out a machine whose newest data is still in page cache.
  const emulator = makeEmulator(makeBuffer(DISK).buffer);
  const flush = serialFlush(emulator, { timeoutMs: 2000 });
  const done = flush();
  await new Promise((r) => setTimeout(r, 20));
  for (const ch of "\r\nsync: I/O error\r\nflushed=1\r\n~% ") {
    emulator.emit("serial0-output-byte", ch.charCodeAt(0));
  }
  let message = "";
  try { await done; } catch (err) { message = err.message; }
  check("a nonzero status is raised rather than ignored",
        /failed in the guest with status 1/.test(message), message);
}
{
  const emulator = makeEmulator(makeBuffer(DISK).buffer);
  const flush = serialFlush(emulator, { prompt: /~%\s*$/, timeoutMs: 250 });
  let timedOut = false;
  try { await flush(); } catch (err) { timedOut = /did not report back/.test(err.message); }
  check("a guest that never responds fails loudly rather than syncing anyway", timedOut);
}
{
  // A prompt alone is no longer enough, which is the point: the earlier version
  // watched for one and could be satisfied by output that meant nothing.
  const emulator = makeEmulator(makeBuffer(DISK).buffer);
  const flush = serialFlush(emulator, { prompt: /~%\s*$/, timeoutMs: 300 });
  const done = flush();
  await new Promise((r) => setTimeout(r, 20));
  for (const ch of "\r\n~% ") emulator.emit("serial0-output-byte", ch.charCodeAt(0));
  let refused = false;
  try { await done; } catch { refused = true; }
  check("a bare prompt does not count as a completed flush", refused);
}
{
  // A coloured prompt was the earlier failure here. The status marker is
  // unaffected by colour, which is the reason to prefer it.
  const emulator = makeEmulator(makeBuffer(DISK).buffer);
  const flush = serialFlush(emulator, { timeoutMs: 2500 });
  const done = flush();
  await new Promise((r) => setTimeout(r, 20));
  const ESC = String.fromCharCode(0x1b);
  for (const ch of "\r\nflushed=0\r\n" + ESC + "[1;32m~%" + ESC + "[m ") {
    emulator.emit("serial0-output-byte", ch.charCodeAt(0));
  }
  let ok = true;
  try { await done; } catch { ok = false; }
  check("colour around the prompt cannot affect the result", ok);
}

// ------------------------------------------------- the wrapper drives the engine

console.log("\nend to end through the real device wrapper");
{
  // The same fake host as the engine suite, kept minimal here.
  class FakeHost {
    static get capabilities() {
      return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e9 };
    }
    constructor() {
      this.objects = new Map(); this.trees = new Map(); this.commits = new Map();
      this.branches = new Map(); this.requestCount = 0; this.governor = null; this._n = 0;
    }
    async resolveRef(b) {
      const head = this.branches.get(b);
      return head ? { commit: head, tree: this.commits.get(head).tree } : null;
    }
    async readTree(t) { return this.trees.get(t).map((e) => ({ path: e.path, id: e.id, size: 0 })); }
    async readObject(id) { return this.objects.get(id); }
    async commit({ branch, files, parent = null, orphan = false }) {
      for (const f of files) if (!f.skipUpload) this.objects.set(f.id, f.bytes);
      const tree = `t${++this._n}`;
      this.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
      const commit = `c${++this._n}`;
      this.commits.set(commit, { tree, parents: orphan || !parent ? [] : [parent] });
      const current = this.branches.get(branch) || null;
      if (!orphan && current !== parent) { const e = new Error("not a fast forward"); e.status = 422; throw e; }
      this.branches.set(branch, commit);
      return { commit, requests: files.length + 3 };
    }
  }

  const { buffer, bytes } = makeBuffer(DISK);
  bytes.fill(0x7F); // a base image with content, so the zeros bug would show
  const emulator = makeEmulator(buffer);

  let flushed = 0;
  const device = new V86Device({
    emulator, diskSize: DISK, flush: async () => { flushed++; }
  });
  device.attach();
  device.start();

  const host = new FakeHost();
  const machine = new Machine({
    host, device, branch: "machine",
    governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
  });
  await machine.load({
    diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: false
  });

  const written = "state written through the wrapped device";
  buffer.set(0, enc.encode(written));
  const result = await machine.sync({ message: "through the wrapper" });
  eq("one chunk was dirtied", result.chunks, 1);
  eq("and uploaded", result.uploaded, 1);
  check("the engine flushed through the wrapper", flushed === 1);

  const restored = await restore({
    host, branch: "machine", fetchBase: async () => bytes.slice()
  });
  eq("the restored disk carries the write",
     new TextDecoder().decode(restored.disk.subarray(0, written.length)), written);
  eq("and base content everywhere else", restored.disk[DISK - 1], 0x7F);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
