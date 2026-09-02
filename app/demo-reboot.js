// The reported scenario, end to end against a real emulator.
//
// Format a blank disk, write a file, unmount, sync. Then throw the machine away
// entirely, boot a second one from the same pristine base image on the same
// branch, and see whether the file is there.
//
// Everything is the real implementation except the host, which keeps objects in
// memory rather than calling a forge.
//
//   const r = await import("./demo-reboot.js"); await r.main();

import { Machine } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { Terminal } from "../src/ui/terminal.js";
import { makeRunner } from "../src/guest/runner.js";
import { rc, atPrompt } from "../src/guest/fs.js";
import { MemoryHost } from "./demo-loop.js";

const V86_ROOT = "../spike-c";
const BASE = `${V86_ROOT}/images/blank-16mb.img`;
const DISK_SIZE = 16 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootMachine({ host, branch, hydrate, log }) {
  const terminal = new Terminal(document.getElementById("term"));
  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
    // The pristine base every time. Nothing about the disk persists in the tab,
    // which is the whole point of the test.
    hda: { url: BASE, size: DISK_SIZE, async: true, fixed_chunk_size: CHUNK_SIZE },
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

  // Before capture is armed, so restored chunks are not mistaken for guest work.
  if (attached.existing && hydrate) {
    const put = await machine.hydrate();
    log(`hydrated ${put.chunks} chunks onto a disk built from the pristine base`);
  }
  device.start();

  const t0 = Date.now();
  for (;;) {
    if (atPrompt(terminal.tail)) break;
    if (Date.now() - t0 > 180000) throw new Error("no shell prompt");
    await sleep(200);
  }

  // The shared runner decides when a command has finished; rc() then strips the
  // echoed command so what comes back is only what the command printed.
  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });
  const guest = async (line, timeoutMs = 300000) =>
    (await rc(run, line, timeoutMs)).output;

  return { emulator, device, machine, terminal, guest, attached };
}

export async function main({ onStep = console.log } = {}) {
  const steps = [];
  const log = (m) => { steps.push(m); onStep(m); };
  const host = new MemoryHost();
  const branch = `reboot-${Date.now().toString(36)}`;

  // --- session one: exactly the commands from the report ---------------------
  const one = await bootMachine({ host, branch, hydrate: true, log });
  log(`session 1 booted on ${branch}, existing: ${one.attached.existing}`);

  await one.guest("mke2fs -q /dev/sda");
  await one.guest("mkdir -p /mnt/disk && mount /dev/sda /mnt/disk");
  await one.guest("echo hello > /mnt/disk/note.txt");
  await one.guest("umount /mnt/disk");
  const wrote = await one.guest("mount /dev/sda /mnt/disk && cat /mnt/disk/note.txt && umount /mnt/disk");
  log(`session 1 wrote note.txt containing: ${JSON.stringify(wrote)}`);

  const synced = await one.machine.sync({ message: "hello from session one" });
  log(`session 1 synced: ${synced.chunks} chunks, ${synced.uploaded} uploaded, ` +
      `commit ${synced.commit}`);

  // Throw the whole machine away. Nothing about the disk survives in the tab.
  await one.emulator.destroy();
  one.device.detach();
  log("session 1 destroyed; the tab now holds no disk state at all");

  // --- session two: the bug, then the fix ------------------------------------
  const withoutHydration = await bootMachine({ host, branch, hydrate: false, log });
  // Each boot is a fresh guest from the CD, so the mountpoint has to be made
  // again every time. Without it the failure is a missing directory, which looks
  // nothing like a blank disk and would make this comparison meaningless.
  await withoutHydration.guest("mkdir -p /mnt/disk");
  const blindMount = await withoutHydration.guest(
    "mount /dev/sda /mnt/disk 2>&1 && cat /mnt/disk/note.txt 2>&1 || echo MOUNT-FAILED");
  log(`session 2 without hydration, mounting the disk: ${JSON.stringify(blindMount)}`);

  let refused = "";
  try { await withoutHydration.machine.sync({}); }
  catch (err) { refused = err.message; }
  log(`session 2 sync refused: ${refused ? "yes" : "NO, THIS IS A BUG"}`);

  await withoutHydration.emulator.destroy();
  withoutHydration.device.detach();

  const two = await bootMachine({ host, branch, hydrate: true, log });
  log(`session 3 booted, attached to an existing machine: ${two.attached.existing}`);
  await two.guest("mkdir -p /mnt/disk");
  const readBack = await two.guest("mount /dev/sda /mnt/disk && cat /mnt/disk/note.txt");
  const listing = await two.guest("ls -l /mnt/disk");
  log(`session 3 reading note.txt: ${JSON.stringify(readBack)}`);

  const ok = readBack.includes("hello");
  log(ok
    ? "PASS. A machine booted from the pristine base image on the same branch " +
      "carries the file the earlier machine wrote."
    : "FAIL. The file did not come back.");

  return { ok, steps, listing, readBack, blindMount, refused, host, branch };
}
