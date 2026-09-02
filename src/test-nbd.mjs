// Tests for the kernel-backed device.
//
// Attaching a real kernel needs Linux, so the part that cannot run here is the
// last hop: nbd-client binding /dev/nbd0 to this server. Everything before that
// hop can run anywhere, and does. The suite speaks the client half of the
// protocol over a real TCP socket, so what is exercised is the actual wire
// format and the actual server loop, not a mock of them.
//
// The test that carries the generality claim is the last one: the unmodified
// sync engine driving this device through a full sync and restore. If the
// Device contract were secretly shaped around v86, that is where it would show.
//
// Run with: node src/test-nbd.mjs

import net from "node:net";
import { NbdDevice } from "./device/nbd.js";
import {
  CMD, ERR, FLAG, MAGIC, OPT,
  exportReply, greeting, optionRequest, parseOption, parseRequest, reply, request, validate
} from "./device/nbd-protocol.js";
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
const dec = new TextDecoder();
const handle = (n) => { const h = Buffer.alloc(8); h.writeUInt32BE(n, 4); return h; };

// ---------------------------------------------------------------- the protocol

console.log("\nthe wire format");
{
  const hello = greeting();
  eq("the greeting is eighteen bytes", hello.length, 18);
  check("opening with NBDMAGIC", hello.readBigUInt64BE(0) === MAGIC.hello);
  check("then IHAVEOPT", hello.readBigUInt64BE(8) === MAGIC.option);
  check("announcing fixed newstyle",
        (hello.readUInt16BE(16) & FLAG.FIXED_NEWSTYLE) !== 0);

  const full = exportReply(DISK);
  eq("the export reply carries the size", Number(full.readBigUInt64BE(0)), DISK);
  eq("with the historical padding by default", full.length, 134);
  eq("and without it when the client asked", exportReply(DISK, { noZeroes: true }).length, 10);

  const transmission = full.readUInt16BE(8);
  check("it announces flush", (transmission & FLAG.SEND_FLUSH) !== 0);
  check("and trim", (transmission & FLAG.SEND_TRIM) !== 0);
  check("read only is off by default", (transmission & (1 << 1)) === 0);
  check("and on when asked",
        (exportReply(DISK, { readOnly: true }).readUInt16BE(8) & (1 << 1)) !== 0);
}
{
  const opt = optionRequest(OPT.EXPORT_NAME, Buffer.from("disk"));
  const parsed = parseOption(opt);
  eq("an option round trips", parsed.option, OPT.EXPORT_NAME);
  eq("with its data", parsed.data.toString(), "disk");
  eq("and its length", parsed.consumed, opt.length);

  check("a half-arrived option header is not an option",
        parseOption(opt.subarray(0, 9)) === null);
  check("nor is a header whose data has not arrived",
        parseOption(opt.subarray(0, 17)) === null);

  const wrong = Buffer.from(opt);
  wrong.writeBigUInt64BE(0n, 0);
  let rejected = false;
  try { parseOption(wrong); } catch { rejected = true; }
  check("a wrong magic is refused rather than guessed at", rejected);
}
{
  const payload = enc.encode("sixteen bytes!!!");
  const write = request({ type: CMD.WRITE, handle: handle(7), offset: 512, length: 16, data: payload });
  const parsed = parseRequest(write);
  eq("a write round trips its type", parsed.type, CMD.WRITE);
  eq("its offset", parsed.offset, 512);
  eq("its length", parsed.length, 16);
  eq("its payload", dec.decode(parsed.data), "sixteen bytes!!!");
  eq("its handle", [...parsed.handle], [...handle(7)]);

  check("a partial header is not a request", parseRequest(write.subarray(0, 27)) === null);
  // The payload follows the header, so a complete header is still not enough.
  check("nor is a write whose payload is still arriving",
        parseRequest(write.subarray(0, 36)) === null);

  const read = request({ type: CMD.READ, handle: handle(1), offset: 0, length: 4096 });
  eq("a read needs no payload", parseRequest(read).data, null);
  eq("and consumes only its header", parseRequest(read).consumed, 28);

  const bad = Buffer.from(read);
  bad.writeUInt32BE(0xdeadbeef, 0);
  let rejected = false;
  try { parseRequest(bad); } catch { rejected = true; }
  check("a request with the wrong magic is refused", rejected);

  const answer = reply(handle(7), ERR.IO);
  check("a reply carries the reply magic", answer.readUInt32BE(0) === MAGIC.reply);
  eq("the error", answer.readUInt32BE(4), ERR.IO);
  eq("and the handle it answers", [...answer.subarray(8, 16)], [...handle(7)]);
}
{
  eq("a read inside the disk is valid",
     validate({ type: CMD.READ, offset: 0, length: DISK }, DISK), ERR.NONE);
  eq("a read one byte past the end is not",
     validate({ type: CMD.READ, offset: 1, length: DISK }, DISK), ERR.NOSPACE);
  eq("nor is a negative offset",
     validate({ type: CMD.READ, offset: -1, length: 8 }, DISK), ERR.INVALID);
  eq("a flush has no extent to check",
     validate({ type: CMD.FLUSH, offset: 0, length: 0 }, DISK), ERR.NONE);
}

