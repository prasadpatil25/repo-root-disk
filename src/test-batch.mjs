// Tests for the batch-commit experiment.
//
// The harness spends a real rate-limit budget against a real account, so its
// logic is worth settling here first. The test that matters is the last pair: a
// harness that could not tell an N+3 host from a batch-commit host would produce
// a confident verdict either way and be worthless. Both shapes are simulated and
// the verdict is checked against each.
//
// Run with: node src/test-batch.mjs

import {
  classifyRefusal, dirty, findCeiling, latex, measure, schedule, summarise,
  verdict, wireBytes
} from "./analysis/batch.js";
import { Machine } from "./core/machine.js";
import { MemoryDevice } from "./device/memory.js";
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

const CHUNK = 256 * 1024;
const DISK = 16 * 1024 * 1024;

/**
 * A host whose request accounting is configurable, so both API shapes the paper
 * compares can be simulated. `maxBody` refuses a commit whose base64 payload
 * exceeds it, which is the body-size ceiling the experiment looks for.
 */
class ShapedHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: true, maxBodyBytes: 1e9 };
  }
  static requestsPerCommit(n) { return n + 3; }
  constructor({ perCommit, maxBody = Infinity }) {
    this.objects = new Map(); this.trees = new Map(); this.commits = new Map();
    this.branches = new Map(); this.requestCount = 0; this.governor = null; this._n = 0;
    this._perCommit = perCommit; this._maxBody = maxBody;
  }
  async resolveRef(b) {
    const head = this.branches.get(b);
    return head ? { commit: head, tree: this.commits.get(head).tree } : null;
  }
  async readTree(t) { return this.trees.get(t).map((e) => ({ path: e.path, id: e.id, size: 0 })); }
  async readObject(id) { return this.objects.get(id); }
  async commit({ branch, files, parent = null, orphan = false }) {
    const uploaded = files.filter((f) => !f.skipUpload);
    const body = uploaded.reduce((n, f) => n + f.bytes.length, 0) * 4 / 3;
    if (body > this._maxBody) {
      const err = new Error("request body is too large");
      err.status = 413;
      throw err;
    }
    for (const f of uploaded) this.objects.set(f.id, f.bytes);
    const tree = `t${++this._n}`;
    this.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
    const commit = `c${++this._n}`;
    this.commits.set(commit, { tree, parents: orphan || !parent ? [] : [parent] });
    const current = this.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      const e = new Error("not a fast forward"); e.status = 422; throw e;
    }
    this.branches.set(branch, commit);
    const requests = this._perCommit(uploaded.length);
    this.requestCount += requests;
    return { commit, requests };
  }
}

async function build(host) {
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = new Machine({
    host, device, branch: "probe",
    governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
  });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "blank", baseIsBlank: true });
  machine.markHydrated();
  await machine.sync({ message: "establish" });
  return { machine, device };
}

// -------------------------------------------------------------- the schedule

console.log("\nthe trial schedule");
{
  const plan = schedule({ sizes: [1, 2, 4], rounds: 2 });
  eq("one entry per size per round, plus a warm-up round", plan.length, 9);
  eq("the first round is the warm-up", plan.slice(0, 3).map((p) => p.warmup),
     [true, true, true]);
  eq("and the rest are not", plan.slice(3).every((p) => p.warmup === false), true);

  // Interleaving is the point. Grouped runs charge connection setup to whichever
  // size goes first, which inverted a latency curve for us once already.
  const firstRound = plan.slice(0, 3).map((p) => p.size);
  eq("sizes are interleaved, not grouped", firstRound, [1, 2, 4]);
  const sizesInOrder = plan.map((p) => p.size).join(",");
  check("so no size runs consecutively across the whole plan",
        !/(\d+),\1/.test(sizesInOrder), sizesInOrder);
}
{
  eq("base64 inflates by four thirds", wireBytes(3000), 4000);
  eq("and rounds", wireBytes(1), 1);
}

// ------------------------------------------------------------------- dirtying

