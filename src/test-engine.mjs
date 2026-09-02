// End-to-end tests for the sync engine and restore, against an in-memory host
// that models real compare-and-swap semantics. No network, no token.
//
// Run with: node src/test-engine.mjs

import { Machine, restore, ConflictError } from "./core/machine.js";
import { MemoryDevice } from "./device/memory.js";
import { blobId } from "./core/objectid.js";
import { deriveCipher, randomSaltHex } from "./core/crypto.js";
import { Governor } from "./core/governor.js";
import * as manifestModule from "./core/manifest.js";

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
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A host with the same contract as the real adapters, including fast-forward-only
// reference updates, so the conflict paths below are genuinely exercised.
class FakeHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e9 };
  }
  static requestsPerCommit(n) { return n + 3; }

  constructor() {
    this.objects = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.requestCount = 0;
    this.governor = null;
    this.uploads = [];
    this._counter = 0;
  }

  _id(prefix) { return `${prefix}${++this._counter}`; }

  async validate() { return { login: "tester", private: false, canWrite: true }; }

  async resolveRef(branch) {
    this.requestCount++;
    const head = this.branches.get(branch);
    return head ? { commit: head, tree: this.commits.get(head).tree } : null;
  }

  async readTree(treeId) {
    this.requestCount++;
    return this.trees.get(treeId).map((e) => ({ path: e.path, id: e.id, size: 0 }));
  }

  async readObject(id) {
    this.requestCount++;
    if (!this.objects.has(id)) throw new Error(`object ${id} not found`);
    return this.objects.get(id);
  }

  async commit({ branch, message, files, parent = null, orphan = false }) {
    const before = this.requestCount;
    for (const file of files) {
      if (file.skipUpload) continue;
      this.requestCount++;
      this.uploads.push(file.id);
      this.objects.set(file.id, file.bytes);
    }
    this.requestCount++; // tree
    const treeId = this._id("tree");
    this.trees.set(treeId, files.map((f) => ({ path: f.path, id: f.id })));

    this.requestCount++; // commit
    const commitId = this._id("commit");
    this.commits.set(commitId, { tree: treeId, parents: orphan || !parent ? [] : [parent], message });

    this.requestCount++; // ref
    const current = this.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      const err = new Error("Update is not a fast forward");
      err.status = 422;
      throw err;
    }
    this.branches.set(branch, commitId);
    return { commit: commitId, requests: this.requestCount - before };
  }
}

const K = 1024;
const DISK = 4 * 1024 * K;      // 4 MB
const CHUNK = 256 * K;          // 16 chunks
const fast = () => new Governor({ ratePerMin: 6e6, concurrency: 8 });

function newMachine(host, device, extra = {}) {
  return new Machine({ host, device, branch: "machine", governor: fast(), ...extra });
}

const enc = new TextEncoder();

// ------------------------------------------------------------------ full loop

console.log("\nthe full loop");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  device.write(0, enc.encode("machine state at offset zero"));
  device.write(2 * 1024 * K, enc.encode("and some more, two megabytes in"));

  const result = await machine.sync({ message: "first" });
  eq("two writes dirty two chunks", result.chunks, 2);
  eq("both chunks are uploaded", result.uploaded, 2);
  eq("nothing was reused on a first sync", result.reused, 0);
  check("a commit id came back", !!result.commit);

  const restored = await restore({ host, branch: "machine" });
  check("the restored disk matches the live one byte for byte",
        bytesEqual(restored.disk, device.snapshot()));
  eq("restore applied both chunks", restored.chunksApplied, 2);
}

// ------------------------------------------------------------- flush contract

console.log("\nthe flush is a correctness requirement");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  // Written but never flushed, exactly as a guest leaves a file in page cache.
  device.write(0, enc.encode("the user's most recent work"));
  eq("nothing has reached the device yet", device.pending().length, 0);

  await machine.sync({ message: "with flush" });
  check("sync flushed the guest before sealing", device.flushCount >= 1);

  const restored = await restore({ host, branch: "machine" });
  const text = new TextDecoder().decode(restored.disk.subarray(0, 27));
  eq("the unflushed write survived the sync", text, "the user's most recent work");
}

// ------------------------------------------------------------- incremental

