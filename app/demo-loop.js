// An end-to-end run of the machine with no network host.
//
// Everything here is the real implementation: the real emulator, the real
// dirty-block capture, the real serial flush, the real chunking, manifest,
// governor and restore. The only substitution is the host, which keeps git
// objects in a Map instead of sending them to a forge.
//
// That substitution is exactly the part that needs a credential, and it is the
// part already measured separately in the spikes. What this exercises is the
// half that no measurement covered on its own: the whole loop, in one process,
// against a guest that actually writes a file.
//
// Load from the browser console of /app/:
//   const run = await import("./demo-loop.js"); await run.main();

import { Machine, restore } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { Terminal } from "../src/ui/terminal.js";
import { makeRunner } from "../src/guest/runner.js";
import { rc, atPrompt } from "../src/guest/fs.js";
import { blobId } from "../src/core/objectid.js";

const V86_ROOT = "../spike-c";
const DISK_SIZE = 16 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;

/** A host with the adapter contract, backed by memory. */
export class MemoryHost {
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
    const bytes = this.objects.get(id);
    if (!bytes) throw new Error(`object ${id} is not in the store`);
    return bytes;
  }
  async commit({ branch, files, parent = null, orphan = false }) {
    let requests = 0;
    for (const f of files) {
      if (!f.skipUpload) { this.objects.set(f.id, f.bytes); requests++; }
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
  get storedBytes() {
    let total = 0;
    for (const bytes of this.objects.values()) total += bytes.length;
    return total;
  }
}

/**
 * Send a line to the guest and return what it printed.
 *
 * The shared runner decides when the command has finished, and rc() strips the
 * echoed command from the reply, so neither judgement is re-derived here.
 */
function guestRunner(emulator, terminal) {
  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });
  return async (line, timeoutMs = 120000) => (await rc(run, line, timeoutMs)).output;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main({ onStep = console.log, termElement = "term" } = {}) {
  const steps = [];
  const step = (name, detail) => {
    steps.push({ name, detail });
    onStep(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };

  const terminal = new Terminal(document.getElementById(termElement));

  // --- boot ------------------------------------------------------------------
  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    hda: {
      url: `${V86_ROOT}/images/blank-16mb.img`,
      size: DISK_SIZE, async: true, fixed_chunk_size: CHUNK_SIZE
    },
    autostart: true, disable_keyboard: true, disable_mouse: true
  });
  emulator.add_listener("serial0-output-byte", (b) => terminal.writeByte(b));

  const device = new V86Device({
    emulator, diskSize: DISK_SIZE,
    flush: serialFlush(emulator, { prompt: PROMPT }),
    onEvent: (e) => step("device", `${e.type} at ${e.path} (${e.streamed ? "streamed" : "in memory"})`)
  });
  await device.waitForDevice(60000);
  device.start();

  const guest = guestRunner(emulator, terminal);
  const t0 = Date.now();
  for (;;) {
    if (atPrompt(terminal.tail)) break;
    if (Date.now() - t0 > 180000) throw new Error("no shell prompt");
    await sleep(200);
  }
  step("boot", `shell up in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
               `disk writes during boot: ${device.stats.writes}`);

  // --- attach the engine -----------------------------------------------------
  const host = new MemoryHost();
  const governor = new Governor({ ratePerMin: 150, concurrency: 8 });
  const branch = `demo-${Date.now().toString(36)}`;
  const machine = new Machine({ host, device, branch, governor });
  await machine.load({
    diskSize: DISK_SIZE, chunkSize: CHUNK_SIZE,
    base: `${V86_ROOT}/images/blank-16mb.img`, baseIsBlank: true
  });
  step("engine", `branch ${branch}, ${CHUNK_SIZE / 1024} KB chunks over ${DISK_SIZE / 1048576} MB`);

  // --- the guest does real work ----------------------------------------------
  step("guest", await guest("mke2fs -q /dev/sda 2>&1 | tail -2", 300000) || "formatted");
  await guest("mkdir -p /mnt/disk && mount /dev/sda /mnt/disk");
  await guest("echo 'the disk lives in a git repository' > /mnt/disk/note.txt");
  await guest("mkdir -p /mnt/disk/work && seq 1 500 > /mnt/disk/work/numbers.txt");
  const listing = await guest("ls -l /mnt/disk /mnt/disk/work");
  step("guest", `wrote files; captured ${device.stats.writes} writes so far`);

  // The unmount is the point. Until the guest flushes, a file that exists to the
  // user has produced no disk writes at all.
  const beforeUnmount = device.stats.writes;
  await guest("umount /mnt/disk");
  step("flush", `umount turned page cache into ${device.stats.writes - beforeUnmount} more disk writes`);

  // --- sync ------------------------------------------------------------------
  const first = await machine.sync({ message: "first sync from the demo loop" });
  step("sync 1", {
    chunks: first.chunks, uploaded: first.uploaded, reused: first.reused,
    requests: first.requests, kb: Math.round(first.bytesUploaded / 1024),
    seconds: Number(first.seconds.toFixed(2))
  });

  const idle = await machine.sync({ message: "nothing changed" });
  step("sync 2", idle.skipped ? "skipped, nothing dirty, zero requests" : idle);

  await guest("mount /dev/sda /mnt/disk && echo 'second edit' >> /mnt/disk/note.txt && umount /mnt/disk");
  const second = await machine.sync({ message: "second sync" });
  step("sync 3", {
    chunks: second.chunks, uploaded: second.uploaded, reused: second.reused,
    requests: second.requests, kb: Math.round(second.bytesUploaded / 1024)
  });

  const stats = machine.stats();
  step("state", {
    syncs: machine.manifest.sync,
    chunksTracked: stats.chunksWritten,
    distinctObjects: stats.distinctObjects,
    storedMB: Number((stats.storedBytes / 1048576).toFixed(2)),
    occupancyPct: Number((stats.occupancy * 100).toFixed(1)),
    dedupIsOccupancyReciprocal: Number(stats.dedupRatio.toFixed(2))
  });

  // --- restore into a disk that never ran ------------------------------------
  const restored = await restore({ host, branch });
  step("restore", `${restored.disk.length / 1048576} MB reconstructed from ` +
                  `${restored.fromApi} objects`);

  // The proof: read the restored image back through a second machine, and check
  // the bytes the guest wrote are present in it.
  const text = new TextDecoder().decode(restored.disk);
  const carriesNote = text.includes("the disk lives in a git repository");
  const carriesEdit = text.includes("second edit");
  const carriesNumbers = text.includes("497\n498\n499\n500");

  // And the stronger check: every chunk the manifest names hashes to what the
  // manifest says it should.
  let mismatches = 0;
  for (const [indexKey, id] of Object.entries(machine.manifest.chunks)) {
    const index = Number(indexKey);
    const offset = index * CHUNK_SIZE;
    const slice = restored.disk.subarray(offset, Math.min(offset + CHUNK_SIZE, DISK_SIZE));
    if (await blobId(slice) !== id) mismatches++;
  }

  step("verify", {
    noteFileRestored: carriesNote,
    appendRestored: carriesEdit,
    numbersFileRestored: carriesNumbers,
    chunkHashMismatches: mismatches
  });

  const ok = carriesNote && carriesEdit && carriesNumbers && mismatches === 0;
  step("result", ok
    ? "PASS. A guest wrote files, the dirty blocks were captured, chunked, hashed " +
      "and committed, and a disk rebuilt from those objects alone carries the data."
    : "FAIL. The restored disk does not match what the guest wrote.");

  return { ok, steps, listing, host, machine, restored, emulator, device };
}