console.log("\ndirtying chunks");
{
  const device = new MemoryDevice({ diskSize: DISK });
  dirty(device, 3, CHUNK);
  await device.flush();
  const ranges = device.pending();
  eq("one write per chunk asked for", ranges.length, 3);
  eq("landing in distinct chunks",
     ranges.map((r) => Math.floor(r.offset / CHUNK)), [0, 1, 2]);
}
{
  // Fixed content would deduplicate and never be uploaded, and the harness would
  // report a request economy belonging to dedup rather than to the commit shape.
  const a = new MemoryDevice({ diskSize: DISK });
  const b = new MemoryDevice({ diskSize: DISK });
  dirty(a, 1, CHUNK);
  dirty(b, 1, CHUNK);
  await a.flush(); await b.flush();
  const chunkA = await a.readChunk(0, CHUNK);
  const chunkB = await b.readChunk(0, CHUNK);
  check("two dirtyings differ, so nothing deduplicates by accident",
        !chunkA.every((v, i) => v === chunkB[i]));
}

// ----------------------------------------------------------- summarising

console.log("\nsummarising");
{
  const trials = [
    { size: 1, requests: 4, seconds: 1, bytes: 1e6 },
    { size: 1, requests: 6, seconds: 3, bytes: 1e6 },
    { size: 1, requests: 5, seconds: 2, bytes: 1e6 },
    { size: 2, requests: 7, seconds: 2, bytes: 2e6 }
  ];
  const rows = summarise(trials, [1, 2]);
  eq("a median rather than a mean, so one slow run cannot dominate",
     rows[0].requests, 5);
  eq("per-chunk cost is the comparison the paper turns on", rows[1].perChunk, 3.5);
  eq("throughput comes from the median pair", rows[1].mbs, 1);
  eq("a size with no trials is omitted", summarise(trials, [1, 2, 8]).length, 2);
}
{
  eq("equal request counts read as flat",
     verdict([{ requests: 1 }, { requests: 1 }, { requests: 1 }]), "flat");
  eq("rising request counts read as growth",
     verdict([{ requests: 4 }, { requests: 6 }]), "grows");
  eq("one row decides nothing", verdict([{ requests: 1 }]), "inconclusive");
}
{
  const out = latex([{ size: 4, requests: 7, perChunk: 1.75, seconds: 2, mbs: 1.5 }],
                    { host: "gitlab", diskMb: 64, chunkKb: 256, rounds: 3 });
  check("the table names the host it came from", /gitlab/.test(out));
  check("and is a complete tabular", /\\begin\{tabular\}[\s\S]*\\end\{tabular\}/.test(out));
  check("with the measured row in it", /4 & 7 & 1\.75/.test(out));
}

// ------------------------------------------ can it tell the two shapes apart?

console.log("\ntelling an N+3 host from a batch-commit host");
{
  const host = new ShapedHost({ perCommit: (n) => n + 3 });
  const { machine, device } = await build(host);
  const trials = await measure({
    machine, device, chunkSize: CHUNK, sizes: [1, 2, 4], rounds: 2
  });
  const rows = summarise(trials, [1, 2, 4]);
  eq("every non-warm-up trial is recorded", trials.length, 6);
  check("no warm-up leaks into the result", trials.every((t) => !t.warmup));
  eq("an N+3 host is reported as growing", verdict(rows), "grows");
  check("and its per-chunk cost falls as the batch grows",
        rows[0].perChunk > rows[2].perChunk,
        `${rows[0].perChunk} then ${rows[2].perChunk}`);
}
{
  const host = new ShapedHost({ perCommit: () => 1 });
  const { machine, device } = await build(host);
  const trials = await measure({
    machine, device, chunkSize: CHUNK, sizes: [1, 2, 4], rounds: 2
  });
  const rows = summarise(trials, [1, 2, 4]);
  eq("a batch-commit host is reported as flat", verdict(rows), "flat");
  eq("one request per sync however many chunks moved", rows[2].requests, 1);
  check("so per-chunk cost falls with the batch size", rows[2].perChunk === 0.25,
        String(rows[2].perChunk));
}

// ------------------------------------------------- and does it find the wall?

