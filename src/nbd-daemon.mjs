// Attach a repository to a real operating system.
//
//   GIT_DISK_TOKEN=... node src/nbd-daemon.mjs \
//       --host github --repo owner/name --branch machine-1 --size 512M
//
// then, as root, on Linux:
//
//   modprobe nbd
//   nbd-client 127.0.0.1 10809 /dev/nbd0 -N disk
//   mkfs.ext4 /dev/nbd0          # first time only
//   mount /dev/nbd0 /mnt/disk
//
// and the repository is a mounted filesystem. Unmount before stopping the
// daemon, so the kernel writes back what it is holding.
//
// The token comes from the environment and never from an argument, because
// arguments are visible in the process table to every user on the machine.
//
// What this is for: it is the same engine as the browser build, on a device the
// kernel writes to directly. The point is the Device contract, not Linux.

import net from "node:net";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { NbdDevice } from "./device/nbd.js";
import { Machine } from "./core/machine.js";
import { Governor } from "./core/governor.js";
import { createHost } from "./host/index.js";
import * as manifestModule from "./core/manifest.js";

const run = promisify(exec);

function parseArgs(argv) {
  const out = {
    host: "github", repo: null, branch: null, port: 10809,
    size: "512M", chunk: "256K", syncSeconds: 300, endpoint: undefined,
    mount: null
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in out)) throw new Error(`unknown option --${key}`);
    if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
    out[key] = argv[i + 1];
  }
  out.port = Number(out.port);
  out.syncSeconds = Number(out.syncSeconds);
  return out;
}

/** "512M" and "4G" are how people write disk sizes; bytes are how we need them. */
function bytes(text) {
  const match = /^(\d+)([KMG]?)$/i.exec(String(text).trim());
  if (!match) throw new Error(`cannot read "${text}" as a size`);
  const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return Number(match[1]) * scale[match[2].toUpperCase()];
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  console.error("usage: --host github --repo owner/name --branch machine-1 [--size 512M]");
  process.exit(2);
}
const token = process.env.GIT_DISK_TOKEN;
if (!token) {
  console.error("set GIT_DISK_TOKEN. Passing a token as an argument would put it " +
                "in the process table for every user on this machine to read.");
  process.exit(2);
}
if (!args.repo || !args.branch) {
  console.error("usage: --host github --repo owner/name --branch machine-1 [--size 512M]");
  process.exit(2);
}

const [owner, repo] = String(args.repo).split("/");
const governor = new Governor({ ratePerMin: 150, concurrency: 8 });
const host = createHost(args.host, { token, owner, repo, endpoint: args.endpoint, governor });

/**
 * Ask the operating system to write its cache out.
 *
 * The device cannot do this itself: NBD has no way for a server to tell a client
 * to flush. This is the same problem the browser build has with the guest, and
 * arriving at it twice by different routes is the reason the paper treats the
 * flush requirement as inherent rather than as a v86 quirk. Syncing a specific
 * mount is better than a global sync when we know which one to name.
 */
async function requestFlush() {
  await run(args.mount ? `sync -f ${args.mount}` : "sync");
}

/**
 * An existing machine's geometry comes from its manifest, not from the command
 * line. Building the device first and asking afterwards would mean --size had to
 * match a number the user has no reason to remember, and a device of the wrong
 * size against a real machine is a silent corruption rather than an error.
 */
async function peekGeometry() {
  const ref = await host.resolveRef(args.branch);
  if (!ref) return null;
  const entries = await host.readTree(ref.tree);
  const entry = entries.find((e) => e.path === manifestModule.MANIFEST_PATH);
  if (!entry) throw new Error(`commit ${ref.commit} has no manifest`);
  const manifest = manifestModule.parse(await host.readObject(entry.id));
  return { diskSize: manifest.diskSize, chunkSize: manifest.chunkSize };
}

console.log(`opening ${args.branch} on ${args.repo}`);
const existing = await peekGeometry();
const geometry = existing || { diskSize: bytes(args.size), chunkSize: bytes(args.chunk) };
if (existing) {
  console.log(`  an existing machine: ${(existing.diskSize / 1024 / 1024).toFixed(0)} MB, ` +
              `${(existing.chunkSize / 1024).toFixed(0)} KB chunks`);
}

const device = new NbdDevice({ diskSize: geometry.diskSize, requestFlush });
const machine = new Machine({
  host, device, branch: args.branch, governor,
  onEvent: (event) => console.log(`  ${event.type}${event.chunks !== undefined ? " " + event.chunks : ""}`)
});

const loaded = await machine.load({
  diskSize: geometry.diskSize, chunkSize: geometry.chunkSize,
  base: "blank", baseIsBlank: true
});

if (loaded && loaded.existing) {
  console.log("putting the machine back");
  await machine.hydrate({
    onProgress: ({ applied, total }) => {
      if (applied === total || applied % 25 === 0) console.log(`  ${applied}/${total} chunks`);
    }
  });
} else {
  // A new machine: the disk is blank, which is what the kernel will find, so
  // there is nothing to put back and nothing to fetch.
  machine.markHydrated();
  console.log("a new machine. Run mkfs against the device once it is attached.");
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  console.log("a client attached");
  socket.on("error", (err) => console.error(`  socket: ${err.message}`));
  socket.on("close", () => console.log("the client detached"));
  device.serve(socket, { onError: (err) => console.error(`  serving: ${err.message}`) });
});

await new Promise((resolve) => server.listen(args.port, "127.0.0.1", resolve));
console.log(`serving on 127.0.0.1:${args.port}, syncing every ${args.syncSeconds}s`);

let syncing = false;
async function syncNow(reason) {
  if (syncing) return;
  syncing = true;
  try {
    const result = await machine.sync({ message: `${reason} at ${new Date().toISOString()}` });
    if (result.skipped) console.log("nothing had changed");
    else console.log(`synced ${result.uploaded}/${result.chunks} chunks as ${result.commit}`);
    const freed = device.takeDiscarded();
    if (freed.length) {
      // Recorded rather than acted on. Acting on it means dropping chunks from
      // commits that already exist, which is rewriting history; see the paper.
      console.log(`  the kernel freed ${freed.length} ranges this interval`);
    }
  } catch (err) {
    console.error(`sync failed: ${err.message}`);
  } finally { syncing = false; }
}

const timer = setInterval(() => syncNow("periodic"), args.syncSeconds * 1000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log("\nstopping. Unmount the device first if you have not, or this " +
                "commits a filesystem the kernel was still writing to.");
    await syncNow("final");
    server.close();
    process.exit(0);
  });
}