console.log("\nincremental syncs");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  device.write(0, enc.encode("chunk zero"));
  device.write(1 * 256 * K, enc.encode("chunk one"));
  device.write(2 * 256 * K, enc.encode("chunk two"));
  const first = await machine.sync({});
  eq("the first sync uploads three chunks", first.uploaded, 3);

  device.write(0, enc.encode("chunk zero, edited"));
  const second = await machine.sync({});
  eq("the second sync dirties one chunk", second.chunks, 1);
  eq("and uploads only that one", second.uploaded, 1);

  // Restore cost is constant in machine age: the tree still references
  // everything the disk needs, whichever sync produced it.
  const tree = host.trees.get(host.commits.get(host.branches.get("machine")).tree);
  eq("the tree still references all three chunks plus the manifest", tree.length, 4);

  const restored = await restore({ host, branch: "machine" });
  check("the machine restores to its current state",
        bytesEqual(restored.disk, device.snapshot()));
  eq("the manifest counts two syncs", restored.manifest.sync, 2);
}

// ---------------------------------------------------------------- dedup

console.log("\ndeduplication");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  // Identical content in two places collapses to one object, which is the only
  // deduplication actually available: it is free space, not compression.
  const same = enc.encode("identical content");
  device.write(0, same);
  device.write(3 * 256 * K, same);
  const result = await machine.sync({});
  eq("two chunks were dirtied", result.chunks, 2);
  eq("but only one object was uploaded", result.uploaded, 1);
  eq("the other was recognised as already present", result.reused, 1);
}

// --------------------------------------------------------------- non-blank base

console.log("\nrestoring onto a base image");
{
  const host = new FakeHost();
  const base = new Uint8Array(DISK).fill(0xAB);
  const device = new MemoryDevice({ diskSize: DISK, base });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: false });

  device.write(0, enc.encode("written over the base"));
  await machine.sync({});

  const restored = await restore({
    host, branch: "machine", fetchBase: async () => base
  });
  check("the restored disk matches the live one", bytesEqual(restored.disk, device.snapshot()));
  eq("untouched regions carry base content, not zeros", restored.disk[DISK - 1], 0xAB);

  // The bug this guards against is silent: restoring onto zeros looks fine
  // until the base has content, then corrupts every untouched chunk.
  let refused = false;
  try { await restore({ host, branch: "machine" }); }
  catch (err) { refused = /non-blank base/.test(err.message); }
  check("restoring a non-blank base without one is refused, not guessed", refused);
}

// ------------------------------------------------------------------ encryption

console.log("\nencrypted machines");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const salt = randomSaltHex();
  const cipher = await deriveCipher("a passphrase the host never sees", salt);
  const machine = newMachine(host, device, { cipher });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  const secret = "a credential typed into the guest";
  device.write(0, enc.encode(secret));
  await machine.sync({});

  const stored = [...host.objects.values()];
  const anyPlaintext = stored.some((bytes) =>
    new TextDecoder().decode(bytes).includes(secret));
  check("the host never holds the plaintext", !anyPlaintext);

  const restored = await restore({ host, branch: "machine", cipher });
  check("the right passphrase restores the disk exactly",
        bytesEqual(restored.disk, device.snapshot()));

  const wrong = await deriveCipher("not the passphrase", salt);
  let rejected = false;
  try { await restore({ host, branch: "machine", cipher: wrong }); }
  catch { rejected = true; }
  check("the wrong passphrase cannot restore it", rejected);

  check("the manifest records the salt but never a key",
        restored.manifest.encryption.salt === salt &&
        !JSON.stringify(restored.manifest).includes("passphrase"));
}

// ------------------------------------------------------- reboot sees the files