// ----------------------------------------------------------------- the commands

console.log("\nanswering commands");
{
  const device = new NbdDevice({ diskSize: DISK });
  const payload = enc.encode("written by the kernel");

  const write = await device.handle({
    type: CMD.WRITE, offset: 2 * CHUNK, length: payload.length, data: payload
  });
  eq("a write succeeds", write.error, ERR.NONE);
  eq("and is recorded for the next sync", device.pending(),
     [{ offset: 2 * CHUNK, length: payload.length }]);

  const read = await device.handle({
    type: CMD.READ, offset: 2 * CHUNK, length: payload.length
  });
  eq("a read returns what was written", dec.decode(read.data), "written by the kernel");
  eq("and records nothing", device.pending().length, 1);

  const past = await device.handle({ type: CMD.READ, offset: DISK - 4, length: 8 });
  eq("a read past the end is an error, not a short read", past.error, ERR.NOSPACE);
  eq("carrying no data", past.data, null);

  const sealed = device.seal();
  eq("sealing hands over the epoch", sealed.length, 1);
  eq("and leaves it empty", device.pending(), []);

  const unknown = await device.handle({ type: 99, offset: 0, length: 0 });
  eq("an unknown command is refused", unknown.error, ERR.INVALID);

  const bye = await device.handle({ type: CMD.DISCONNECT, offset: 0, length: 0 });
  check("a disconnect asks the server to close", bye.disconnect);
}
{
  const device = new NbdDevice({ diskSize: DISK });
  await device.writeRaw(0, enc.encode("put back from the repository"));
  eq("hydration does not enter the epoch", device.pending(), []);
  const chunk = await device.readChunk(0, CHUNK);
  eq("but is on the disk", dec.decode(chunk.subarray(0, 28)), "put back from the repository");
  eq("a chunk is a whole chunk", chunk.length, CHUNK);

  let refused = false;
  try { await device.writeRaw(DISK - 2, new Uint8Array(8)); } catch { refused = true; }
  check("hydration past the end is refused", refused);
}
{
  // Trim is the one command the browser device cannot receive, and the reason
  // the paper's "a version-controlled disk cannot forget" limitation is a
  // property of that environment rather than of the design.
  const seen = [];
  const device = new NbdDevice({ diskSize: DISK, onDiscard: (r) => seen.push(r) });
  const result = await device.handle({ type: CMD.TRIM, offset: CHUNK, length: CHUNK });
  eq("a trim succeeds", result.error, ERR.NONE);
  eq("it is reported", seen, [{ offset: CHUNK, length: CHUNK }]);
  eq("and collected", device.takeDiscarded(), [{ offset: CHUNK, length: CHUNK }]);
  eq("once", device.takeDiscarded(), []);
  eq("freeing blocks is not writing them", device.pending(), []);
}

