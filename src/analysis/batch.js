// The batch-commit experiment, separated from the network.
//
// The CLI in batch-commit.mjs drives a real repository; everything decided here
// is decided the same way whether the host is real or counting in process, which
// is what lets the logic be tested before anyone spends a rate-limit budget on
// it. The measurement is the sync engine's own reported cost, so this module
// schedules, records and summarises rather than instrumenting anything.

/**
 * The order trials run in.
 *
 * Interleaved rather than grouped, and the first round is discarded. Running
 * every trial of one size together charges connection setup and TLS to whichever
 * size went first, which in an earlier experiment of ours inverted a latency
 * curve outright. The schedule is the whole fix and it costs one extra round.
 *
 * @param {{sizes: number[], rounds: number}} options
 */
export function schedule({ sizes, rounds }) {
  const out = [];
  for (let round = 0; round <= rounds; round++) {
    for (const size of sizes) out.push({ round, size, warmup: round === 0 });
  }
  return out;
}

/**
 * What a JSON API actually carries. The engine reports payload bytes; base64
 * inflates them by four thirds, and that inflation is what the body-size
 * prediction turns on.
 */
export function wireBytes(payloadBytes) {
  return Math.round(payloadBytes * 4 / 3);
}

/**
 * Dirty n chunks with content that cannot deduplicate.
 *
 * Random bytes matter here. Repeated content is caught by the local dedup probe
 * and never uploaded, and the harness would then report a request economy that
 * belongs to deduplication rather than to the commit shape.
 */
export function dirty(device, n, chunkSize, random = Math.random) {
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(4096);
    for (let b = 0; b < bytes.length; b++) bytes[b] = (random() * 256) | 0;
    device.write(i * chunkSize, bytes);
  }
}

/**
 * Run the trials. Returns one record per non-warm-up sync.
 *
 * @param {Object} options
 * @param {import("../core/machine.js").Machine} options.machine
 * @param {Object} options.device
 * @param {number} options.chunkSize
 * @param {number[]} options.sizes
 * @param {number} options.rounds
 * @param {(row: Object) => void} [options.onTrial]
 */
export async function measure({
  machine, device, chunkSize, sizes, rounds, onTrial = () => {}, random
}) {
  const trials = [];
  for (const trial of schedule({ sizes, rounds })) {
    dirty(device, trial.size, chunkSize, random);
    const result = await machine.sync({ message: `batch probe: ${trial.size} chunks` });
    // A sync with nothing dirty is skipped by design, and a skipped sync is not
    // a measurement of anything.
    if (result.skipped) continue;

    const row = {
      size: trial.size,
      warmup: trial.warmup,
      requests: result.requests,
      seconds: result.seconds,
      bytes: result.bytesUploaded,
      wire: wireBytes(result.bytesUploaded)
    };
    onTrial(row);
    if (!trial.warmup) trials.push(row);
  }
  return trials;
}

/**
 * Push the chunk count up until the host refuses.
 *
 * On a host that spends a request per chunk this only gets slower. On a
 * batch-commit host the whole sync is one body, so this is where the constraint
 * is expected to reappear as a size limit.
 */
export async function findCeiling({
  machine, device, chunkSize, from, cap, onStep = () => {}, random
}) {
  let largestOk = 0;
  for (let n = from; n <= cap; n *= 2) {
    dirty(device, n, chunkSize, random);
    try {
      const result = await machine.sync({ message: `batch probe: ceiling ${n}` });
      largestOk = n;
      onStep({ n, ok: true, seconds: result.seconds, wire: wireBytes(result.bytesUploaded) });
    } catch (err) {
      // The size that was attempted, so the refusal can be classified rather
      // than assumed.
      const refusal = {
        n, status: err.status || null, message: err.message,
        wire: wireBytes(n * chunkSize)
      };
      onStep({ n, ok: false, ...refusal });
      return { largestOk, refusal };
    }
  }
  return { largestOk, refusal: null };
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Medians per size, plus the per-chunk cost the paper's comparison turns on. */
export function summarise(trials, sizes) {
  const rows = [];
  for (const size of sizes) {
    const group = trials.filter((t) => t.size === size);
    if (!group.length) continue;
    const requests = median(group.map((g) => g.requests));
    const seconds = median(group.map((g) => g.seconds));
    const bytes = median(group.map((g) => g.bytes));
    rows.push({
      size, requests, seconds, bytes,
      perChunk: requests / size,
      mbs: seconds > 0 ? bytes / 1e6 / seconds : 0
    });
  }
  return rows;
}

/**
 * Whether request count grew with the number of dirty chunks.
 *
 * This is the single claim the experiment exists to settle, so it is decided
 * here rather than left to whoever reads the table.
 */
export function verdict(rows) {
  if (rows.length < 2) return "inconclusive";
  return rows.every((r) => r.requests === rows[0].requests) ? "flat" : "grows";
}

/**
 * Why a host refused, judged from the evidence rather than assumed.
 *
 * The interesting prediction is that a batch commit runs into a body-size limit
 * where a per-object host runs into a request budget. But a host that uploads one
 * object per request never sends a large body at all, so a refusal there cannot
 * be a size refusal however convenient that reading would be. Confirming it means
 * showing the payload was actually near the limit the host declares.
 *
 * @returns {"client-guard"|"body-size"|"other"|null}
 */
export function classifyRefusal(refusal, { maxBodyBytes, batchCommit }) {
  if (!refusal) return null;
  // Our own guard, before anything was sent. A service refusal always carries an
  // HTTP status; ours never does. Reporting this as the service's limit is
  // circular, because the number it ran into is one we chose, and the first run
  // of this harness did exactly that.
  if (refusal.status == null) return "client-guard";
  if (!batchCommit) return "other";
  if (!maxBodyBytes || !refusal.wire) return "other";
  // Within a factor of two of the declared ceiling is close enough to call it;
  // an order of magnitude below it is not.
  return refusal.wire >= maxBodyBytes / 2 ? "body-size" : "other";
}

export function latex(rows, { host, diskMb, chunkKb, rounds }) {
  const lines = [
    `% ${host}, ${diskMb} MB disk, ${chunkKb} KB chunks, medians over ${rounds} rounds`,
    "\\begin{tabular}{@{}rrrrr@{}}",
    "\\toprule",
    "chunks & req/sync & req/chunk & s & MB/s \\\\",
    "\\midrule"
  ];
  for (const r of rows) {
    lines.push(`${r.size} & ${r.requests} & ${r.perChunk.toFixed(2)} & ` +
               `${r.seconds.toFixed(2)} & ${r.mbs.toFixed(2)} \\\\`);
  }
  lines.push("\\bottomrule", "\\end{tabular}");
  return lines.join("\n");
}
