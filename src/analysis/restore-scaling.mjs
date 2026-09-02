// Does restore cost depend on how long the machine has existed?
//
// The paper claims it does not: a commit's tree names every chunk the disk
// currently needs, so restoring reads the live set whatever the history length.
// That claim was argued from the commit shape and demonstrated over six syncs,
// which is not enough to be convincing, and it is the central property the
// design trades requests for.
//
// This runs the loop for many syncs against a host that counts every request,
// measures the real cost of restoring at each step, and reports it against both
// history length and live set size. It also computes what the same workload
// would cost a design that replays its history instead, which is the shape most
// deduplicated backup stores have.
//
// No network and no browser: the engine, an in-memory device, and a host that
// keeps objects in a Map. Seeded, so the numbers are reproducible.
//
// Run with: node src/analysis/restore-scaling.mjs [syncs]

import { Machine, restore } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import * as manifestModule from "../core/manifest.js";

const K = 1024;
const DISK = 64 * 1024 * K;      // 64 MB
const CHUNK = 256 * K;           // 256 chunks
const SYNCS = Number(process.argv[2] || 120);

// A machine is not written uniformly. Most syncs touch a small working set that
// is rewritten over and over, and occasionally something new is allocated.
//
// The run is deliberately in two halves. In the first the disk grows, so both
// the live set and the history rise together and nothing can be concluded from
// their correlation. In the second nothing new is allocated and existing chunks
// are only rewritten, which holds the live set still while the history and the
// repository keep growing. That second half is where the claim either shows or
// fails: bounded restore predicts a flat line, growth-with-history predicts a
// rising one, and the two are no longer confounded.
const HOT_CHUNKS = 12;
const WRITES_PER_SYNC = 4;
const NEW_CHUNK_CHANCE = 0.25;