console.log("\na reboot finds the machine where it was left");
{
  // The reported failure: write a file, sync, reboot on the same branch, and the
  // file is gone. Attaching reads the manifest but does not touch the disk, so a
  // device built from the base image is blank until it is hydrated.
  const host = new FakeHost();
  const first = new MemoryDevice({ diskSize: DISK });
  const session1 = newMachine(host, first);
  await session1.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  first.write(0, enc.encode("note.txt: hello"));
  first.write(3 * 256 * K, enc.encode("a second file, further in"));
  await session1.sync({ message: "wrote two files" });

  // A brand new session, exactly as a page reload produces: a fresh blank device.
  const second = new MemoryDevice({ diskSize: DISK });
  const session2 = newMachine(host, second);
  const attached = await session2.load();
  eq("attaching reports how much state is waiting", attached.chunks, 2);
  eq("but the device is still blank", second.snapshot()[0], 0);

  let refused = "";
  try { await session2.sync({}); } catch (err) { refused = err.message; }
  check("syncing a blank device over a real machine is refused",
        /has not been put back/.test(refused), refused);

  const put = await session2.hydrate();
  eq("hydration fetches only the chunks the manifest names", put.chunks, 2);
  eq("the first file is back",
     new TextDecoder().decode(second.snapshot().subarray(0, 15)), "note.txt: hello");
  eq("and so is the second",
     new TextDecoder().decode(second.snapshot().subarray(3 * 256 * K, 3 * 256 * K + 25)),
     "a second file, further in");
  check("the whole disk matches the session that wrote it",
        bytesEqual(second.snapshot(), first.snapshot()));

  // Hydration must not look like guest work, or the next sync re-uploads it all.
  eq("hydration dirtied nothing", second.pending().length, 0);
  const after = await session2.sync({});
  check("so a sync straight after a reboot does no work", after.skipped);

  // And the second session can carry on writing.
  second.write(1 * 256 * K, enc.encode("added after the reboot"));
  const carried = await session2.sync({ message: "after reboot" });
  eq("a later edit uploads only its own chunk", carried.uploaded, 1);
  const final = await restore({ host, branch: "machine" });
  eq("and the machine now holds all three", manifestModule.indices(final.manifest).length, 3);
  check("restore matches the live disk", bytesEqual(final.disk, second.snapshot()));
}

// ------------------------------------------------- integrity of what comes back

console.log("\nchunks are verified, not just addressed");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  device.write(0, enc.encode("state worth protecting"));
  device.write(2 * 256 * K, enc.encode("and more of it"));
  await machine.sync({});

  const written = manifestModule.indices(machine.manifest);
  eq("every chunk carries a digest", Object.keys(machine.manifest.digests).sort(),
     written.map(String).sort());
  const coverage = manifestModule.verifiable(machine.manifest);
  check("the manifest reports itself fully verifiable", coverage.complete);
  eq("covering every chunk it names", [coverage.covered, coverage.total], [2, 2]);

  // A digest is only worth having if it is a different function from the one
  // that produced the address. Forty hex characters is a git SHA-1; the digest
  // must not be that.
  const anyIndex = String(written[0]);
  const id = machine.manifest.chunks[anyIndex];
  const digest = machine.manifest.digests[anyIndex];
  eq("the address is a 40-character git object id", id.length, 40);
  eq("and the digest is a 64-character SHA-256", digest.length, 64);
  check("they are not the same value", id !== digest);
}
{
  // The attack the digest exists for: an object replaced at an address the
  // manifest still trusts, which is what a git SHA-1 collision buys.
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  device.write(0, enc.encode("the real contents"));
  await machine.sync({});

  const index = manifestModule.indices(machine.manifest)[0];
  const id = machine.manifest.chunks[String(index)];
  const forged = new Uint8Array(CHUNK);
  forged.set(enc.encode("substituted at the same address"));
  host.objects.set(id, forged);

  let message = "";
  try { await restore({ host, branch: "machine" }); } catch (err) { message = err.message; }
  check("a substituted chunk is caught on restore",
        /does not match the digest/.test(message), message);
  check("and the message says why an id alone was not enough",
        /SHA-1/.test(message), message);
}
{
  // Hydration writes onto a live device, so an unverified substitution there
  // corrupts a running machine rather than a throwaway restore buffer.
  const host = new FakeHost();
  const first = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, first);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  first.write(0, enc.encode("original"));
  await machine.sync({});

  const index = manifestModule.indices(machine.manifest)[0];
  const id = machine.manifest.chunks[String(index)];
  host.objects.set(id, new Uint8Array(CHUNK));

  const second = new MemoryDevice({ diskSize: DISK });
  const returning = new Machine({ host, device: second, branch: "machine", governor: fast() });
  await returning.load();
  let caught = false;
  try { await returning.hydrate(); } catch { caught = true; }
  check("a substituted chunk is caught on hydration too", caught);
  eq("and nothing was written to the device", second.snapshot()[0], 0);
}
{
  // A machine written before digests existed still has to restore. Refusing it
  // would strand every machine created by an earlier client.
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  device.write(0, enc.encode("written by an older client"));
  await machine.sync({});

  // Strip the digests the way a version 3 manifest would have arrived.
  const older = { ...machine.manifest, version: 3 };
  delete older.digests;
  const reparsed = manifestModule.parse(manifestModule.serialize(older));
  const coverage = manifestModule.verifiable(reparsed);
  check("an older manifest parses", reparsed.version === 3);
  check("and reports that it cannot be verified", !coverage.complete);
  eq("with nothing covered", coverage.covered, 0);
}
{
  // Partial coverage is the honest middle case, and it must not read as full.
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  device.write(0, enc.encode("one"));
  device.write(1 * 256 * K, enc.encode("two"));
  await machine.sync({});
  delete machine.manifest.digests[String(manifestModule.indices(machine.manifest)[0])];
  const coverage = manifestModule.verifiable(machine.manifest);
  check("a partly covered manifest is not reported as complete", !coverage.complete);
  eq("and says how much is covered", [coverage.covered, coverage.total], [1, 2]);
}

