// The emulator's own persistence, measured on the same machine as ours.
//
// Two questions a reader of the browser-machine comparison will ask, both
// answerable without leaving v86, so that every difference is the storage
// design and none of it the emulator:
//
//   1. What does the interception wrapper cost the guest? Writes through the
//      device with the wrapper attached and detached, interleaved so that
//      JIT warm-up and page cache state fall on both sides equally.
//
//   2. What does v86's native snapshot cost, and what does it give? save_state
//      is what every v86-based site uses to persist a machine: one blob, held
//      in IndexedDB or handed to the user as a file. Its size, the time to
//      take it, to put it in IndexedDB, to get it back and to restore from it,
//      on the machine the captured history ends at.
//
// Serve the project with `python serve.py`, open /app/, and from the console:
//
//   const m = await import("./demo-native.js");
//   m.main({ onStep: (s) => console.log("[native] " + s) });
//
// Results land in traces/history/native.json.

import { V86Device, serialFlush } from "../src/device/v86.js";
import { Terminal } from "../src/ui/terminal.js";
import { makeRunner } from "../src/guest/runner.js";
import * as fs from "../src/guest/fs.js";
import * as alpine from "../src/guest/alpine.js";
import { sessionSteps } from "./demo-history.js";

const V86_ROOT = "../spike-c";
const ROOTFS_NAME = "alpine-minirootfs-3.20.10-x86.tar.gz";
const PACKAGES = [
  "libncursesw-6.4_p20240420-r2.apk",
  "ncurses-terminfo-base-6.4_p20240420-r2.apk",
  "vim-9.1.0707-r0.apk",
  "vim-common-9.1.0707-r0.apk",
  "xxd-9.1.0707-r0.apk"
];
const BASE = `${V86_ROOT}/images/blank-256mb.img`;
const DISK_SIZE = 256 * 1024 * 1024;
const CHUNK = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function keepAwake() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    return () => { try { osc.stop(); ctx.close(); } catch { /* already gone */ } };
  } catch {
    return () => {};
  }
}

async function upload(name, body) {
  const r = await fetch(`/traces/history/${name}`, { method: "PUT", body });
  if (!r.ok) throw new Error(`upload of ${name} refused: ${r.status}`);
}