// -------------------------------------------------------------------- flushing

console.log("\nmaking the kernel let go");
{
  const device = new NbdDevice({ diskSize: DISK });
  let message = "";
  try { await device.flush(); } catch (err) { message = err.message; }
  check("a device with no way to reach the operating system refuses to flush",
        /no way to make the kernel flush/.test(message), message);
}
{
  // The honest loop: ask the operating system to sync, and wait for the flush
  // the kernel then sends. Returning between those two is the bug.
  const device = new NbdDevice({
    diskSize: DISK,
    requestFlush: async () => {
      await device.handle({ type: CMD.WRITE, offset: 0, length: 4, data: enc.encode("late") });
      await device.handle({ type: CMD.FLUSH, offset: 0, length: 0 });
    }
  });
  await device.flush();
  eq("the kernel's flush was seen", device.flushCount, 1);
  eq("and the writes it carried are in the epoch", device.pending(), [{ offset: 0, length: 4 }]);
}
{
  const device = new NbdDevice({ diskSize: DISK, requestFlush: async () => {} });
  let message = "";
  try { await device.flush({ timeoutMs: 60 }); } catch (err) { message = err.message; }
  check("a kernel that never flushes is a loud failure, not a silent short commit",
        /did not flush within/.test(message), message);
}

// ------------------------------------------------------------------- the wire

/** The client half, so the tests exercise the real server loop. */
class Client {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (d) => {
      this.buffer = Buffer.concat([this.buffer, d]);
      this._pump();
    });
  }
  _pump() {
    while (this.waiters.length && this.waiters[0].take()) this.waiters.shift();
  }
  /** Resolve with exactly n bytes, whenever they have all arrived. */
  read(n) {
    return new Promise((resolve) => {
      const take = () => {
        if (this.buffer.length < n) return false;
        const out = Buffer.from(this.buffer.subarray(0, n));
        this.buffer = this.buffer.subarray(n);
        resolve(out);
        return true;
      };
      if (take()) return;
      this.waiters.push({ take });
    });
  }
  async handshake({ noZeroes = true } = {}) {
    const hello = await this.read(18);
    if (hello.readBigUInt64BE(0) !== MAGIC.hello) throw new Error("not an NBD server");
    const flags = Buffer.alloc(4);
    flags.writeUInt32BE(noZeroes ? FLAG.NO_ZEROES : 0, 0);
    this.socket.write(flags);
    this.socket.write(optionRequest(OPT.EXPORT_NAME, Buffer.from("")));
    const head = await this.read(10);
    if (!noZeroes) await this.read(124);
    return { size: Number(head.readBigUInt64BE(0)), flags: head.readUInt16BE(8) };
  }
  async send(req, { expect = 0 } = {}) {
    this.socket.write(request(req));
    const head = await this.read(16);
    const error = head.readUInt32BE(4);
    const data = expect && error === ERR.NONE ? await this.read(expect) : null;
    return { error, data, handle: head.subarray(8, 16) };
  }
}

/** Start a server on an ephemeral port and connect a client to it. */
async function connect(device) {
  const server = net.createServer((socket) => device.serve(socket));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  return { client: new Client(socket), close: () => { socket.destroy(); server.close(); } };
}

