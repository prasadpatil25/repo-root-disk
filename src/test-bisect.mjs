// Tests for naming a state and for searching a machine's history.
//
// The claim bisect rests on is not that binary search works; it is that every
// state in the history costs the same to reconstruct, so searching backwards is
// affordable. The test that matters therefore counts probes: if reaching older
// states were more expensive, or if the search degraded to a scan, the number
// would show it.
//
// Run with: node src/test-bisect.mjs

import { Machine, restore } from "./core/machine.js";
import { bisect } from "./core/bisect.js";
import { MemoryDevice } from "./device/memory.js";
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

const K = 1024;
const DISK = 4 * 1024 * K;
const CHUNK = 256 * K;
const enc = new TextEncoder();

/** A host that also keeps commit parents, history and refs. */
class HistoryHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e9 };
  }
  constructor() {
    this.objects = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.refs = new Map();
    this.requestCount = 0;
    this.governor = null;
    this._n = 0;
  }
  async resolveRef(branch) {
    this.requestCount++;
    const head = this.branches.get(branch);
    return head ? { commit: head, tree: this.commits.get(head).tree } : null;
  }
  async readCommit(id) {
    this.requestCount++;
    const c = this.commits.get(id);
    if (!c) throw new Error(`commit ${id} not found`);
    return { commit: id, tree: c.tree, parents: c.parents, message: c.message };
  }
  async history(branch, { limit = 100 } = {}) {
    this.requestCount++;
    const out = [];
    let at = this.branches.get(branch) || null;
    while (at && out.length < limit) {
      const c = this.commits.get(at);
      out.push({ commit: at, message: c.message });
      at = c.parents[0] || null;
    }
    return out;                                   // newest first, as the real ones are
  }
  async createRef(ref, commit) {
    this.requestCount++;
    if (this.refs.has(ref)) throw new Error(`${ref} already exists`);
    this.refs.set(ref, commit);
    return ref;
  }
  async readTree(tree) {
    this.requestCount++;
    return this.trees.get(tree).map((e) => ({ path: e.path, id: e.id, size: 0 }));
  }
  async readObject(id) {
    this.requestCount++;
    if (!this.objects.has(id)) throw new Error(`object ${id} not found`);
    return this.objects.get(id);
  }
  async commit({ branch, message, files, parent = null, orphan = false }) {
    let requests = 0;
    for (const f of files) {
      if (f.skipUpload) continue;
      this.objects.set(f.id, f.bytes);
      requests++;
    }
    const tree = `t${++this._n}`;
    this.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
    const commit = `c${++this._n}`;
    this.commits.set(commit, {
      tree, parents: orphan || !parent ? [] : [parent], message: message || ""
    });
    const current = this.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      const err = new Error("not a fast forward");
      err.status = 422;
      throw err;
    }
    this.branches.set(branch, commit);
    this.requestCount += requests + 3;
    return { commit, requests: requests + 3 };
  }
}

const fast = () => new Governor({ ratePerMin: 6e6, concurrency: 8 });

/**
 * Build a machine whose disk holds a marker that goes bad at a known sync, so
 * the answer is known in advance and the search can be checked against it.
 */
async function buildHistory(syncs, breakAt) {
  const host = new HistoryHost();
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = new Machine({ host, device, branch: "m", governor: fast() });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  const commits = [];
  for (let n = 1; n <= syncs; n++) {
    device.write(0, enc.encode(n < breakAt ? `state ${n} HEALTHY   ` : `state ${n} FAULTY    `));
    // A second chunk moves every sync, so the machine is not trivially static.
    device.write(1 * CHUNK, enc.encode(`counter ${n} ${Math.random()}`));
    const r = await machine.sync({ message: `sync ${n}` });
    commits.push(r.commit);
  }
  return { host, device, machine, commits };
}

// The two markers must not be substrings of one another. An earlier version
// used OK and BROKEN, and BROKEN contains OK, so every faulty state read as
// healthy and the search correctly reported no boundary.
const readsOk = (disk) => new TextDecoder().decode(disk.subarray(0, 24)).includes("HEALTHY");

// ------------------------------------------------------------------- snapshot

console.log("\nnaming a state");
{
  const { host, machine, device } = await buildHistory(3, 99);
  const snap = await machine.snapshot("used-in-section-v");
  eq("the snapshot points at the current head", snap.commit, machine.head);
  eq("and is a tag reference", snap.ref, "refs/tags/used-in-section-v");
  eq("the host holds it", host.refs.get("refs/tags/used-in-section-v"), machine.head);

  // The state it names must still be reachable after the machine moves on.
  const before = machine.head;
  device.write(2 * CHUNK, enc.encode("work done after the snapshot"));
  await machine.sync({ message: "moved on" });
  check("the machine has moved", machine.head !== before);
  eq("but the snapshot has not", host.refs.get("refs/tags/used-in-section-v"), before);
}
{
  const host = new HistoryHost();
  const machine = new Machine({
    host, device: new MemoryDevice({ diskSize: DISK }), branch: "m", governor: fast()
  });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  let message = "";
  try { await machine.snapshot("early"); } catch (err) { message = err.message; }
  check("a machine with no commit cannot be named", /no commit to name/.test(message), message);
}
{
  const { machine } = await buildHistory(1, 99);
  let refused = false;
  try { await machine.snapshot("no spaces allowed"); } catch { refused = true; }
  check("a name that is not a usable reference is refused", refused);
}