// IndexedDB, the way a site would hold a snapshot.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("native-snapshot-probe", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("states");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("states", mode);
    const req = fn(tx.objectStore("states"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function main({ onStep = console.log, overheadRounds = 7, snapshotRounds = 3, persist = false } = {}) {
  const log = onStep;
  const wake = keepAwake();
  const terminal = new Terminal(document.getElementById("term"));

  const bootStart = performance.now();
  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 256 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    hda: { url: BASE, size: DISK_SIZE, async: true, fixed_chunk_size: CHUNK },
    filesystem: {},
    autostart: true, disable_keyboard: true, disable_mouse: true
  });
  emulator.add_listener("serial0-output-byte", (b) => terminal.writeByte(b));

  const attach = async () => {
    const d = new V86Device({
      emulator, diskSize: DISK_SIZE, flush: serialFlush(emulator, { prompt: PROMPT })
    });
    await d.waitForDevice(60000);
    d.start();
    return d;
  };
  let device = await attach();

  while (!fs.atPrompt(terminal.tail)) {
    if (performance.now() - bootStart > 240000) throw new Error("no shell prompt");
    await sleep(200);
  }
  const bootMs = performance.now() - bootStart;
  log(`booted in ${(bootMs / 1000).toFixed(1)} s`);

  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });

  const results = {
    label: "v86 native persistence on the captured history's machine",
    guest: "buildroot 4.16.13 i686, alpine 3.20.10 on the disk",
    memory: 256 * 1024 * 1024, diskSize: DISK_SIZE, chunkSize: CHUNK,
    capturedAt: new Date().toISOString(),
    bootMs
  };
  window.__native = results;

  await fs.open(run, { allowFormat: true });

  // ------------------------------------------------ 1. wrapper overhead
  // 96 MB of zeros through the block device, then sync, timed from the host
  // around the whole command: large enough that the serial runner's 120 ms
  // poll is well under one percent of a measurement. The order alternates
  // each round so neither side gets the warm JIT more often than the other.
  const WRITE = "dd if=/dev/zero of=/disk/tp bs=1M count=96 2>/dev/null && sync && rm -f /disk/tp && sync";
  const overhead = { attached: [], detached: [], mb: 96 };
  await fs.rc(run, WRITE, 300000);   // one warm-up, discarded
  for (let r = 0; r < overheadRounds; r++) {
    const order = r % 2 ? ["detached", "attached"] : ["attached", "detached"];
    for (const mode of order) {
      if (mode === "detached") { if (device) { device.detach(); device = null; } }
      else if (!device) device = await attach();
      const t0 = performance.now();
      const res = await fs.rc(run, WRITE, 300000);
      const ms = performance.now() - t0;
      if (!res.ok) throw new Error(`write round failed: ${res.output.slice(-200)}`);
      overhead[mode].push(ms);
      log(`  ${mode.padEnd(8)} round ${r + 1}: ${(ms / 1000).toFixed(2)} s`);
    }
  }
  if (!device) device = await attach();
  results.overhead = {
    ...overhead,
    medianAttachedMs: median(overhead.attached),
    medianDetachedMs: median(overhead.detached)
  };
  log(`overhead: attached ${(results.overhead.medianAttachedMs / 1000).toFixed(2)} s, ` +
      `detached ${(results.overhead.medianDetachedMs / 1000).toFixed(2)} s (medians of ${overheadRounds})`);
  await upload("native.json", JSON.stringify(results, null, 1));

  // ------------------------------------------------ 2. the same machine
  const rootfs = new Uint8Array(await (await fetch(`/vendor/alpine/${ROOTFS_NAME}`)).arrayBuffer());
  emulator.create_file(ROOTFS_NAME, rootfs);
  await alpine.bootstrap(run, { name: ROOTFS_NAME, onStep: (s) => log(`  ${s.type}`) });
  for (const name of PACKAGES) {
    const bytes = new Uint8Array(await (await fetch(`/vendor/alpine/packages/${name}`)).arrayBuffer());
    emulator.create_file(name, bytes);
  }
  await alpine.installPackages(run, { names: PACKAGES, onStep: (s) => log(`  ${s.type}`) });
  const steps = sessionSteps();
  for (const step of steps) {
    for (const command of step.commands) {
      const r = await alpine.inside(run, command, { timeoutMs: 300000 });
      if (!r.ok) log(`  (${step.label}) failed, continuing`);
    }
  }
  await alpine.release_(run);
  const flushed = await fs.rc(run, "sync", 300000);
  if (!flushed.ok) throw new Error("sync failed in the guest");
  log(`machine built: ${steps.length} session steps, ${device.stats.writes} device writes, ` +
      `${(device.stats.bytes / 1048576).toFixed(1)} MB written`);
  results.session = { steps: steps.length, deviceWrites: device.stats.writes, deviceBytes: device.stats.bytes };

  // ------------------------------------------------ 3. the native snapshot
  // Each step is bounded, so a hang names itself instead of stalling the run.
  const bounded = (label, promise, ms = 180000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms / 1000} s`)), ms))
  ]);
  // The IndexedDB round trip is off by default: on a nearly full disk a
  // 440 MB put takes minutes, which measures the disk, not the snapshot.
  const db = persist ? await bounded("indexedDB open", openDb()) : null;
  const snapshot = { rounds: [], persisted: persist };
  for (let r = 0; r < snapshotRounds; r++) {
    log(`  snapshot ${r + 1}: saving`);
    let t0 = performance.now();
    const state = await bounded("save_state", emulator.save_state());
    const saveMs = performance.now() - t0;
    log(`  snapshot ${r + 1}: ${(state.byteLength / 1048576).toFixed(1)} MB in ${(saveMs / 1000).toFixed(2)} s; putting`);

    let putMs = null, getMs = null, back = state;
    if (db) {
      t0 = performance.now();
      await bounded("indexedDB put", idb(db, "readwrite", (store) => store.put(state, "state")));
      putMs = performance.now() - t0;
      log(`  snapshot ${r + 1}: put in ${(putMs / 1000).toFixed(2)} s; getting`);
      t0 = performance.now();
      back = await bounded("indexedDB get", idb(db, "readonly", (store) => store.get("state")));
      getMs = performance.now() - t0;
    }

    // Restore into the stopped emulator, as a page would on load, then
    // prove the machine is alive by running a command.
    await bounded("stop", emulator.stop());
    t0 = performance.now();
    await bounded("restore_state", emulator.restore_state(back));
    const restoreMs = performance.now() - t0;
    emulator.run();
    terminal.resetTail();
    const alive = await fs.rc(run, "echo alive", 60000);

    snapshot.rounds.push({ bytes: state.byteLength, saveMs, putMs, getMs, restoreMs, alive: alive.ok });
    log(`  snapshot ${r + 1}: ${(state.byteLength / 1048576).toFixed(1)} MB, save ${(saveMs / 1000).toFixed(2)} s, ` +
        (db ? `put ${(putMs / 1000).toFixed(2)} s, get ${(getMs / 1000).toFixed(2)} s, ` : "") +
        `restore ${(restoreMs / 1000).toFixed(2)} s, alive ${alive.ok}`);
  }
  if (db) { await idb(db, "readwrite", (store) => store.delete("state")); db.close(); }
  snapshot.bytes = snapshot.rounds[0].bytes;
  for (const k of db ? ["saveMs", "putMs", "getMs", "restoreMs"] : ["saveMs", "restoreMs"]) {
    snapshot["median" + k[0].toUpperCase() + k.slice(1)] = median(snapshot.rounds.map((x) => x[k]));
  }
  results.snapshot = snapshot;
  results.finishedAt = new Date().toISOString();
  await upload("native.json", JSON.stringify(results, null, 1));

  wake();
  await emulator.destroy();
  if (device) device.detach();
  log("done");
  return results;
}
