// Record what a real workload writes, so chunk size can be swept offline.
//
// The trace is the write ranges the device captured, nothing else. It is small:
// unpacking a distribution moves megabytes but the range log for it is a few
// kilobytes, because the wrapper records extents rather than payloads.
//
// One run gives every chunk size, because dirtyChunks is a pure function of the
// trace and the guest writes the same bytes whatever the sync engine does with
// them afterwards.
//
//   const t = await import("./demo-trace.js"); const trace = await t.main();
//   copy(JSON.stringify(trace));            // then paste into traces/

import { Machine } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { Terminal } from "../src/ui/terminal.js";
import { MemoryHost } from "./demo-loop.js";
import { makeRunner } from "../src/guest/runner.js";
import * as fs from "../src/guest/fs.js";
import * as alpine from "../src/guest/alpine.js";

/**
 * Write the trace so far somewhere it can be recovered.
 *
 * Kept on window for a console to read and in localStorage so it survives a
 * reload, because the runs that failed here failed at the end.
 */
function publish(phases, diskSize, workload) {
  const trace = {
    label: workload,
    diskSize,
    capturedAt: new Date().toISOString(),
    guest: "buildroot 4.16.13 i686",
    partial: true,
    phases: phases.map((p) => ({ label: p.label, ranges: p.ranges.length })),
    ranges: phases.flatMap((p) => p.ranges)
  };
  const json = JSON.stringify(trace);
  window.__trace = trace;
  window.__traceJson = json;
  try { localStorage.setItem("trace.partial", json); } catch { /* quota or private mode */ }
}

const V86_ROOT = "../spike-c";
const ROOTFS_NAME = "alpine-minirootfs-3.20.10-x86.tar.gz";
const BASE = `${V86_ROOT}/images/blank-256mb.img`;
const DISK_SIZE = 256 * 1024 * 1024;
const CAPTURE_CHUNK = 256 * 1024;   // only the device's read granularity
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keep the tab scheduled.
 *
 * A hidden tab has its timers clamped to about a second and is eventually frozen
 * altogether, which stalled three capture runs here. A running audio context
 * counts as activity, so the emulator keeps being stepped. The oscillator is
 * silent: gain is zero and nothing is audible.
 */
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

export async function main({ onStep = console.log, withVim = false, workload = "alpine" } = {}) {
  const log = onStep;
  const wake = keepAwake();
  const terminal = new Terminal(document.getElementById("term"));

  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 256 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    hda: { url: BASE, size: DISK_SIZE, async: true, fixed_chunk_size: CAPTURE_CHUNK },
    filesystem: {},
    autostart: true, disable_keyboard: true, disable_mouse: true
  });
  emulator.add_listener("serial0-output-byte", (b) => terminal.writeByte(b));

  const device = new V86Device({
    emulator, diskSize: DISK_SIZE, flush: serialFlush(emulator, { prompt: PROMPT })
  });
  await device.waitForDevice(60000);
  const host = new MemoryHost();
  const machine = new Machine({
    host, device, branch: "trace", governor: new Governor({ ratePerMin: 6e6 })
  });
  await machine.load({
    diskSize: DISK_SIZE, chunkSize: CAPTURE_CHUNK, base: BASE, baseIsBlank: true
  });
  device.start();

  const t0 = Date.now();
  while (!fs.atPrompt(terminal.tail)) {
    if (Date.now() - t0 > 240000) throw new Error("no shell prompt");
    await sleep(200);
  }
  log(`booted; writes during boot: ${device.stats.writes}`);

  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });

  const rootfs = new Uint8Array(await (await fetch(`/vendor/alpine/${ROOTFS_NAME}`)).arrayBuffer());
  emulator.create_file(ROOTFS_NAME, rootfs);

  // Mark the boundaries so the trace can be split by phase. Sealing returns the
  // epoch and starts a new one, which is exactly what a phase boundary is.
  const phases = [];
  const seal = (label) => {
    const ranges = device.seal().map((r) => ({ offset: r.offset, length: r.length }));
    phases.push({ label, ranges });
    log(`  ${label}: ${ranges.length} ranges`);
    // Publish as we go. A run that stops early is then still worth something,
    // which is the difference between losing an hour of capture and keeping it.
    publish(phases, DISK_SIZE, workload);
  };

  await fs.open(run, { allowFormat: true });
  seal("format and mount");

  if (workload === "files") {
    // A real filesystem write pattern without the cost of a distribution. Small
    // files scatter across inode tables and bitmaps; the large one is a
    // contiguous run. The chunk-size tradeoff lives between those two shapes, so
    // a trace wants both.
    await fs.rc(run, "mkdir -p /disk/many", 120000);
    for (let i = 0; i < 40; i++) {
      await fs.rc(run, `dd if=/dev/urandom of=/disk/many/f${i} bs=1k count=8 2>/dev/null`, 120000);
    }
    seal("forty small files");

    await fs.rc(run, "dd if=/dev/urandom of=/disk/big bs=1k count=6144 2>/dev/null", 300000);
    seal("one large file");

    // Rewriting in place is what a working machine mostly does, and it dirties
    // chunks without allocating new ones.
    for (let i = 0; i < 20; i++) {
      await fs.rc(run, `dd if=/dev/urandom of=/disk/many/f${i} bs=1k count=8 conv=notrunc 2>/dev/null`, 120000);
    }
    seal("rewrites in place");
  } else {
    await alpine.bootstrap(run, { name: ROOTFS_NAME, onStep: (s) => log(`  ${s.type}`) });
    seal("unpack alpine");
  }

  if (withVim) {
    const names = [
      "libncursesw-6.4_p20240420-r2.apk",
      "ncurses-terminfo-base-6.4_p20240420-r2.apk",
      "vim-9.1.0707-r0.apk",
      "vim-common-9.1.0707-r0.apk",
      "xxd-9.1.0707-r0.apk"
    ];
    for (const name of names) {
      const bytes = new Uint8Array(await (await fetch(`/vendor/alpine/packages/${name}`)).arrayBuffer());
      emulator.create_file(name, bytes);
    }
    await alpine.installPackages(run, { names, onStep: (s) => log(`  ${s.type}`) });
    seal("install vim");
  }

  // The flush is what turns page cache into disk writes, so it must happen
  // before the last seal or the trace is missing most of the work.
  //
  // Run it through the same runner as everything else rather than through the
  // device's flush strategy. Both end up sending sync to the guest, but this
  // path waits for an exit status the command cannot fake, and a trace capture
  // has no reason to exercise a second mechanism for the same thing.
  if (workload !== "files") await alpine.release_(run);
  const flushed = await fs.rc(run, "sync", 900000);
  if (!flushed.ok) throw new Error(`sync failed in the guest: ${flushed.output}`);
  seal("flush");

  wake();
  await emulator.destroy();
  device.detach();

  const all = phases.flatMap((p) => p.ranges);
  const trace = {
    label: workload === "files" ? "filesystem writes" : (withVim ? "alpine + vim" : "alpine"),
    diskSize: DISK_SIZE,
    capturedAt: new Date().toISOString(),
    guest: "buildroot 4.16.13 i686, alpine 3.20.10 on the disk",
    phases: phases.map((p) => ({ label: p.label, ranges: p.ranges.length })),
    ranges: all
  };
  log(`trace: ${all.length} ranges over ${DISK_SIZE / 1048576} MB`);
  return { trace, phases };
}
