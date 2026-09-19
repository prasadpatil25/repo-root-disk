// A captured history, synced to a real service one phase at a time.
//
//   GITLAB_TOKEN=... node src/analysis/replay-live.mjs gitlab owner/repo [traces/history-1gb]
//   GITHUB_TOKEN=... node src/analysis/replay-live.mjs github owner/repo [traces/history-1gb]
//
// restore-wallclock.mjs commits the machine a history ends at in one sync.
// This replays the history as it happened: every phase's writes go onto the
// device and are synced, so each of the 43 commits is a real commit on the
// service with its own request count and wall clock, and the branch carries
// the whole history. The machine is then restored eight-wide and checked byte
// for byte against the device. The branch is deleted at the end.
//
// The token comes from the environment and is never printed. Every writer's
// traffic is under one governor at RATE per minute.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost } from "../host/index.js";
import { Machine, restore } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { planFrom } from "./history.js";

const kind = process.argv[2];
const slug = process.argv[3];
const DIR = process.argv[4] || "traces/history-1gb";
if (!kind || !slug || !slug.includes("/")) {
  console.error("usage: <KIND>_TOKEN=... node src/analysis/replay-live.mjs <github|gitlab|forgejo> owner/repo [dir]");
  process.exit(2);
}
const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) { console.error(`set ${tokenVar} in the environment. It is never printed or stored.`); process.exit(2); }
const endpoint = process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined;
const num = (name, fallback) => Number(process.env[name] || fallback);
const RATE = num("RATE", 150);
const READ_RATE = num("READ_RATE", 800);
const K = 1024;
const mb = (b) => (b / K / K).toFixed(1);
const say = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);

const history = JSON.parse(readFileSync(join(DIR, "history.json"), "utf8"));
const { diskSize, chunkSize } = history;
const { plan, labels, haveBytes } = planFrom(history, (file) => {
  const path = join(DIR, file);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
});
if (!haveBytes) { console.error(`${DIR} lacks the phase-*.bin files`); process.exit(2); }

const [owner, repo] = slug.split("/");
const branch = `history-${Date.now().toString(36)}`;
const governor = new Governor({ ratePerMin: RATE, concurrency: 8, retries: num("RETRIES", 30) });
const host = createHost(kind, { token, owner, repo, endpoint, governor });
const reads = new Governor({ ratePerMin: READ_RATE, concurrency: 8, minConcurrency: 1, retries: num("RETRIES", 30) });
const rawRead = host.readObject.bind(host);
host.readObject = (id) => reads.write(() => rawRead(id));

console.log(`\nlive replay on ${kind}: ${history.label}\n`);
let created = false;
const rows = [];
try {
  const who = await host.validate();
  say("connected as", who.login);
  if (!who.canWrite) throw new Error("the token cannot write to this repository");

  const device = new MemoryDevice({ diskSize });
  const machine = new Machine({ host, device, branch, governor });
  await machine.load({ diskSize, chunkSize, base: "blank", baseIsBlank: true });

  const started = Date.now();
  for (const step of plan) {
    for (const w of step.writes) device.write(w.index * chunkSize, w.bytes);
    const r0 = host.requestCount;
    const t0 = Date.now();
    const r = await machine.sync({ message: `sync ${step.sync}: ${labels[step.sync - 1]}` });
    created = true;
    const row = { sync: step.sync, label: labels[step.sync - 1], chunks: r.chunks, uploaded: r.uploaded,
      requests: host.requestCount - r0, seconds: (Date.now() - t0) / 1000, bytesUploaded: r.bytesUploaded };
    rows.push(row);
    say(`sync ${String(step.sync).padStart(2)}`, `${String(row.chunks).padStart(4)} chunks  ${String(row.requests).padStart(5)} requests  ` +
        `${row.seconds.toFixed(1).padStart(7)} s  ${labels[step.sync - 1]}`);
  }
  const uploadSeconds = (Date.now() - started) / 1000;

  // The reference written a moment ago may not be readable yet.
  for (let waited = 0; ; waited += 2) {
    const ref = await host.resolveRef(branch);
    if (ref && ref.commit === machine.head) break;
    if (waited >= 120) throw new Error("the branch did not become readable within two minutes");
    await new Promise((r) => setTimeout(r, 2000));
  }

  const live = device.snapshot();
  const before = host.requestCount;
  const t0 = Date.now();
  const res = await restore({ host, branch, concurrency: 8 });
  const restoreSeconds = (Date.now() - t0) / 1000;
  const same = res.disk.length === live.length && Buffer.compare(res.disk, live) === 0;
  if (!same) throw new Error("the restored machine differs from the device");

  const totals = rows.reduce((a, r) => ({ requests: a.requests + r.requests, chunks: a.chunks + r.chunks, uploaded: a.uploaded + r.uploaded, bytes: a.bytes + r.bytesUploaded }),
    { requests: 0, chunks: 0, uploaded: 0, bytes: 0 });
  console.log(`\n  ${rows.length} syncs: ${totals.requests} requests, ${totals.uploaded} objects uploaded (${mb(totals.bytes)} MB), ` +
    `${(uploadSeconds / 60).toFixed(1)} min at ${RATE}/min`);
  say("restore, eight-wide", `${host.requestCount - before} requests, ${res.chunksApplied} chunks, ${restoreSeconds.toFixed(1)} s, byte-identical`);
  say("write refusals", `${governor.stats.refused}`);
  say("read refusals", `${reads.stats.refused}`);
  mkdirSync("traces", { recursive: true });
  const out = `traces/replay-live-${kind}-${diskSize / K / K}mb.json`;
  writeFileSync(out, JSON.stringify({ kind, slug, branch, rate: RATE, rows, totals, uploadSeconds,
    restore: { requests: host.requestCount - before, chunks: res.chunksApplied, seconds: restoreSeconds } }, null, 1) + "\n");
  console.log(`\n  wrote ${out}`);
} catch (err) {
  if (err.status === 404 && !created) {
    console.error(`\n  ${kind} cannot see ${slug} with this token.`);
    process.exit(2);
  }
  throw err;
} finally {
  if (created) {
    try { await host.deleteBranch(branch); say("deleted branch", branch); } catch (e) { say("branch not deleted", e.message); }
  }
}