console.log("\nfinding the body-size ceiling");
{
  // Eight chunks of 256 KB base64 encode to roughly 2.8 MB, so a 2 MB limit
  // should refuse somewhere below that.
  const host = new ShapedHost({ perCommit: () => 1, maxBody: 2e6 });
  const { machine, device } = await build(host);
  const steps = [];
  const { largestOk, refusal } = await findCeiling({
    machine, device, chunkSize: CHUNK, from: 1, cap: 64,
    onStep: (s) => steps.push(s)
  });
  check("it committed something before the wall", largestOk >= 1, String(largestOk));
  check("it found a refusal", refusal !== null);
  eq("and reported the status the host gave", refusal && refusal.status, 413);
  check("the refusal is above the largest that worked", refusal.n > largestOk,
        `${refusal.n} vs ${largestOk}`);
  check("every step before the last succeeded",
        steps.slice(0, -1).every((s) => s.ok));
}
{
  // A host with no limit must not be reported as having one.
  const host = new ShapedHost({ perCommit: () => 1 });
  const { machine, device } = await build(host);
  const { largestOk, refusal } = await findCeiling({
    machine, device, chunkSize: CHUNK, from: 1, cap: 8
  });
  eq("an unbounded host reports no refusal", refusal, null);
  eq("having reached the cap it was given", largestOk, 8);
}

// ------------------------------------------------ why a host actually refused

console.log("\nclassifying a refusal");
{
  // GitHub's real numbers. It refused at 64 chunks on the per-blob endpoint,
  // where the payload was 22 MB in total but no single body exceeded 256 KB.
  // The harness originally called this a body-size ceiling, which it cannot be.
  const github = { n: 64, status: 400, message: "POST /git/blobs", wire: 22369621 };
  eq("a per-object host cannot hit a body-size ceiling",
     classifyRefusal(github, { maxBodyBytes: 104857600, batchCommit: false }), "other");

  // A batch host refused well below its declared limit is also not a size
  // refusal, whatever else it is.
  eq("nor does a batch host refused far below its limit",
     classifyRefusal({ n: 8, status: 500, wire: 2.8e6 },
                     { maxBodyBytes: 33554432, batchCommit: true }), "other");

  // What the prediction actually looks like when it holds.
  eq("a batch host refused near its declared limit is a size refusal",
     classifyRefusal({ n: 96, status: 413, wire: 33e6 },
                     { maxBodyBytes: 33554432, batchCommit: true }), "body-size");
  eq("and at half of it, which is close enough to call",
     classifyRefusal({ n: 48, status: 413, wire: 17e6 },
                     { maxBodyBytes: 33554432, batchCommit: true }), "body-size");

  // Our own guard, which is what actually stopped the 128-chunk run. A service
  // refusal always carries an HTTP status; ours never does. Reading this as the
  // service's limit measures a constant we chose, which is what the harness did
  // on its first run against a real ceiling.
  eq("a refusal with no status is our own guard, not the service",
     classifyRefusal({ n: 128, status: null, wire: 44.7e6,
                       message: "batch commit body is about 42.7 MB" },
                     { maxBodyBytes: 33554432, batchCommit: true }), "client-guard");
  eq("even when the size would otherwise look like a body-size refusal",
     classifyRefusal({ n: 128, status: undefined, wire: 44.7e6 },
                     { maxBodyBytes: 33554432, batchCommit: true }), "client-guard");
  eq("a service refusal at the same size is a body-size refusal",
     classifyRefusal({ n: 128, status: 413, wire: 44.7e6 },
                     { maxBodyBytes: 33554432, batchCommit: true }), "body-size");
  eq("no refusal classifies as nothing", classifyRefusal(null, { batchCommit: true }), null);
  eq("a host that declares no limit cannot be judged against one",
     classifyRefusal({ n: 8, status: 500, wire: 1e6 },
                     { maxBodyBytes: null, batchCommit: true }), "other");
}
{
  // The size that was attempted has to be recorded, or there is nothing to
  // classify against.
  const host = new ShapedHost({ perCommit: () => 1, maxBody: 2e6 });
  const { machine, device } = await build(host);
  const { refusal } = await findCeiling({
    machine, device, chunkSize: CHUNK, from: 1, cap: 64
  });
  check("a refusal records the payload size it was carrying",
        refusal.wire === wireBytes(refusal.n * CHUNK),
        `${refusal.wire} for ${refusal.n} chunks`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
