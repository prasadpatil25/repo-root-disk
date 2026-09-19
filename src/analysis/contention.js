// Writers racing to sync one machine.
//
// Algorithm 3 rebases a sync that lost the reference race when the two
// epochs touched disjoint chunks, and refuses it when they overlap. Two
// writers were measured on every host; what happens with more is a question
// the paper had not asked. With N writers starting from one parent, N-1 lose
// the first race, and each rebase is a new race among those still standing,
// so a writer can lose N-1 times. A budget of one rebase, which is what the
// engine shipped with, therefore aborts writers who merely lost; a budget of
// N-1 lands everyone at a request cost that grows with N squared.
//
// This module runs that race in process against a host with GitHub's
// reference semantics (fast-forward only, refused with 422), through the real
// engine, and classifies every attempt. Each writer has its own host instance
// so its requests are counted separately; the instances share one store, so
// the reference they race for is one reference.

import { Machine, ConflictError, isLostRace } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { rng } from "./baselines.js";

// ---------------------------------------------------------------- the host

/** The store every writer's host shares. */
export class SharedRepository {
  constructor() {
    this.objects = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.counter = 0;
    this.commitsAccepted = 0;
    this.commitsRefused = 0;
  }
  id(prefix) { return `${prefix}${++this.counter}`; }
}

/**
 * One writer's view of the shared repository: GitHub-shaped, one request per
 * uploaded object plus tree, commit and reference, and a reference update that
 * is refused unless its parent is the current head.
 */
export class CasHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e9 };
  }
  constructor(shared) {
    this.shared = shared;
    this.requestCount = 0;
    this.governor = null;
  }
  async resolveRef(branch) {
    this.requestCount++;
    const head = this.shared.branches.get(branch);
    return head ? { commit: head, tree: this.shared.commits.get(head).tree } : null;
  }
  async readTree(tree) {
    this.requestCount++;
    return this.shared.trees.get(tree).map((e) => ({ path: e.path, id: e.id, size: 0 }));
  }
  async readObject(id) {
    this.requestCount++;
    if (!this.shared.objects.has(id)) throw new Error(`object ${id} not found`);
    return this.shared.objects.get(id);
  }
  async commit({ branch, message, files, parent = null, orphan = false }) {
    const s = this.shared;
    for (const f of files) {
      if (f.skipUpload) continue;
      this.requestCount++;
      s.objects.set(f.id, f.bytes);
    }
    this.requestCount++;
    const tree = s.id("tree");
    s.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
    this.requestCount++;
    const commit = s.id("commit");
    s.commits.set(commit, { tree, parents: orphan || !parent ? [] : [parent], message });
    this.requestCount++;
    // The compare-and-swap. Nothing awaits between the read and the write, so
    // it is atomic here as it is on the service.
    const current = s.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      s.commitsRefused++;
      const err = new Error("Update is not a fast forward");
      err.status = 422;
      throw err;
    }
    s.commitsAccepted++;
    s.branches.set(branch, commit);
    return { commit };
  }
}

// ---------------------------------------------------------------- the plan

/**
 * Which chunks each writer dirties in a round.
 *
 * Every writer owns a range of the disk; with probability `overlapChance`
 * a write goes to a small hot region every writer shares instead. Two
 * writers whose sets meet in the hot region cannot both land, which is the
 * refusal path; writers whose sets stay in their own ranges can all land, one
 * rebase per lost race.
 */
export function roundPlan({ writers, chunksPerWriter, totalChunks, overlapChance, random, hot = 4 }) {
  const usable = totalChunks - hot;
  const stride = Math.floor(usable / writers);
  if (stride < chunksPerWriter) throw new Error("disk too small for the writers to have disjoint ranges");
  return Array.from({ length: writers }, (_, w) => {
    const set = new Set();
    while (set.size < chunksPerWriter) {
      if (random() < overlapChance) set.add(Math.floor(random() * hot));
      else set.add(hot + w * stride + Math.floor(random() * stride));
    }
    return [...set].sort((a, b) => a - b);
  });
}

/** Whether two writers' sets share a chunk, which is what refusal turns on. */
export function overlaps(a, b) {
  const s = new Set(a);
  return b.some((i) => s.has(i));
}

// ------------------------------------------------------------- the race

const isLost = isLostRace;

