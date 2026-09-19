// Record a real machine history, with the bytes, so every commit shape and
// restic can be run on it.
//
// demo-trace.js records extents, which is all the chunk-size sweep needs. The
// shape comparison in compare-baselines.mjs runs on a seeded synthetic plan,
// and restic's costs depend on content, so a real history needs the chunk
// payloads too. This script boots the real guest, formats the disk, unpacks
// Alpine, installs vim, then works on the machine for forty steps: the first
// twenty grow a project, the last twenty edit, append, rewrite and delete in
// place, with the editor used for some of the edits. Every step ends with a
// sync in the guest and a seal, which is one commit's worth of writes, and the
// dirty chunks of each phase go to the static server as one file.
//
// Serve the project with `python serve.py`, open /app/, and from the console:
//
//   const m = await import("./demo-history.js");
//   m.main({ onStep: (s) => console.log("[history] " + s) });
//
// Phases land in traces/history/, with history.json describing them. The JSON
// alone reproduces the three in-process shapes, since they count chunks; the
// .bin files carry the bytes restic needs.
//
// For the 1 GB machine:
//
//   m.main({ diskMb: 1024, workload: "corpus", dir: "history-1gb", onStep: ... });
//
// which uses an in-memory blank disk and a corpus workload that fills about
// half of it: eight directories of random files of 1 to 8 MB, archives of four
// of them with tar, two of those extracted again, then twenty steps that
// delete, rewrite in place, append, edit with vim and recreate. Start serve.py
// with CAPTURE_ROOT pointing at a drive with room; the payloads run to
// hundreds of megabytes.

import { V86Device, serialFlush } from "../src/device/v86.js";
import { Terminal } from "../src/ui/terminal.js";
import { makeRunner } from "../src/guest/runner.js";
import { dirtyChunks } from "../src/core/chunker.js";
import { packPhase } from "../src/analysis/history.js";
import * as fs from "../src/guest/fs.js";
import * as alpine from "../src/guest/alpine.js";

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
const CHUNK = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A hidden tab is throttled; a silent audio context keeps it scheduled. */
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

async function upload(dir, name, body) {
  const r = await fetch(`/traces/${dir}/${name}`, { method: "PUT", body });
  if (!r.ok) throw new Error(`upload of ${dir}/${name} refused: ${r.status}`);
}

/**
 * The working session, as commands run inside the distribution.
 *
 * Twenty steps that grow a project, then twenty that work on it in place:
 * appends to a log, partial rewrites of existing files, edits through vim in
 * Ex mode, deletions with replacements, and one package removed and put back.
 * Deterministic, so a second capture produces the same commands.
 */
export function sessionSteps() {
  const steps = [];
  for (let i = 1; i <= 20; i++) {
    const kb = [64, 128, 256, 512][i % 4];
    steps.push({
      label: `grow ${i}: new ${kb}k file`,
      commands: [
        "mkdir -p /root/proj",
        `dd if=/dev/urandom of=/root/proj/f${i} bs=1k count=${kb} 2>/dev/null`,
        `echo "step ${i}: wrote f${i} ${kb}k" >> /var/log/session.log`
      ]
    });
  }
  for (let i = 21; i <= 40; i++) {
    const j = ((i * 7) % 20) + 1;
    switch (i % 5) {
      case 1:
        steps.push({
          label: `work ${i}: append to log`,
          commands: [`for n in $(seq 1 24); do echo "step ${i} line $n $(date)" >> /var/log/session.log; done`]
        });
        break;
      case 2:
        steps.push({
          label: `work ${i}: rewrite part of f${j}`,
          commands: [`dd if=/dev/urandom of=/root/proj/f${j} bs=1k count=32 seek=8 conv=notrunc 2>/dev/null`]
        });
        break;
      case 3:
        steps.push({
          label: `work ${i}: edit with vim`,
          commands: [
            "test -f /root/notes.txt || cat /etc/passwd /etc/group /etc/services > /root/notes.txt",
            `vim -es -c '%s/^\\([a-z0-9_]*\\):/\\1_${i}:/' -c 'wq' /root/notes.txt`
          ]
        });
        break;
      case 4:
        steps.push({
          label: `work ${i}: delete f${j}, create g${i}`,
          commands: [
            `rm -f /root/proj/f${j}`,
            `dd if=/dev/urandom of=/root/proj/g${i} bs=1k count=128 2>/dev/null`
          ]
        });
        break;
      default:
        steps.push({
          label: `work ${i}: package churn`,
          commands: [
            "apk del xxd",
            `apk add --allow-untrusted --no-network ${alpine.CACHE}/xxd-9.1.0707-r0.apk`
          ]
        });
    }
  }
  return steps;
}