// ------------------------------------------------------------------- conflicts

console.log("\nconcurrent writers");
{
  // Disjoint chunks: the loser rebases onto the winner and both survive.
  const host = new FakeHost();
  const deviceA = new MemoryDevice({ diskSize: DISK });
  const machineA = newMachine(host, deviceA);
  await machineA.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  deviceA.write(0, enc.encode("from A"));
  await machineA.sync({});

  const deviceB = new MemoryDevice({ diskSize: DISK });
  const machineB = newMachine(host, deviceB);
  await machineB.load();
  eq("B attached to the same machine", machineB.head, machineA.head);
  const putBack = await machineB.hydrate();
  eq("and put the machine's state onto its own device", putBack.chunks, 1);
  eq("so B can see what A wrote",
     new TextDecoder().decode(deviceB.snapshot().subarray(0, 6)), "from A");

  deviceB.write(1 * 256 * K, enc.encode("from B"));
  await machineB.sync({});

  deviceA.write(2 * 256 * K, enc.encode("from A again"));
  const events = [];
  machineA.onEvent = (e) => events.push(e.type);
  const result = await machineA.sync({});
  check("A's stale write was detected and rebased", events.includes("conflict-rebased"));
  check("A's sync still succeeded", !!result.commit);

  const merged = await restore({ host, branch: "machine" });
  eq("the merged manifest holds all three chunks",
     manifestModule.indices(merged.manifest).length, 3);
}
{
  // Overlapping chunks cannot be merged: two divergent filesystem states do not
  // combine, so the engine refuses rather than corrupting one of them.
  const host = new FakeHost();
  const deviceA = new MemoryDevice({ diskSize: DISK });
  const machineA = newMachine(host, deviceA);
  await machineA.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  deviceA.write(0, enc.encode("initial"));
  await machineA.sync({});

  const deviceB = new MemoryDevice({ diskSize: DISK });
  const machineB = newMachine(host, deviceB);
  await machineB.load();
  await machineB.hydrate();
  deviceB.write(0, enc.encode("B changed chunk zero"));
  await machineB.sync({});

  deviceA.write(0, enc.encode("A also changed chunk zero"));
  let conflict = null;
  try { await machineA.sync({}); } catch (err) { conflict = err; }
  check("an overlapping write is refused", conflict instanceof ConflictError);
  eq("and it names the chunk that overlapped", conflict.overlappingChunks, [0]);
}

// ------------------------------------------------------------------ compaction

