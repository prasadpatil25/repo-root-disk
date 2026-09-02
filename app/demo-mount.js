// The mount helpers against a real guest.
//
// Two paths matter and they must not be confused. A blank disk has no
// filesystem and should be formatted. A machine that holds committed chunks and
// still will not mount must never be formatted, because that would destroy the
// state the user came back for. Both are exercised here.
//
//   const m = await import("./demo-mount.js"); await m.main();

import { Machine } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { Terminal } from "../src/ui/terminal.js";
import { MemoryHost } from "./demo-loop.js";
import * as fs from "../src/guest/fs.js";
import { atPrompt } from "../src/guest/fs.js";
import { makeRunner } from "../src/guest/runner.js";

const V86_ROOT = "../spike-c";
const BASE = `${V86_ROOT}/images/blank-16mb.img`;
const DISK_SIZE = 16 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const PROMPT = /[#$%>]\s*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function session({ host, branch, hydrate = true }) {
  const terminal = new Terminal(document.getElementById("term"));
  const emulator = new V86({
    wasm_path: `../vendor/v86/v86.wasm`,
    memory_size: 128 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    screen_container: document.getElementById("screen"),
    bios: { url: `${V86_ROOT}/bios/seabios.bin` },
    vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
    cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
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
  if (attached.existing && hydrate) await machine.hydrate();
  device.start();

  const t0 = Date.now();
  for (;;) {
    if (atPrompt(terminal.tail)) break;
    if (Date.now() - t0 > 180000) throw new Error("no shell prompt");
    await sleep(200);
  }

  // The shared runner decides when a command has finished.
  const run = makeRunner({
    send: (text) => emulator.serial0_send(text),
    tail: () => terminal.tail,
    reset: () => terminal.resetTail()
  });

  return { emulator, device, machine, run, attached };
}

export async function main({ onStep = console.log } = {}) {
  const steps = [];
  const log = (m) => { steps.push(m); onStep(m); };
  const host = new MemoryHost();
  const branch = `mount-${Date.now().toString(36)}`;

  // --- a new machine: blank disk, formatting is safe -------------------------
  const one = await session({ host, branch });
  const empty = Object.keys(one.machine.manifest.chunks).length === 0;
  log(`session 1: new machine, manifest holds ${empty ? "no" : "some"} chunks`);

  const events = [];
  const opened = await fs.open(one.run, {
    allowFormat: empty, onStep: (s) => events.push(s.type)
  });
  log(`open() on a blank disk: formatted=${opened.formatted}, steps=${events.join(" then ")}`);

  const mountedNow = await fs.isMounted(one.run);
  log(`isMounted after open: ${mountedNow}`);

  await one.run("echo 'mounted by the app' > /mnt/disk/note.txt");
  const wrote = await one.run("cat /mnt/disk/note.txt");
  log(`wrote through the mount: ${JSON.stringify(wrote)}`);

  await fs.unmount(one.run);
  log(`isMounted after unmount: ${await fs.isMounted(one.run)}`);

  // Remount to prove a second mount on the same disk needs no format.
  const again = await fs.open(one.run, { allowFormat: false });
  log(`remounting a formatted disk: formatted=${again.formatted}`);

  const synced = await one.machine.sync({ message: "mounted and written" });
  log(`synced ${synced.chunks} chunks`);
  await one.emulator.destroy();
  one.device.detach();

  // --- a returning machine: mounts with no format ----------------------------
  const two = await session({ host, branch });
  const hasChunks = Object.keys(two.machine.manifest.chunks).length > 0;
  const reopened = await fs.open(two.run, { allowFormat: !hasChunks });
  const readBack = await two.run("cat /mnt/disk/note.txt");
  log(`session 2: chunks=${hasChunks}, formatted=${reopened.formatted}, ` +
      `note.txt=${JSON.stringify(readBack)}`);
  await two.emulator.destroy();
  two.device.detach();

  // --- the dangerous case: state present, disk not hydrated ------------------
  // Without hydration the disk is blank, so mount fails. A machine with chunks
  // must refuse to format its way out of that.
  const three = await session({ host, branch, hydrate: false });
  let refusal = null;
  try {
    await fs.open(three.run, { allowFormat: false });
  } catch (err) {
    refusal = { reason: err.reason, formatted: false, message: err.message };
  }
  const stillBlank = await three.run("mke2fs -n /dev/sda 2>&1 | head -2 || true");
  log(`session 3, un-hydrated disk: refused with reason ${refusal && refusal.reason}`);
  await three.emulator.destroy();
  three.device.detach();

  const ok = opened.formatted === true &&
             mountedNow === true &&
             wrote.includes("mounted by the app") &&
             again.formatted === false &&
             reopened.formatted === false &&
             readBack.includes("mounted by the app") &&
             refusal !== null && refusal.reason === fs.NO_FILESYSTEM;

  log(ok
    ? "PASS. A blank disk formats and mounts, a returning machine mounts without " +
      "formatting, and a machine with state refuses to format its way out of a " +
      "failed mount."
    : "FAIL.");

  return { ok, steps, opened, again, reopened, readBack, refusal, stillBlank };
}