/**
 * The corpus workload, for a disk large enough to hold one.
 *
 * Forty steps as before, but the first twenty build and copy a corpus of
 * random files through the ordinary tools, and the last twenty work on it.
 */
export function corpusSteps() {
  const steps = [];
  for (let i = 1; i <= 8; i++) {
    const files = Array.from({ length: 8 }, (_, n) =>
      `dd if=/dev/urandom of=/root/corpus/d${i}/f${n + 1} bs=1M count=${n + 1} 2>/dev/null`);
    steps.push({ label: `corpus ${i}: eight files, 36 MB`, commands: [`mkdir -p /root/corpus/d${i}`, ...files] });
  }
  for (let i = 1; i <= 4; i++) {
    steps.push({ label: `archive ${i}: tar a directory`, commands: [`tar cf /root/archive${i}.tar -C /root/corpus d${i}`] });
  }
  for (let i = 1; i <= 2; i++) {
    steps.push({ label: `extract ${i}: untar a copy`, commands: [`mkdir -p /root/copy${i}`, `tar xf /root/archive${i}.tar -C /root/copy${i}`] });
  }
  for (let i = 1; i <= 6; i++) {
    steps.push({ label: `grow ${i}: 4 MB file`, commands: [`dd if=/dev/urandom of=/root/corpus/g${i} bs=1M count=4 2>/dev/null`] });
  }
  for (let i = 21; i <= 40; i++) {
    const d = ((i * 7) % 8) + 1, f = ((i * 3) % 8) + 1;
    switch (i % 5) {
      case 1:
        steps.push({ label: `work ${i}: rewrite 2 MB inside d${d}/f${f}`,
          commands: [`dd if=/dev/urandom of=/root/corpus/d${d}/f${f} bs=1M count=2 seek=1 conv=notrunc 2>/dev/null`] });
        break;
      case 2:
        steps.push({ label: `work ${i}: delete a directory, recreate it smaller`,
          commands: [`rm -rf /root/corpus/d${d}`, `mkdir -p /root/corpus/d${d}`,
            `dd if=/dev/urandom of=/root/corpus/d${d}/f1 bs=1M count=8 2>/dev/null`] });
        break;
      case 3:
        steps.push({ label: `work ${i}: append to a log and edit with vim`,
          commands: [`for n in $(seq 1 64); do echo "step ${i} line $n $(date)" >> /var/log/session.log; done`,
            "test -f /root/notes.txt || cat /etc/passwd /etc/group /etc/services > /root/notes.txt",
            `vim -es -c '%s/^\\([a-z0-9_]*\\):/\\1_${i}:/' -c 'wq' /root/notes.txt`] });
        break;
      case 4:
        steps.push({ label: `work ${i}: delete an archive, tar another`,
          commands: [`rm -f /root/archive${(i % 4) + 1}.tar`, `tar cf /root/archive${(i % 4) + 1}.tar -C /root/corpus d${d}`] });
        break;
      default:
        steps.push({ label: `work ${i}: package churn`,
          commands: ["apk del xxd", `apk add --allow-untrusted --no-network ${alpine.CACHE}/xxd-9.1.0707-r0.apk`] });
    }
  }
  return steps;
}

