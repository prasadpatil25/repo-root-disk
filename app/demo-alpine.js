// Alpine on the disk, against a real emulator.
//
// Format a 256 MB disk, unpack an Alpine minirootfs onto it through the 9p
// share, chroot in, and check apk runs. Then sync, throw the machine away, boot
// a fresh one on the same branch, and check the distribution came back from the
// repository rather than from anything left in the tab.
//
// 16 MB is not enough: the rootfs is 6.4 MB unpacked and apk needs room to work.
//
//   const a = await import("./demo-alpine.js"); await a.main();

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
const ROOTFS = "../vendor/alpine/alpine-minirootfs-3.20.10-x86.tar.gz";
const ROOTFS_NAME = "alpine-minirootfs-3.20.10-x86.tar.gz";
const BASE = `${V86_ROOT}/images/blank-256mb.img`;
const DISK_SIZE = 256 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session({ host, branch, rootfs }) {
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

  // The rootfs goes into the share every boot: it lives in browser memory and is
  // not there after a reload. Putting it back costs nothing when it is unused.
  if (rootfs) emulator.create_file(ROOTFS_NAME, rootfs);

  // The shared runner, so "has this finished" is decided in one tested place.
  // A caller that appends a marker waits for the marker; only a bare command
  // falls back to spotting a prompt, which is the part that can fire early.
  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });

  return { emulator, device, machine, run, attached, terminal };
}

export async function main({ onStep = console.log } = {}) {
  const steps = [];
  const log = (m) => { steps.push(m); onStep(m); };
  const host = new MemoryHost();
  const branch = `alpine-${Date.now().toString(36)}`;

  log(`fetching the rootfs from the page's own origin: ${ROOTFS}`);
  const rootfs = new Uint8Array(await (await fetch(ROOTFS)).arrayBuffer());
  log(`${(rootfs.length / 1048576).toFixed(2)} MB, no third party involved`);

  // --- first boot: format, unpack, chroot ------------------------------------
  const one = await session({ host, branch, rootfs });
  log(`session 1 booted on ${branch}`);

  const opened = await fs.open(one.run, { allowFormat: true });
  log(`disk ${opened.formatted ? "formatted and " : ""}mounted at ${opened.mountpoint}`);

  const events = [];
  const boot = await alpine.bootstrap(one.run, {
    name: ROOTFS_NAME,
    onStep: (s) => { events.push(s.type); log(`  ${s.type}${s.release ? " " + s.release : ""}`); }
  });
  log(`alpine ${boot.release} on the disk, running ${boot.apk}`);

  const packages = await alpine.installed(one.run);
  log(`apk reports ${packages.length} packages installed: ${packages.slice(0, 4).join(", ")}...`);

  const uname = await alpine.inside(one.run, "cat /etc/os-release | head -2; ls /sbin/apk");
  log(`inside the chroot: ${JSON.stringify(uname.output.slice(0, 120))}`);

  // Something the outer guest does not have, to prove the two are distinct.
  const musl = await alpine.inside(one.run, "ls -la /lib/ld-musl-i386.so.1");
  log(`musl present inside: ${musl.ok}`);

  // The chroot mounts are kernel state, not disk state. They must come off
  // before syncing or the sync captures a filesystem with /proc mounted into it.
  await alpine.release_(one.run);

  const synced = await one.machine.sync({ message: `alpine ${boot.release} on the disk` });
  log(`synced: ${synced.chunks} chunks, ${synced.uploaded} uploaded, ` +
      `${(synced.bytesUploaded / 1048576).toFixed(1)} MB`);

  await one.emulator.destroy();
  one.device.detach();
  log("session 1 destroyed; nothing about the disk survives in the tab");

  // --- second boot: it should come back from the repository -------------------
  const two = await session({ host, branch, rootfs: null });
  log(`session 2 attached to an existing machine: ${two.attached.existing}`);
  await fs.open(two.run, { allowFormat: false });

  const found = await alpine.isInstalled(two.run);
  const version = await alpine.release(two.run);
  log(`alpine found on the rehydrated disk: ${found}, release ${version}`);

  // No rootfs was put in the share this time, so if apk runs it came from the
  // repository and nowhere else.
  const shareEmpty = await fs.rc(two.run, `test -z "$(ls -A /mnt)"`);
  log(`transfer share is empty this boot: ${shareEmpty.ok}`);

  const second = await alpine.bootstrap(two.run, { name: ROOTFS_NAME });
  const packagesAgain = await alpine.installed(two.run);
  log(`apk runs after the reboot: ${second.apk}, ${packagesAgain.length} packages`);

  await alpine.release_(two.run);
  await two.emulator.destroy();
  two.device.detach();

  const ok = boot.release === version &&
             second.wasAlready === true &&
             shareEmpty.ok &&
             packagesAgain.length === packages.length &&
             /apk-tools/.test(second.apk);

  log(ok
    ? `PASS. Alpine ${version} was unpacked onto the disk, committed to the ` +
      `repository, and came back on a machine booted from a blank base image ` +
      `with an empty transfer share. apk runs against it.`
    : "FAIL.");

  return { ok, steps, boot, second, packages, packagesAgain, version, host, branch };
}