/** Seeded generator, so a reported number can be reproduced. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class CountingHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e9 };
  }
  constructor() {
    this.objects = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.requestCount = 0;
    this.governor = null;
    this.uploadedBytes = 0;
    this._n = 0;
  }
  async resolveRef(branch) {
    this.requestCount++;
    const head = this.branches.get(branch);
    return head ? { commit: head, tree: this.commits.get(head).tree } : null;
  }
  async readTree(tree) {
    this.requestCount++;
    return this.trees.get(tree).map((e) => ({ path: e.path, id: e.id, size: 0 }));
  }
  async readObject(id) {
    this.requestCount++;
    if (!this.objects.has(id)) throw new Error(`object ${id} missing`);
    return this.objects.get(id);
  }
  async commit({ branch, files, parent = null, orphan = false }) {
    let requests = 0;
    for (const f of files) {
      if (f.skipUpload) continue;
      this.objects.set(f.id, f.bytes);
      this.uploadedBytes += f.bytes.length;
      requests++;
    }
    const tree = `t${++this._n}`;
    this.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
    const commit = `c${++this._n}`;
    this.commits.set(commit, { tree, parents: orphan || !parent ? [] : [parent] });
    const current = this.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      const err = new Error("not a fast forward");
      err.status = 422;
      throw err;
    }
    this.branches.set(branch, commit);
    requests += 3;
    this.requestCount += requests;
    return { commit, requests };
  }
}

const random = rng(20260830);
const host = new CountingHost();
const device = new MemoryDevice({ diskSize: DISK });
const machine = new Machine({
  host, device, branch: "scaling",
  governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
});
await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "base.img", baseIsBlank: true });

const totalChunks = Math.ceil(DISK / CHUNK);
const allocated = [];
const rows = [];
let dirtyEver = 0;   // every chunk write across all syncs, which a replaying design must reapply

const encoder = new TextEncoder();

for (let n = 1; n <= SYNCS; n++) {
  // Second half: the disk stops growing and is only rewritten.
  const growing = n <= Math.floor(SYNCS / 2);
  for (let w = 0; w < WRITES_PER_SYNC; w++) {
    let index;
    if (allocated.length < HOT_CHUNKS || (growing && random() < NEW_CHUNK_CHANCE)) {
      index = Math.floor(random() * totalChunks);
      if (!allocated.includes(index)) allocated.push(index);
    } else {
      index = allocated[Math.floor(random() * allocated.length)];
    }
    // Content differs every time, so nothing deduplicates by accident and the
    // measurement is not quietly flattered by repeated bytes.
    device.write(index * CHUNK, encoder.encode(`sync ${n} write ${w} ${random()}`));
    dirtyEver++;
  }

  await machine.sync({ message: `sync ${n}` });

  const before = host.requestCount;
  const restored = await restore({ host, branch: "scaling" });
  const restoreRequests = host.requestCount - before;

  rows.push({
    sync: n,
    history: n,
    liveChunks: manifestModule.indices(machine.manifest).length,
    distinctObjects: manifestModule.distinctObjects(machine.manifest).size,
    restoreRequests,
    restoreObjects: restored.fromApi,
    objectsInRepo: host.objects.size,
    replayWrites: dirtyEver
  });
}

// --- report ------------------------------------------------------------------

const show = [1, 2, 5, 10, 20, 40, 60, 80, 100, SYNCS].filter((n) => n <= SYNCS);
const seen = new Set();

console.log(`\nrestore cost against history, ${SYNCS} syncs on a ` +
            `${DISK / 1048576} MB machine with ${CHUNK / 1024} KB chunks\n`);
console.log("  sync   live chunks   restore reqs   objects in repo   replay writes");
for (const n of show) {
  if (seen.has(n)) continue;
  seen.add(n);
  const r = rows[n - 1];
  console.log(
    `  ${String(r.sync).padStart(4)}   ${String(r.liveChunks).padStart(11)}   ` +
    `${String(r.restoreRequests).padStart(12)}   ${String(r.objectsInRepo).padStart(15)}   ` +
    `${String(r.replayWrites).padStart(13)}`
  );
}

const mid = Math.floor(SYNCS / 2);
const saturated = rows.slice(mid);          // the half where nothing new is allocated
const overhead = new Set(rows.map((r) => r.restoreRequests - r.liveChunks));
const restoreSpread = new Set(saturated.map((r) => r.restoreRequests));
const liveSpread = new Set(saturated.map((r) => r.liveChunks));

const first = rows[0];
const last = rows[SYNCS - 1];
const atMid = rows[mid];

console.log(`\n  restore requests minus live chunks, every sync: ` +
            `${[...overhead].join(", ")}`);
console.log(`\n  over the saturated half, syncs ${atMid.sync} to ${last.sync}:`);
console.log(`    history grew          ${atMid.history} to ${last.history} commits`);
console.log(`    repository grew       ${atMid.objectsInRepo} to ${last.objectsInRepo} objects`);
console.log(`    a replaying design    ${atMid.replayWrites} to ${last.replayWrites} writes to reapply`);
console.log(`    live set held at      ${[...liveSpread].join(", ")} chunks`);
console.log(`    restore cost held at  ${[...restoreSpread].join(", ")} requests`);

// The claim, stated so that it can fail.
const constantOverhead = overhead.size === 1;
const flatWhenSaturated = restoreSpread.size === 1 && liveSpread.size === 1;
const historyGrew = last.objectsInRepo > atMid.objectsInRepo * 1.5;
const replayWouldGrow = last.replayWrites > last.liveChunks * 3;

console.log("\n  restore cost is the live set plus a constant:   " + (constantOverhead ? "yes" : "NO"));
console.log("  flat while the history kept growing:           " +
            (flatWhenSaturated && historyGrew ? "yes" : "NO"));
console.log("  a replaying design would have grown instead:    " + (replayWouldGrow ? "yes" : "no"));
const flat = constantOverhead;
const historyIndependent = flatWhenSaturated && historyGrew;

// --- LaTeX -------------------------------------------------------------------

console.log("\n--- LaTeX ---\n");
const body = show.map((n) => {
  const r = rows[n - 1];
  return `${r.sync} & ${r.liveChunks} & ${r.restoreRequests} & ${r.objectsInRepo} & ${r.replayWrites} \\\\`;
}).join("\n");
console.log(`\\begin{tabular}{rrrrr}
\\toprule
sync & live chunks & restore requests & objects in repo & replayed writes \\\\
\\midrule
${body}
\\bottomrule
\\end{tabular}`);

process.exit(flat && historyIndependent ? 0 : 1);