console.log("\nover a real socket");
{
  const device = new NbdDevice({ diskSize: DISK });
  const { client, close } = await connect(device);
  try {
    const info = await client.handshake();
    eq("the client learns the export size", info.size, DISK);
    check("and that it may flush", (info.flags & FLAG.SEND_FLUSH) !== 0);

    const payload = enc.encode("over the wire");
    const written = await client.send({
      type: CMD.WRITE, handle: handle(1), offset: 3 * CHUNK, length: payload.length, data: payload
    });
    eq("a write over the wire succeeds", written.error, ERR.NONE);
    eq("answering the handle it was given", [...written.handle], [...handle(1)]);

    const read = await client.send({
      type: CMD.READ, handle: handle(2), offset: 3 * CHUNK, length: payload.length
    }, { expect: payload.length });
    eq("and reads back over the wire", dec.decode(read.data), "over the wire");

    const past = await client.send({
      type: CMD.READ, handle: handle(3), offset: DISK - 2, length: 64
    });
    eq("a read past the end is an error on the wire too", past.error, ERR.NOSPACE);

    await client.send({ type: CMD.TRIM, handle: handle(4), offset: CHUNK, length: CHUNK });
    eq("a trim over the wire is collected", device.takeDiscarded(),
       [{ offset: CHUNK, length: CHUNK }]);

    eq("only the write reached the epoch", device.pending(),
       [{ offset: 3 * CHUNK, length: payload.length }]);
  } finally { close(); }
}
{
  // A client that does not ask for the padding to be dropped must receive it,
  // or every byte after the handshake is misread.
  const device = new NbdDevice({ diskSize: DISK });
  const { client, close } = await connect(device);
  try {
    const info = await client.handshake({ noZeroes: false });
    eq("a client that wants the padding gets it, and stays in step", info.size, DISK);
    const probe = await client.send({
      type: CMD.READ, handle: handle(1), offset: 0, length: 8
    }, { expect: 8 });
    eq("so the next request is answered correctly", probe.error, ERR.NONE);
  } finally { close(); }
}

// --------------------------------------------- the engine, unchanged, on a kernel

console.log("\nthe sync engine against a kernel-shaped device");
{
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
      if (!orphan && current !== parent) {
        const e = new Error("not a fast forward"); e.status = 422; throw e;
      }
      this.branches.set(branch, commit);
      return { commit, requests: files.length + 3 };
    }
  }

  // The client stands in for the kernel: it writes through the socket and it is
  // what sync(1) would eventually cause to flush.
  let device = null;
  let client = null;
  device = new NbdDevice({
    diskSize: DISK,
    requestFlush: async () => {
      await client.send({ type: CMD.FLUSH, handle: handle(0) });
    }
  });
  const wire = await connect(device);
  client = wire.client;

  try {
    await client.handshake();

    const host = new FakeHost();
    const machine = new Machine({
      host, device, branch: "kernel-machine",
      governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
    });
    await machine.load({
      diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true
    });

    const text = "this disk was written by a kernel, not an emulator";
    await client.send({
      type: CMD.WRITE, handle: handle(1), offset: 0, length: text.length, data: enc.encode(text)
    });

    const result = await machine.sync({ message: "from the block device" });
    eq("the engine saw one dirty chunk", result.chunks, 1);
    eq("and uploaded it", result.uploaded, 1);
    check("having made the kernel flush first", device.flushCount >= 1);
    eq("and the epoch is closed behind it", device.pending(), []);

    const back = await restore({ host, branch: "kernel-machine" });
    eq("the state comes back", dec.decode(back.disk.subarray(0, text.length)), text);

    // A second sync, so the incremental path is on a kernel device too.
    const more = "a second write, in a different chunk";
    await client.send({
      type: CMD.WRITE, handle: handle(2), offset: 2 * CHUNK, length: more.length,
      data: enc.encode(more)
    });
    const second = await machine.sync({ message: "again" });
    eq("the second sync carries only what changed", second.uploaded, 1);

    const after = await restore({ host, branch: "kernel-machine" });
    eq("both writes survive", dec.decode(after.disk.subarray(0, text.length)), text);
    eq("including the later one",
       dec.decode(after.disk.subarray(2 * CHUNK, 2 * CHUNK + more.length)), more);
  } finally { wire.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
process.exit(0);
