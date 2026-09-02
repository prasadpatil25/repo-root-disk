// Finding the sync that broke a machine.
//
// This exists because of a property the design already has rather than one added
// for it. Every commit names the complete state of the disk, and restoring any
// of them costs the live set plus three requests whatever its age. So the states
// in a machine's history are all equally reachable, and binary search over them
// is affordable: sixty syncs is six boots, not sixty.
//
// Nothing else in the related work can do this. A store that reconstructs by
// replaying its history pays more for older states than newer ones, which makes
// searching backwards progressively more expensive; a store that versions the
// recipe for an environment rather than its state has nothing to boot.
//
// The test is supplied by the caller and receives a reconstructed disk. It
// answers one question: is this state good? Bisect assumes the answer is
// monotone, good then bad, which is the same assumption git bisect makes and the
// same one that makes it useful rather than exhaustive.

import { restore } from "./machine.js";

/**
 * @typedef {Object} BisectResult
 * @property {string|null} lastGood   newest commit the test accepted
 * @property {string|null} firstBad   oldest commit the test rejected
 * @property {number} probes          states actually reconstructed
 * @property {number} candidates      states searched over
 */

/**
 * Search a machine's history for the transition from good to bad.
 *
 * @param {Object} options
 * @param {Object} options.host
 * @param {string} options.branch
 * @param {(disk: Uint8Array, info: Object) => Promise<boolean>|boolean} options.test
 * @param {number} [options.limit] how far back to look
 * @param {(event: Object) => void} [options.onStep]
 * @returns {Promise<BisectResult>}
 */
export async function bisect({
  host, branch, test, limit = 200, cipher, fetchBase, onStep = () => {}
}) {
  if (typeof test !== "function") throw new Error("a test function is required");

  const log = await host.history(branch, { limit });
  if (!log.length) throw new Error(`${branch} has no history to search`);

  // Oldest first, so the boundary being searched for is a rising edge.
  const commits = [...log].reverse();
  onStep({ type: "searching", candidates: commits.length });

  let probes = 0;
  const evaluate = async (position) => {
    const entry = commits[position];
    const { tree } = await host.readCommit(entry.commit);
    const state = await restore({
      host, commit: entry.commit, tree, cipher, fetchBase
    });
    probes++;
    const good = await test(state.disk, {
      commit: entry.commit, message: entry.message, sync: state.manifest.sync
    });
    onStep({ type: "probe", commit: entry.commit, sync: state.manifest.sync, good });
    return good;
  };

  // The endpoints decide whether there is a boundary at all. Checking them first
  // costs two probes and avoids reporting a transition that is not there.
  if (!(await evaluate(0))) {
    onStep({ type: "no-good-state" });
    return { lastGood: null, firstBad: commits[0].commit, probes, candidates: commits.length };
  }
  if (await evaluate(commits.length - 1)) {
    onStep({ type: "never-broke" });
    return {
      lastGood: commits[commits.length - 1].commit, firstBad: null,
      probes, candidates: commits.length
    };
  }

  // Invariant: commits[low] is good and commits[high] is bad, and they narrow.
  let low = 0;
  let high = commits.length - 1;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (await evaluate(mid)) low = mid;
    else high = mid;
  }

  onStep({ type: "found", firstBad: commits[high].commit, probes });
  return {
    lastGood: commits[low].commit,
    firstBad: commits[high].commit,
    probes,
    candidates: commits.length
  };
}