/**
 * One round's race: every writer syncs at once, and each attempt is classified.
 *
 * `team` is a list of {i, host, machine, events}, where `events` collects the
 * machine's event types and is cleared here. Works against the in-process host
 * and against a real service alike, which is what makes the two comparable.
 */
export async function race(team, { round, retries }) {
  for (const w of team) w.events.length = 0;
  return Promise.all(team.map(async (w) => {
    const before = w.host.requestCount;
    const started = Date.now();
    try {
      const res = await w.machine.sync({ message: `round ${round} writer ${w.i}`, retryOnConflict: retries });
      const rebases = w.events.filter((e) => e === "conflict-rebased").length;
      return { writer: w.i, outcome: rebases ? "rebased" : "first", rebases,
        requests: w.host.requestCount - before, ms: Date.now() - started, commit: res.commit };
    } catch (err) {
      const rebases = w.events.filter((e) => e === "conflict-rebased").length;
      const outcome = err instanceof ConflictError ? "refused" : isLost(err) ? "aborted" : null;
      if (!outcome) throw err;
      return { writer: w.i, outcome, rebases,
        requests: w.host.requestCount - before, ms: Date.now() - started, commit: null };
    }
  }));
}

/** Fold a list of outcomes into the tally. */
export function tallyOutcomes(tally, outcomes) {
  for (const o of outcomes) {
    tally.attempts++;
    tally[o.outcome]++;
    tally.rebases += o.rebases;
    tally.requests += o.requests;
    if (!o.commit) tally.wasted += o.requests;
  }
  return tally;
}

export const emptyTally = () => ({ first: 0, rebased: 0, refused: 0, aborted: 0, attempts: 0, rebases: 0, requests: 0, wasted: 0 });

/**
 * Run the race.
 *
 * @param {Object} o
 * @param {number} o.writers
 * @param {number} o.rounds
 * @param {number} [o.diskSize]
 * @param {number} [o.chunkSize]
 * @param {number} [o.chunksPerWriter]
 * @param {number} [o.overlapChance]   0 for disjoint sets
 * @param {boolean|number} [o.retries] the rebase budget handed to sync()
 * @param {number} [o.seed]
 * @returns {Promise<{tally: Object, rounds: Object[], requests: number, wasted: number}>}
 */
export async function simulate({
  writers, rounds, diskSize = 64 * 1024 * 1024, chunkSize = 256 * 1024,
  chunksPerWriter = 4, overlapChance = 0, retries = true, seed = 7, onRound = () => {}
}) {
  const random = rng(seed);
  const shared = new SharedRepository();
  const branch = "machine";
  const totalChunks = Math.ceil(diskSize / chunkSize);
  const fast = () => new Governor({ ratePerMin: 6e6, concurrency: 8 });
  const encoder = new TextEncoder();

  const team = Array.from({ length: writers }, (_, i) => {
    const host = new CasHost(shared);
    const device = new MemoryDevice({ diskSize });
    const events = [];
    const machine = new Machine({ host, device, branch, governor: fast(), onEvent: (e) => events.push(e.type) });
    return { i, host, device, machine, events };
  });

  // Writer 0 establishes the machine.
  await team[0].machine.load({ diskSize, chunkSize, base: "blank", baseIsBlank: true });
  team[0].device.write(0, encoder.encode("seed"));
  await team[0].machine.sync({ message: "seed" });

  const tally = emptyTally();
  const log = [];

  for (let r = 1; r <= rounds; r++) {
    // Everyone attaches to the same head, then writes, then races.
    for (const w of team) {
      await w.machine.load();
      w.machine.markHydrated();
    }
    const plan = roundPlan({ writers, chunksPerWriter, totalChunks, overlapChance, random });
    plan.forEach((indices, i) => {
      for (const index of indices) {
        team[i].device.write(index * chunkSize, encoder.encode(`round ${r} writer ${i} chunk ${index} ${random()}`));
      }
    });

    const outcomes = await race(team, { round: r, retries });

    tallyOutcomes(tally, outcomes);
    const row = { round: r, plan, outcomes };
    log.push(row);
    onRound(row);
  }

  const landed = tally.first + tally.rebased;
  return {
    tally, rounds: log, requests: tally.requests, wasted: tally.wasted,
    landed,
    requestsPerLanded: landed ? tally.requests / landed : null,
    headCommits: shared.commitsAccepted
  };
}