// ------------------------------------------------------------------- pinning

console.log("\npinning a state to a digest the user holds");
{
  const { host, machine, commits } = await buildHistory(3, 99);
  const digest = machine.manifestDigest;
  check("a committed machine has a manifest digest", /^[0-9a-f]{64}$/.test(digest || ""), digest);

  const snap = await machine.snapshot("pinned");
  eq("a snapshot carries it, so a name is not trusted alone", snap.manifestDigest, digest);

  const ok = await restore({ host, branch: "m", manifestDigest: digest });
  eq("restoring with the right digest works", ok.manifest.sync, 3);

  let message = "";
  try {
    await restore({ host, branch: "m", manifestDigest: "0".repeat(64) });
  } catch (err) { message = err.message; }
  check("a wrong digest refuses the restore", /not the pinned/.test(message), message);
  check("and says nothing was written", /nothing has been written/.test(message), message);

  // Rollback. The host serves an older commit; without a pin this is undetectable,
  // because the older commit is a perfectly valid state of this machine.
  const stale = await restore({ host, commit: commits[0] });
  eq("an older state restores happily when nothing is pinned", stale.manifest.sync, 1);
  let refused = "";
  try {
    await restore({ host, commit: commits[0], manifestDigest: digest });
  } catch (err) { refused = err.message; }
  check("but a pin refuses it", /not the pinned/.test(refused), refused);
}
{
  // The digest must track the machine, or pinning would silently accept any
  // later state.
  const { machine, device } = await buildHistory(2, 99);
  const before = machine.manifestDigest;
  device.write(3 * CHUNK, enc.encode("more work"));
  await machine.sync({ message: "moved on" });
  check("the digest changes when the machine does", machine.manifestDigest !== before);
}
{
  const host = new HistoryHost();
  const machine = new Machine({
    host, device: new MemoryDevice({ diskSize: DISK }), branch: "m", governor: fast()
  });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });
  eq("a machine with no commit has no digest to give", machine.manifestDigest, null);
}

// ------------------------------------------------------- restoring any state

console.log("\nreaching a state that is not the newest");
{
  const { host, commits } = await buildHistory(5, 4);
  const newest = await restore({ host, branch: "m" });
  check("the branch gives the newest state",
        !readsOk(newest.disk), new TextDecoder().decode(newest.disk.subarray(0, 24)));

  const third = await restore({ host, commit: commits[2] });
  check("a commit gives that state instead", readsOk(third.disk),
        new TextDecoder().decode(third.disk.subarray(0, 24)));
  eq("with the manifest as it was then", third.manifest.sync, 3);
}

// --------------------------------------------------------------------- bisect

console.log("\nfinding the sync that broke it");
{
  const { host, commits } = await buildHistory(64, 40);
  const steps = [];
  const before = host.requestCount;
  const result = await bisect({
    host, branch: "m", test: readsOk, onStep: (s) => steps.push(s.type)
  });

  eq("it finds the first broken state", result.firstBad, commits[39]);
  eq("and the last good one before it", result.lastGood, commits[38]);
  eq("having searched the whole history", result.candidates, 64);

  // The claim. Every state costs the same to reconstruct, so the search is
  // logarithmic; a scan would be 64 and a design that replayed history would
  // make the older probes progressively dearer.
  const ceiling = Math.ceil(Math.log2(64)) + 2;
  check("with a logarithmic number of probes",
        result.probes <= ceiling, `${result.probes} probes, ceiling ${ceiling}`);
  check("far fewer than the states searched", result.probes < result.candidates / 4,
        `${result.probes} of ${result.candidates}`);
  check("and it reported finding a boundary", steps.includes("found"));

  const perProbe = (host.requestCount - before) / result.probes;
  check("each probe costs about the same", perProbe > 0 && perProbe < 20,
        `${perProbe.toFixed(1)} requests per probe`);
}
{
  const { host, commits } = await buildHistory(16, 99);   // never breaks
  const result = await bisect({ host, branch: "m", test: readsOk });
  eq("a machine that never broke reports no bad state", result.firstBad, null);
  eq("and names its newest state as good", result.lastGood, commits[15]);
}
{
  const { host, commits } = await buildHistory(16, 1);    // broken from the first
  const result = await bisect({ host, branch: "m", test: readsOk });
  eq("a machine broken from the start reports no good state", result.lastGood, null);
  eq("and names the oldest as bad", result.firstBad, commits[0]);
}
{
  const { host } = await buildHistory(8, 5);
  let message = "";
  try { await bisect({ host, branch: "m" }); } catch (err) { message = err.message; }
  check("a bisect without a test is refused", /test function is required/.test(message), message);

  let missing = "";
  try { await bisect({ host, branch: "nope", test: readsOk }); }
  catch (err) { missing = err.message; }
  check("a branch with no history is reported", /no history/.test(missing), missing);
}
{
  // The test sees the reconstructed disk and the commit it came from, so a
  // caller can report which sync to look at rather than only which commit.
  const { host } = await buildHistory(8, 5);
  const seen = [];
  await bisect({
    host, branch: "m",
    test: (disk, info) => { seen.push(info.sync); return readsOk(disk); }
  });
  check("the test is told which sync it is looking at",
        seen.every((n) => Number.isInteger(n) && n >= 1), JSON.stringify(seen));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
