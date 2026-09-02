// The whole thing, end to end: install vim and get it back after a reboot.
//
// Format a disk, put Alpine on it, install vim and its dependencies as .apk
// files through the 9p share, sync to the repository, destroy the machine, then
// boot a fresh one from the pristine base image and run vim from what came back.
//
// Every byte comes from this page's own origin. No relay, no package mirror.
//
//   const v = await import("./demo-vim.js"); await v.main();

import { Machine } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { Terminal } from "../src/ui/terminal.js";
import { MemoryHost } from "./demo-loop.js";
import * as fs from "../src/guest/fs.js";
import { atPrompt } from "../src/guest/fs.js";
import { makeRunner } from "../src/guest/runner.js";
import * as alpine from "../src/guest/alpine.js";

const V86_ROOT = "../spike-c";
const ROOTFS_NAME = "alpine-minirootfs-3.20.10-x86.tar.gz";
const ROOTFS = `/vendor/alpine/${ROOTFS_NAME}`;
const PACKAGES = [
  "libncursesw-6.4_p20240420-r2.apk",
  "ncurses-terminfo-base-6.4_p20240420-r2.apk",
  "vim-9.1.0707-r0.apk",
  "vim-common-9.1.0707-r0.apk",
  "xxd-9.1.0707-r0.apk"
];
const BASE = `${V86_ROOT}/images/blank-256mb.img`;
const DISK_SIZE = 256 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session({ host, branch, files = {} }) {
  const terminal = new Terminal(document.getElementById("term"));
  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 256 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    hda: { url: BASE, size: DISK_SIZE, async: true, fixed_chunk_size: CHUNK_SIZE },
    filesystem: {},
    autostart: true, disable_keyboard: true, disable_mouse: true
  });
  emulator.add_listener("serial0-output-byte", (b) => terminal.writeByte(b));

  const device = new V86Device({
    emulator, diskSize: DISK_SIZE, flush: serialFlush(emulator, { prompt: PROMPT })
  });
  await device.waitForDevice(60000);
  const machine = new Machine({
    host, device, branch, governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
  });
  const attached = await machine.load({
    diskSize: DISK_SIZE, chunkSize: CHUNK_SIZE, base: BASE, baseIsBlank: true
  });
  if (attached.existing) await machine.hydrate();
  device.start();

  const t0 = Date.now();
  for (;;) {
    if (atPrompt(terminal.tail)) break;
    if (Date.now() - t0 > 240000) throw new Error("no shell prompt");
    await sleep(200);
  }

  for (const [name, bytes] of Object.entries(files)) emulator.create_file(name, bytes);

  // The shared runner, so "has this finished" is decided in one tested place.
  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });

  return { emulator, device, machine, run, attached };
}

async function fetchAll(paths, log) {
  const files = {};
  let total = 0;
  for (const path of paths) {
    const name = path.split("/").pop();
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} is not being served`);
    files[name] = new Uint8Array(await response.arrayBuffer());
    total += files[name].length;
  }
  log(`fetched ${Object.keys(files).length} files, ${(total / 1048576).toFixed(2)} MB, ` +
      `all from this page's own origin`);
  return files;
}

export async function main({ onStep = console.log } = {}) {
  const steps = [];
  const log = (m) => { steps.push(m); onStep(m); };
  const host = new MemoryHost();
  const branch = `vim-${Date.now().toString(36)}`;

  const files = await fetchAll(
    [ROOTFS, ...PACKAGES.map((p) => `/vendor/alpine/packages/${p}`)], log
  );

  // --- build the machine ------------------------------------------------------
  const one = await session({ host, branch, files });
  log(`session 1 booted on ${branch}`);

  await fs.open(one.run, { allowFormat: true });
  const boot = await alpine.bootstrap(one.run, {
    name: ROOTFS_NAME, onStep: (s) => log(`  ${s.type}${s.release ? " " + s.release : ""}`)
  });
  log(`alpine ${boot.release}, ${boot.apk}`);

  const before = await alpine.installed(one.run);
  log(`before: ${before.length} packages`);

  // The whole selection in one apk invocation. vim on its own would fail: it
  // needs libncursesw, and offline apk can only use what it is handed.
  const installed = await alpine.installPackages(one.run, {
    names: PACKAGES,
    onStep: (s) => { if (s.type === "installing") log(`  handing all ${s.count} to apk together`); }
  });
  log(`installed: ${installed.added.join(", ")}`);

  const version = await alpine.inside(one.run, "vim --version | head -1");
  log(`vim runs: ${JSON.stringify(version.output.split(/\r?\n/).pop().trim())}`);

  // Use it for something, so the proof is a file vim itself wrote.
  await alpine.inside(one.run,
    `printf 'ihello from vim\\033:wq\\r' | vim -s /dev/stdin /root/written-by-vim.txt >/dev/null 2>&1 || ` +
    `vim -e -s -c 'normal ihello from vim' -c wq /root/written-by-vim.txt`);
  const wrote = await alpine.inside(one.run, "cat /root/written-by-vim.txt");
  log(`vim wrote: ${JSON.stringify(wrote.output.split(/\r?\n/).pop().trim())}`);

  await alpine.release_(one.run);
  const synced = await one.machine.sync({ message: `alpine ${boot.release} with vim` });
  log(`synced: ${synced.chunks} chunks, ${synced.uploaded} uploaded, ` +
      `${(synced.bytesUploaded / 1048576).toFixed(1)} MB`);

  await one.emulator.destroy();
  one.device.detach();
  log("session 1 destroyed");

  // --- get it back ------------------------------------------------------------
  // Nothing goes into the share this time. If vim runs, it came from the repo.
  const two = await session({ host, branch, files: {} });
  log(`session 2 attached: ${two.attached.existing}`);
  await fs.open(two.run, { allowFormat: false });
  await alpine.prepare(two.run);

  const shareEmpty = await fs.rc(two.run, `test -z "$(ls -A /mnt)"`);
  log(`transfer share empty this boot: ${shareEmpty.ok}`);

  const after = await alpine.installed(two.run);
  const versionAgain = await alpine.inside(two.run, "vim --version | head -1");
  const readBack = await alpine.inside(two.run, "cat /root/written-by-vim.txt");
  log(`after reboot: ${after.length} packages, vim says ` +
      `${JSON.stringify(versionAgain.output.split(/\r?\n/).pop().trim())}`);
  log(`the file vim wrote: ${JSON.stringify(readBack.output.split(/\r?\n/).pop().trim())}`);

  await alpine.release_(two.run);
  await two.emulator.destroy();
  two.device.detach();

  const ok = installed.added.includes("vim") &&
             shareEmpty.ok &&
             after.length === before.length + installed.added.length &&
             /VIM/i.test(versionAgain.output) &&
             readBack.output.includes("hello from vim");

  log(ok
    ? "PASS. vim was installed from .apk files through the share, committed, and " +
      "runs on a machine booted from a blank image with an empty share. The file " +
      "it wrote came back too."
    : "FAIL.");

  return { ok, steps, boot, installed, before, after, version, versionAgain, readBack };
}