export async function main({ onStep = console.log, diskMb = 256, dir = "history", workload = "session" } = {}) {
  const log = onStep;
  const wake = keepAwake();
  const terminal = new Terminal(document.getElementById("term"));
  const DISK_SIZE = diskMb * 1024 * 1024;
  // The 256 MB machine streams the blank image the paper's other runs use; any
  // other size is an in-memory blank disk, which the device wraps the same way.
  const hda = diskMb === 256
    ? { url: BASE, size: DISK_SIZE, async: true, fixed_chunk_size: CHUNK }
    : { buffer: new ArrayBuffer(DISK_SIZE) };

  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 256 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    hda,
    filesystem: {},
    autostart: true, disable_keyboard: true, disable_mouse: true
  });
  emulator.add_listener("serial0-output-byte", (b) => terminal.writeByte(b));

  const device = new V86Device({
    emulator, diskSize: DISK_SIZE, flush: serialFlush(emulator, { prompt: PROMPT })
  });
  await device.waitForDevice(60000);
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

  const history = {
    label: workload === "corpus"
      ? `alpine, vim, and a forty-step corpus workload on a ${diskMb} MB disk`
      : "alpine, vim, and a forty-step working session",
    workload,
    diskSize: DISK_SIZE,
    chunkSize: CHUNK,
    guest: "buildroot 4.16.13 i686, alpine 3.20.10 on the disk",
    capturedAt: new Date().toISOString(),
    complete: false,
    phases: []
  };
  window.__history = history;

  // Sealing returns the epoch's ranges; the chunks they touch are read back
  // through the device, which is what the sync engine would commit.
  const seal = async (label) => {
    const ranges = device.seal().map((r) => ({ offset: r.offset, length: r.length }));
    const chunks = dirtyChunks(ranges, CHUNK, DISK_SIZE);
    const payloads = [];
    for (const i of chunks) payloads.push(await device.readChunk(i, CHUNK));
    const index = history.phases.length;
    const file = `phase-${String(index).padStart(3, "0")}.bin`;
    await upload(dir, file, packPhase({ label, chunkSize: CHUNK, chunks }, payloads));
    history.phases.push({ index, label, ranges: ranges.length, chunks, file });
    await upload(dir, "history.json", JSON.stringify(history, null, 1));
    log(`phase ${index} ${label}: ${ranges.length} ranges, ${chunks.length} chunks`);
  };

  const flush = async () => {
    const r = await fs.rc(run, "sync", 300000);
    if (!r.ok) throw new Error(`sync failed in the guest: ${r.output}`);
  };

  await fs.open(run, { allowFormat: true });
  await flush();
  await seal("format and mount");

  const rootfs = new Uint8Array(await (await fetch(`/vendor/alpine/${ROOTFS_NAME}`)).arrayBuffer());
  emulator.create_file(ROOTFS_NAME, rootfs);
  await alpine.bootstrap(run, { name: ROOTFS_NAME, onStep: (s) => log(`  ${s.type}`) });
  await flush();
  await seal("unpack alpine");

  for (const name of PACKAGES) {
    const bytes = new Uint8Array(await (await fetch(`/vendor/alpine/packages/${name}`)).arrayBuffer());
    emulator.create_file(name, bytes);
  }
  await alpine.installPackages(run, { names: PACKAGES, onStep: (s) => log(`  ${s.type}`) });
  await flush();
  await seal("install vim");

  for (const step of (workload === "corpus" ? corpusSteps() : sessionSteps())) {
    for (const command of step.commands) {
      const r = await alpine.inside(run, command, { timeoutMs: 300000 });
      if (!r.ok) log(`  (${step.label}) failed, continuing: ${command}: ${r.output.slice(-160)}`);
    }
    await flush();
    await seal(step.label);
  }

  await alpine.release_(run);
  await flush();
  await seal("release and flush");

  history.complete = true;
  history.finishedAt = new Date().toISOString();
  await upload(dir, "history.json", JSON.stringify(history, null, 1));

  wake();
  await emulator.destroy();
  device.detach();
  log(`done: ${history.phases.length} phases`);
  return history;
}
