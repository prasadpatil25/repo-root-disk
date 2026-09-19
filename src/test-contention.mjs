// Tests for the contention simulation.
//
// The simulation's claims rest on three things being right: that the shared
// host really refuses a stale parent, that the plan gives writers disjoint
// ranges unless told to overlap, and that the engine's own retry budget is
// what decides between a rebase and an abort. Each is pinned on a case whose
// answer is known before the grid is trusted.
//
// Run with: node src/test-contention.mjs

import { SharedRepository, CasHost, roundPlan, overlaps, simulate } from "./analysis/contention.js";
import { rng } from "./analysis/baselines.js";

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

console.log("\nthe shared host");
{
  const shared = new SharedRepository();
  const a = new CasHost(shared), b = new CasHost(shared);
  const file = (id) => [{ path: id, bytes: new Uint8Array(1), id }];
  const first = await a.commit({ branch: "m", message: "a", files: file("x"), parent: null, orphan: true });
  check("an orphan commit creates the branch", !!first.commit);
  const second = await b.commit({ branch: "m", message: "b", files: file("y"), parent: first.commit });
  check("a commit on the current head lands", !!second.commit);
  let err = null;
  try { await a.commit({ branch: "m", message: "stale", files: file("z"), parent: first.commit }); } catch (e) { err = e; }
  check("a commit on a stale parent is refused with 422", err && err.status === 422);
  eq("the refusal is counted", [shared.commitsAccepted, shared.commitsRefused], [2, 1]);
  eq("requests are counted per writer", [a.requestCount, b.requestCount], [8, 4]);
  check("and both see one reference", (await a.resolveRef("m")).commit === (await b.resolveRef("m")).commit);
}

console.log("\nthe plan");
{
  const random = rng(1);
  const plan = roundPlan({ writers: 4, chunksPerWriter: 4, totalChunks: 256, overlapChance: 0, random });
  eq("one set per writer", plan.length, 4);
  check("each set has the asked-for size", plan.every((p) => p.length === 4));
  check("with no overlap chance the sets are pairwise disjoint",
        plan.every((p, i) => plan.every((q, j) => i === j || !overlaps(p, q))));
  check("and none touch the hot region", plan.every((p) => p.every((i) => i >= 4)));
  const hot = roundPlan({ writers: 2, chunksPerWriter: 4, totalChunks: 256, overlapChance: 1, random, hot: 4 });
  check("with certain overlap every write is in the hot region", hot.every((p) => p.every((i) => i < 4)));
  check("overlaps() sees a shared chunk", overlaps([1, 2, 3], [3, 4]) && !overlaps([1, 2], [3, 4]));
  let err = null;
  try { roundPlan({ writers: 64, chunksPerWriter: 8, totalChunks: 64, overlapChance: 0, random }); } catch (e) { err = e; }
  check("a disk too small for disjoint ranges is refused", !!err);
}

console.log("\nthe race");
{
  const two = await simulate({ writers: 2, rounds: 4, retries: 1 });
  eq("two writers: one lands first and one rebases, every round",
     [two.tally.first, two.tally.rebased, two.tally.refused, two.tally.aborted], [4, 4, 0, 0]);
  eq("every landed sync advanced the head", two.headCommits, 1 + 8);
  check("no request was wasted", two.wasted === 0);

  const three = await simulate({ writers: 3, rounds: 6, retries: 1 });
  check("three writers with one rebase: some syncs abort after losing twice",
        three.tally.aborted > 0, JSON.stringify(three.tally));
  check("and every aborted sync's requests count as wasted", three.wasted > 0);

  const budget = await simulate({ writers: 3, rounds: 6, retries: 2 });
  eq("with a budget of two, nobody aborts", budget.tally.aborted, 0);
  eq("and every attempt lands", budget.landed, 18);

  const clash = await simulate({ writers: 2, rounds: 4, retries: 3, overlapChance: 1 });
  check("writers who touch the same chunks are refused, never merged",
        clash.tally.refused > 0 && clash.tally.rebased === 0, JSON.stringify(clash.tally));
  eq("a refusal is not an abort", clash.tally.aborted, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
