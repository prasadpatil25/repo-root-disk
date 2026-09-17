// Drive restic over a write plan and read its costs off the backend.
//
// Shared by restic-baseline.mjs, which runs the seeded synthetic plan, and
// replay-history.mjs, which runs a captured real one. Everything about restic
// that is not pure lives here: the rest-server process, the restic
// invocations, the image file the plan is materialised into, and the
// workspace they need. The measurement rule is the one the counting host
// applies to our own shapes: requests come from the server's access log and
// storage from its directory, never from restic's own reporting.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirBytes, findFile, materialise, sinceOffset, snapshotIdFrom, tally } from "./restic.js";

const K = 1024;
const MARKER = ".repo-root-disk-harness";

/** The first line a binary prints for its version, or null if it will not run. */
export function binaryVersion(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
}

/**
 * Remove a directory the harness made.
 *
 * A restored directory can carry attributes and an access control list that
 * make Node refuse to delete it, since restic reproduces both on Windows: take
 * full control and strip the attributes first.
 */
export function removeDir(path) {
  if (!existsSync(path)) return;
  if (process.platform === "win32") {
    const me = process.env.USERNAME || process.env.USER || "";
    if (me) spawnSync("icacls", [path, "/grant", `${me}:(OI)(CI)F`, "/T", "/C", "/Q"], { stdio: "ignore" });
    spawnSync("attrib", ["-R", "-S", "-H", join(path, "*"), "/S", "/D"], { stdio: "ignore" });
  }
  rmSync(path, { recursive: true, force: true });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Run restic over a plan.
 *
 * @param {Object} o
 * @param {Array<{sync: number, writes: Array<{index: number, bytes: Uint8Array}>}>} o.plan
 * @param {number} o.diskSize
 * @param {number} o.chunkSize
 * @param {Iterable<number>} o.measureAt   syncs at which restore is measured
 * @param {string} [o.restic]              binary, default "restic"
 * @param {string} [o.restServer]          binary, default "rest-server"
 * @param {string} [o.work]                workspace, default under the OS temp dir
 * @param {number} [o.port]
 * @param {boolean} [o.keep]               leave the workspace behind
 * @param {(row: Object) => void} [o.onSync]
 * @returns {Promise<{rows: Object[], repair: Object, after: Object, versions: Object}>}
 */
export async function runRestic({
  plan, diskSize, chunkSize, measureAt,
  restic: RESTIC = process.env.RESTIC_BIN || "restic",
  restServer: REST_SERVER = process.env.REST_SERVER_BIN || "rest-server",
  work: WORK = process.env.RESTIC_WORK || join(tmpdir(), "repo-root-disk-restic"),
  port: PORT = Number(process.env.PORT || 8765),
  keep = process.env.KEEP === "1",
  onSync = () => {}
}) {
  const versions = {
    restic: binaryVersion(RESTIC, ["version"]),
    restServer: binaryVersion(REST_SERVER, ["--version"])
  };
  if (!versions.restic || !versions.restServer) {
    const err = new Error(
      `restic: ${versions.restic || "not found (" + RESTIC + ")"}\n` +
      `rest-server: ${versions.restServer || "not found (" + REST_SERVER + ")"}\n` +
      `Both are single binaries. Put them on PATH or point RESTIC_BIN and REST_SERVER_BIN at them:\n` +
      `  https://github.com/restic/restic/releases\n  https://github.com/restic/rest-server/releases`);
    err.code = "ENOBIN";
    throw err;
  }

  // ---------------------------------------------------------- workspace
  const marker = join(WORK, MARKER);
  if (existsSync(WORK)) {
    if (!existsSync(marker)) throw new Error(`${WORK} exists and is not ours; set RESTIC_WORK elsewhere`);
    removeDir(WORK);
  }
  const REPO = join(WORK, "repo");
  const SRC = join(WORK, "src");
  const RESTORE = join(WORK, "restore");
  const CACHE = join(WORK, "cache");
  const LOG = join(WORK, "access.log");
  for (const d of [WORK, REPO, SRC, RESTORE, CACHE]) mkdirSync(d, { recursive: true });
  writeFileSync(marker, "created by src/analysis/restic-run.js\n");
  const IMAGE = join(SRC, "disk.img");
  // restic records absolute paths, and restoring a whole snapshot recreates
  // every parent directory under the target, including ones like C:\Users
  // whose attributes it cannot reproduce. Restoring the snapshot's src folder
  // gives just the image. It is named as restic names it: forward slashes,
  // and a drive letter as the first component.
  const SNAPSHOT_SRC = "/" + SRC.replace(/^([A-Za-z]):/, "$1").split("\\").join("/");

  // --------------------------------------------------------- rest-server
  const server = spawn(REST_SERVER, [
    "--path", REPO, "--no-auth", "--listen", `127.0.0.1:${PORT}`, "--log", LOG
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  let finished = false;
  server.stderr.on("data", (d) => { serverErr += d; });
  server.on("exit", (code) => {
    if (!finished) console.error(`rest-server exited early (${code})\n${serverErr}`);
  });
  const shutdown = () => { finished = true; try { server.kill(); } catch { /* gone */ } };
  const onInterrupt = () => { shutdown(); process.exit(130); };
  process.on("SIGINT", onInterrupt);

  const ENV = {
    ...process.env,
    RESTIC_REPOSITORY: `rest:http://127.0.0.1:${PORT}/`,
    RESTIC_PASSWORD: "baseline",
    RESTIC_CACHE_DIR: CACHE
  };
  const restic = (args, { allowFail = false } = {}) => {
    const t0 = Date.now();
    const r = spawnSync(RESTIC, args, { encoding: "utf8", env: ENV, maxBuffer: 256 * K * K });
    const seconds = (Date.now() - t0) / 1000;
    if (r.status !== 0 && !allowFail) {
      throw new Error(`restic ${args.join(" ")} failed (${r.status})\n${r.stderr}`);
    }
    return { ...r, seconds };
  };

  let logOffset = 0;
  const cost = () => {
    const text = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    const { entries, offset } = sinceOffset(text, logOffset);
    logOffset = offset;
    return tally(entries);
  };

  const restoreAndMeasure = (snapshot, label) => {
    removeDir(RESTORE);
    mkdirSync(RESTORE, { recursive: true });
    cost();
    const r = restic(["restore", `${snapshot}:${SNAPSHOT_SRC}`, "--target", RESTORE, "--no-cache", "--quiet"]);
    const c = cost();
    const restored = findFile(RESTORE, "disk.img");
    if (!restored || sha256(restored) !== sha256(IMAGE)) {
      throw new Error(`restore at ${label} did not reproduce the image`);
    }
    return { ...c, seconds: r.seconds };
  };

  const measureRow = (row, c) => {
    row.restoreRequests = c.requests;
    row.restoreBytes = c.bytes;
    row.restoreSeconds = c.seconds;
    row.restoreIndex = c.byType.index?.requests ?? 0;
    row.restoreData = c.byType.data?.requests ?? 0;
    row.restoreOther = c.requests - row.restoreIndex - row.restoreData;
    row.restoreByType = c.byType;
    return row;
  };

  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { /* not yet */ }
      if (i === 49) throw new Error("rest-server did not come up on port " + PORT);
      await new Promise((r) => setTimeout(r, 100));
    }

    restic(["init", "--repository-version", "2"]);
    cost();

    // An empty disk, like the blank base the other shapes start from.
    {
      const fd = openSync(IMAGE, "w");
      const zero = new Uint8Array(K * K);
      for (let off = 0; off < diskSize; off += zero.length) writeSync(fd, zero, 0, zero.length, off);
      closeSync(fd);
    }

    const at = new Set(measureAt);
    const rows = [];
    let uploadCumulative = 0;
    let lastSnapshot = null;
    let lastSync = 0;

    const fd = openSync(IMAGE, "r+");
    try {
      for (const step of plan) {
        materialise(fd, step.writes, chunkSize);
        cost();
        const b = restic(["backup", IMAGE, "--compression", "off", "--force", "--json"]);
        const up = cost();
        uploadCumulative += up.requests;
        const snapshot = snapshotIdFrom(b.stdout);
        if (!snapshot) throw new Error("no snapshot id in backup output");
        lastSnapshot = snapshot;
        lastSync = step.sync;

        const row = {
          sync: step.sync, phase: "backup",
          uploadRequests: up.requests, uploadRequestsCumulative: uploadCumulative,
          uploadSeconds: b.seconds,
          storageBytes: dirBytes(REPO),
          restoreRequests: null, restoreBytes: null, restoreSeconds: null,
          restoreIndex: null, restoreData: null, restoreOther: null
        };
        if (at.has(step.sync)) measureRow(row, restoreAndMeasure(snapshot, `sync ${step.sync}`));
        rows.push(row);
        onSync(row);
      }
    } finally {
      closeSync(fd);
    }

    // restic writes one index file per backup and loads every one on every
    // operation. `repair index` rewrites them, keeping every snapshot: the same
    // retention as ours, so the restore after it is comparable.
    cost();
    let repair = restic(["repair", "index"], { allowFail: true });
    if (repair.status !== 0) repair = restic(["rebuild-index"]);   // restic < 0.16
    const repairCost = cost();
    const after = restoreAndMeasure(lastSnapshot, "after index repair");
    const repaired = measureRow({
      sync: lastSync, phase: "repaired",
      uploadRequests: repairCost.requests,
      uploadRequestsCumulative: uploadCumulative + repairCost.requests,
      uploadSeconds: repair.seconds,
      storageBytes: dirBytes(REPO)
    }, after);
    rows.push(repaired);

    return {
      rows, versions,
      repair: { requests: repairCost.requests, seconds: repair.seconds },
      after: repaired,
      work: WORK
    };
  } finally {
    shutdown();
    process.off("SIGINT", onInterrupt);
    if (!keep) removeDir(WORK);
  }
}

/** The CSV columns every restic run writes. */
export const CSV_COLUMNS = ["sync", "phase", "uploadRequests", "uploadRequestsCumulative", "uploadSeconds",
  "storageBytes", "restoreRequests", "restoreBytes", "restoreSeconds",
  "restoreIndex", "restoreData", "restoreOther"];

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => r[c] ?? "").join(","));
  return lines.join("\n") + "\n";
}