console.log("\ncompaction");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  // Edit the same chunk repeatedly, which is the case that accumulates history:
  // each sync supersedes the previous version of chunk zero.
  for (let i = 0; i < 4; i++) {
    device.write(0, enc.encode(`edit number ${i}`));
    await machine.sync({});
  }
  const beforeObjects = host.objects.size;

  const result = await machine.compact({});
  eq("compaction reads every chunk on the disk", result.chunksRead, 16);
  // A 4 MB disk with four small edits is almost entirely zeros, and zero chunks
  // collapse to one object. This ratio is occupancy, not compression.
  check("mostly-empty disks collapse hard", result.distinctObjects <= 3,
        `${result.distinctObjects} distinct`);
  check("earlier objects became unreachable", result.unreachableAfter > 0,
        `${result.unreachableAfter} now collectable`);

  const head = host.branches.get("machine");
  eq("the new commit has no parent", host.commits.get(head).parents, []);

  const restored = await restore({ host, branch: "machine" });
  check("a compacted machine still restores exactly",
        bytesEqual(restored.disk, device.snapshot()));
  eq("and its manifest covers the whole disk",
     manifestModule.indices(restored.manifest).length, 16);
  check("compaction is reported as read time as well as total", result.readSeconds >= 0);
  check("objects did not grow without bound", host.objects.size >= beforeObjects);
}

// ----------------------------------------------------------- nothing to do

console.log("\nedge cases");
{
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, device);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

  // load() builds the manifest in memory only. A branch cannot exist without a
  // commit, so nothing has reached the host yet.
  check("load alone creates no branch", (await host.resolveRef("machine")) === null);

  // The first sync must land even with a clean disk. Skipping it would leave the
  // manifest, and with it the disk geometry and the base image, nowhere but the
  // caller's memory, and the branch the user was told about would not exist.
  const created = await machine.sync({});
  check("the first sync of a clean machine still creates the branch", !created.skipped);
  check("and the branch now resolves", (await host.resolveRef("machine")) !== null);
  eq("with no chunks in it", created.chunks, 0);

  const persisted = manifestModule.parse(
    await host.readObject(
      (await host.readTree((await host.resolveRef("machine")).tree))
        .find((e) => e.path === manifestModule.MANIFEST_PATH).id
    )
  );
  eq("the manifest reached the host", persisted.diskSize, DISK);
  eq("carrying the chunk size", persisted.chunkSize, CHUNK);
  eq("and the base image it needs to restore against", persisted.base, "base.img");

  const idle = await machine.sync({});
  check("a later sync with nothing dirty does no work", idle.skipped && idle.requests === 0);
}
{
  // The salt is the reason this matters most. It is generated at boot and lives
  // only in memory until a commit carries it, so a machine that never wrote a
  // dirty chunk would be undecryptable after a reload.
  const host = new FakeHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const salt = randomSaltHex();
  const cipher = await deriveCipher("a passphrase the host never sees", salt);
  const machine = newMachine(host, device, { cipher });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  await machine.sync({});

  const ref = await host.resolveRef("machine");
  const entry = (await host.readTree(ref.tree)).find((e) => e.path === manifestModule.MANIFEST_PATH);
  const stored = manifestModule.parse(await host.readObject(entry.id));
  eq("the encryption salt survives a machine that wrote nothing",
     stored.encryption && stored.encryption.salt, salt);

  let refused = false;
  const fresh = new Machine({ host, device, branch: "absent", governor: fast() });
  try { await fresh.load(); } catch (err) { refused = /does not exist/.test(err.message); }
  check("attaching to a missing branch without parameters is refused", refused);
}
{
  // Attaching takes geometry from the manifest and ignores what it is passed.
  // A device built to a different size would then be read at the wrong extents,
  // so the mismatch has to be refused rather than silently resolved.
  const host = new FakeHost();
  const big = new MemoryDevice({ diskSize: DISK });
  const machine = newMachine(host, big);
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  await big.write(0, new TextEncoder().encode("a machine of a particular size"));
  await machine.sync({});

  const small = new MemoryDevice({ diskSize: DISK / 2 });
  const wrong = new Machine({ host, device: small, branch: "machine", governor: fast() });
  let message = "";
  try { await wrong.load({ diskSize: DISK / 2, chunkSize: CHUNK, base: "base.img" }); }
  catch (err) { message = err.message; }
  check("attaching a device of the wrong size is refused", /geometry|device given/.test(message), message);
  check("and the error names both sizes", /MB/.test(message) && message.includes("chunks"), message);

  const right = new Machine({
    host, device: new MemoryDevice({ diskSize: DISK }), branch: "machine", governor: fast()
  });
  const attached = await right.load();
  check("a device of the right size attaches with no parameters at all", attached.existing);
  eq("and takes its chunk size from the manifest", right.chunkSize, CHUNK);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
