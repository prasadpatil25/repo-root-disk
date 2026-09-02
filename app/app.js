// Reference app: a machine whose disk lives in a git repository.
//
// This is assembly. Every decision it encodes was measured elsewhere and lives
// in /src; the app's job is to wire them to a real emulator and show what a sync
// costs. Vendored assets currently sit under /spike-c and should move to a
// shared vendor directory once the spikes are retired.

import { createHost } from "../src/host/index.js";
import { Machine, restore, ConflictError } from "../src/core/machine.js";
import { V86Device, serialFlush } from "../src/device/v86.js";
import { Governor } from "../src/core/governor.js";
import { deriveCipher, randomSaltHex } from "../src/core/crypto.js";
import * as manifestModule from "../src/core/manifest.js";
import { Terminal } from "../src/ui/terminal.js";
import * as fsModule from "../src/guest/fs.js";
import * as alpineModule from "../src/guest/alpine.js";
import { makeRunner } from "../src/guest/runner.js";
import { keyToBytes, textToBytes, pasteNeedsConfirming } from "../src/ui/keyboard.js";

const V86_ROOT = "../spike-c";

// One branch is one disk. These are subdirectories of it, surfaced where a guest
// expects them: same filesystem, same superblock, so a write through one path is
// visible through the others immediately. This image ships no /home and its
// shell's home is /root, so both are bound.
const BINDS = [
  { source: "home", target: "/home" },
  { source: "root", target: "/root" }
];
// Served from this page's own origin, like every other asset. Nothing here
// reaches a package mirror or a network relay.
const ALPINE_ROOTFS = "../vendor/alpine/alpine-minirootfs-3.20.10-x86.tar.gz";
const ALPINE_NAME = "alpine-minirootfs-3.20.10-x86.tar.gz";

const DISKS = {
  16: `${V86_ROOT}/images/blank-16mb.img`,
  256: `${V86_ROOT}/images/blank-256mb.img`
};

/**
 * How the disk reaches the emulator.
 *
 * A blank base is zeros, so it is built here rather than downloaded. That is
 * what makes this page deployable to a static host, where a 256 MB image cannot
 * be committed, and it saves a pointless transfer everywhere else.
 *
 * fixed_chunk_size on the streamed path turns on read caching. Without it every
 * unloaded block read is a network round trip and formatting a large disk takes
 * thousands of them.
 */
function diskFor(base, diskSize, baseIsBlank) {
  return baseIsBlank
    ? { buffer: new ArrayBuffer(diskSize) }
    : { url: base, size: diskSize, async: true, fixed_chunk_size: 256 * 1024 };
}

const $ = (id) => document.getElementById(id);
const state = {
  host: null, device: null, machine: null, emulator: null,
  governor: null, cipher: null, booted: false, mounted: false, alpine: null
};

// --- output ------------------------------------------------------------------

function log(message, kind = "") {
  const el = $("log");
  if (el.dataset.empty) { el.textContent = ""; delete el.dataset.empty; }
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = message;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function status(text, kind = "idle") {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

function setStep(id, kind) { $(id).className = `step${kind ? " " + kind : ""}`; }

function meters() {
  if (!state.machine || !state.machine.manifest) return;
  const s = state.machine.stats();
  $("m-chunks").innerHTML = `${s.chunksWritten}<span> / ${s.chunksTotal}</span>`;
  $("m-objects").textContent = s.distinctObjects;
  $("m-stored").innerHTML = `${(s.storedBytes / 1048576).toFixed(1)}<span> MB</span>`;
  $("m-occupancy").innerHTML = `${(s.occupancy * 100).toFixed(1)}<span> %</span>`;
  // Reported together deliberately: this ratio is occupancy, not compression.
  $("m-dedup").innerHTML = `${s.dedupRatio.toFixed(2)}<span> x</span>`;
  $("m-sync").textContent = state.machine.manifest.sync;
}

function enable(ids, on) { for (const id of ids) $(id).disabled = !on; }

// --- connection ----------------------------------------------------------------

try {
  const saved = localStorage.getItem("machine.repo");
  if (saved) $("repo").value = saved;
  const savedHost = localStorage.getItem("machine.hostKind");
  if (savedHost) $("hostKind").value = savedHost;
} catch { /* storage may be unavailable */ }

$("connect").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const [owner, repo] = $("repo").value.trim().split("/");
  const kind = $("hostKind").value;
  if (!token || !owner || !repo) {
    status("Enter a token and owner/repo.", "bad");
    return;
  }

  state.governor = new Governor({
    // 150 per minute against an enforced ceiling of 180. The documented 80 per
    // minute and 500 per hour were never observed to fire.
    ratePerMin: 150,
    concurrency: 8,
    onEvent: (e) => {
      if (e.type === "backpressure") {
        log(`backpressure: median ${e.medianMs}ms against ${e.baselineMs}ms baseline, ` +
            `concurrency now ${e.concurrency}`, "warn");
      } else if (e.type === "refused") {
        log(`rate limited, waiting ${e.retryAfterSeconds}s, concurrency now ${e.concurrency}`, "warn");
      }
    }
  });

  try {
    state.host = createHost(kind, { token, owner, repo, governor: state.governor });
    const info = await state.host.validate();
    if (!info.canWrite) throw new Error(`the token cannot write to ${owner}/${repo}`);
    const caps = state.host.constructor.capabilities;
    status(
      `Connected as ${info.login}. ${owner}/${repo} is ${info.private ? "private" : "public"}. ` +
      `${caps.batchCommit ? "Batch commit, one request per sync." : "Object writes, N+3 per sync."} ` +
      `${caps.orphanCommit ? "" : "No parentless commits, so compaction is unavailable."}`,
      "ok"
    );
    try {
      localStorage.setItem("machine.repo", `${owner}/${repo}`);
      localStorage.setItem("machine.hostKind", kind);
    } catch { /* ignore */ }
    enable(["boot"], true);
    if (!caps.orphanCommit) $("compact").title = "This host cannot create a parentless commit.";
  } catch (err) {
    status(err.message, "bad");
  }
});

// --- boot ----------------------------------------------------------------------

$("boot").addEventListener("click", async () => {
  enable(["boot", "connect"], false);
  setStep("s1", "on");
  const branch = $("branch").value.trim() || `machine-${Date.now().toString(36)}`;
  $("branch").value = branch;

  try {
    // Look the machine up before building anything. Once a branch exists its
    // manifest is the authority on disk size, chunk size and base image, and
    // load() ignores what it is passed. Building the emulator from the dropdowns
    // first and discovering the mismatch afterwards would leave a device of the
    // wrong size wired to the machine.
    const existingManifest = await peekManifest(branch);

    let diskSize, chunkSize, base, baseIsBlank;
    if (existingManifest) {
      ({ diskSize, chunkSize, base, baseIsBlank } = existingManifest);
      const wantedMb = Number($("diskSize").value);
      const wantedChunk = Number($("chunkSize").value);
      if (diskSize !== wantedMb * 1024 * 1024 || chunkSize !== wantedChunk) {
        log(`${branch} already exists as a ${diskSize / 1048576} MB machine with ` +
            `${chunkSize / 1024} KB chunks. Using the machine's own geometry, ` +
            `not the selection.`, "warn");
      }
      // Reflect reality, so the controls do not keep claiming something else.
      $("diskSize").value = String(diskSize / 1048576);
      $("chunkSize").value = String(chunkSize);
    } else {
      const diskMb = Number($("diskSize").value);
      diskSize = diskMb * 1024 * 1024;
      chunkSize = Number($("chunkSize").value);
      base = DISKS[diskMb];
      // Every disk this page offers is blank. The name is recorded in the
      // manifest as the base's identity; the zeros are made locally.
      baseIsBlank = true;
    }

    const passphrase = $("passphrase").value;
    if (passphrase) {
      // Encryption normally costs deduplication. Here deduplication is the
      // reciprocal of occupancy and nothing more, so there is almost nothing to
      // lose by encrypting.
      const existingSalt =
        (existingManifest && existingManifest.encryption && existingManifest.encryption.salt) || null;
      const salt = existingSalt || randomSaltHex();
      state.cipher = await deriveCipher(passphrase, salt);
      log(`encryption on, salt ${salt.slice(0, 8)}...`);
    } else {
      state.cipher = null;
    }

    log(`booting: ${diskSize / 1048576} MB disk, ${chunkSize / 1024} KB chunks, ` +
        (baseIsBlank ? "blank base built locally" : `streamed from ${base}`));
    state.emulator = new V86({
      wasm_path: `../vendor/v86/v86.wasm`,
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      screen_container: $("screen"),
      bios: { url: `${V86_ROOT}/bios/seabios.bin` },
      vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
      cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
      hda: diskFor(base, diskSize, baseIsBlank),
      // The guest has no network and no package manager. This is the way bytes
      // get in: the browser writes a file, the image mounts the share at /mnt.
      filesystem: {},
      autostart: true, disable_keyboard: true, disable_mouse: true
    });
    wireSerial();

    state.device = new V86Device({
      emulator: state.emulator,
      diskSize,
      flush: serialFlush(state.emulator, { prompt: /[#$%>]\s*$/ }),
      onEvent: (e) => log(`device ${e.type}: ${e.path} (${e.streamed ? "streamed" : "in memory"})`)
    });
    await state.device.waitForDevice(30000);
    setStep("s2", "on");

    // Attach the engine before arming capture. Putting the machine back is a
    // write to the disk, and if capture were already on it would be recorded as
    // the guest's work and re-uploaded on the next sync.
    state.machine = new Machine({
      host: state.host, device: state.device, branch,
      cipher: state.cipher, governor: state.governor,
      onEvent: (e) => {
        if (e.type === "conflict-detected") log("another writer moved the branch first", "warn");
        if (e.type === "conflict-rebased") log(`rebased onto their commit; ${e.disjointChunks} chunks were disjoint`, "ok");
      }
    });
    const { existing } = await state.machine.load({
      diskSize, chunkSize, base, baseIsBlank: true
    });

    if (existing) {
      // The device was built from the base image, so it is blank. Without this
      // the guest boots an empty disk no matter what the branch holds.
      log(`attached to ${branch} at sync ${state.machine.manifest.sync}; ` +
          `putting its state back onto the disk`);
      const put = await state.machine.hydrate({
        onProgress: ({ applied, total }) => {
          if (applied === total || applied % 25 === 0) {
            status(`Restoring ${applied} of ${total} chunks onto the disk.`, "idle");
          }
        }
      });
      log(`${put.chunks} chunks written back; the guest will see the files it left`, "ok");
    } else {
      // Boot writes nothing to the repository. A git branch cannot exist without
      // a commit, and there is nothing to commit until the first sync, so saying
      // the machine is "on" a branch that is not there yet would be a lie the
      // user only discovers when they go looking for it.
      log(`new machine; ${branch} does not exist in the repository yet and is ` +
          `created by the first sync`);
    }

    state.device.start();
    log("capture armed; boot itself writes nothing to the disk");

    await waitForPrompt(180000);
    log(`shell is up; writes captured during boot: ${state.device.stats.writes}`);

    state.booted = true;
    meters();
    setStep("s3", "on");
    enable(["sync", "compact", "restoreBtn", "mount"], true);
    setMounted(false);

    // Mount without being asked. The mountpoint does not survive a boot, so
    // every session would otherwise start with the same two commands.
    await mountDisk();
    status(existing
      ? "Machine is running, attached to an existing branch."
      : `Machine is running. Nothing has been written to ${$("repo").value.trim()} yet. ` +
        `Sync creates the branch.`, "idle");
  } catch (err) {
    setStep("s1", "bad");
    log("ERROR: " + err.message, "bad");
    status(err.message, "bad");
    enable(["boot", "connect"], true);
  }
});

/**
 * Read an existing machine's manifest without attaching to it. Boot needs the
 * geometry and the salt before it can build anything, and both live here.
 * Returns null for a branch that does not exist yet.
 */
async function peekManifest(branch) {
  try {
    const ref = await state.host.resolveRef(branch);
    if (!ref) return null;
    const entries = await state.host.readTree(ref.tree);
    const entry = entries.find((e) => e.path === manifestModule.MANIFEST_PATH);
    if (!entry) return null;
    return manifestModule.parse(await state.host.readObject(entry.id));
  } catch { return null; }
}

// --- guest console ---------------------------------------------------------------

let terminal = null;
function wireSerial() {
  if (!terminal) terminal = new Terminal($("term"));
  // The guest emits a byte stream, not text. The terminal decodes UTF-8,
  // interprets colour and cursor sequences, and drops control bytes rather than
  // letting them render as characters.
  state.emulator.add_listener("serial0-output-byte", (byte) => terminal.writeByte(byte));
}

function waitForPrompt(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      // Match against escape-free text: a prompt preceded by a colour sequence
      // would otherwise never look like one. atPrompt also refuses a tail that
      // is still mid-echo, which a bare character test does not.
      if (terminal && fsModule.atPrompt(terminal.tail)) return resolve();
      if (Date.now() > deadline) return reject(new Error("no shell prompt appeared"));
      setTimeout(poll, 150);
    })();
  });
}

/**
 * Send a command and wait for the guest to come back to a prompt, returning what
 * it printed. The Send box does not need this, but anything the app decides
 * based on the result does.
 */
/**
 * Send a command to the guest and wait for it to finish. The runner is shared
 * with the library so there is one implementation of "is it done yet", which is
 * the part that is easy to get subtly wrong.
 */
const guestRun = makeRunner({
  send: (text) => {
    if (!state.emulator || !terminal) throw new Error("no guest is running");
    state.emulator.serial0_send(text);
  },
  tail: () => (terminal ? terminal.tail : ""),
  reset: () => { if (terminal) terminal.resetTail(); }
});

function setMounted(on) {
  state.mounted = on;
  $("mountstate").className = `mountstate${on ? " on" : ""}`;
  $("mountstate").textContent = on
    ? `${fsModule.MOUNTPOINT}, ${BINDS.map((b) => b.target).join(", ")}`
    : "not mounted";
  $("mount").disabled = on;
  $("unmount").disabled = !on;
  // Installing needs somewhere persistent to install to.
  $("install").disabled = !on;
  $("installBtn").disabled = !on || !$("install").files.length;
  $("alpine").disabled = !on || !!state.alpine;
  if (!on) { $("packages").disabled = true; $("packagesBtn").disabled = true; }
}

/**
 * Bring the disk up. Formatting is offered only when the disk genuinely has no
 * filesystem and the machine holds nothing: on a machine with chunks a mount
 * failure means something is wrong, and formatting would destroy the state the
 * user came back for.
 */
async function mountDisk() {
  $("mount").disabled = true;
  try {
    const empty = Object.keys(state.machine.manifest.chunks).length === 0;
    const result = await fsModule.open(guestRun, {
      allowFormat: empty,
      binds: BINDS,
      onStep: (s) => {
        if (s.type === "formatting") log("blank disk, putting a filesystem on it first");
        if (s.type === "bound") log(`${s.source} is now also ${s.target}`);
      }
    });
    setMounted(true);
    const distribution = await checkAlpine();
    if (distribution) {
      log(`this disk carries alpine ${distribution}; preparing its chroot`);
      await alpineModule.bootstrap(guestRun, { name: ALPINE_NAME });
      setAlpine(distribution);
    }

    await fsModule.ensureOnPath(guestRun);
    const shellPath = await fsModule.activateProfile(guestRun);
    if (shellPath.path.includes(fsModule.BIN)) {
      log(`${fsModule.MOUNTPOINT}/${fsModule.BIN} is on PATH, in this shell and on every boot`);
    }

    const paths = [result.mountpoint, ...result.bound.map((b) => b.target)].join(", ");
    log(result.formatted
      ? `formatted and mounted; one disk at ${paths}`
      : `mounted; one disk at ${paths}${result.alreadyMounted ? " (already was)" : ""}`, "ok");
    status(`One disk, visible at ${paths}. Write to any of them, then sync.`, "ok");
  } catch (err) {
    setMounted(false);
    log("mount failed: " + err.message, "bad");
    if (err.reason === fsModule.NO_FILESYSTEM) {
      // Refusing to format is the right outcome, so say why rather than
      // presenting it as a dead end.
      status("This machine has committed chunks but the disk has no readable " +
             "filesystem. Formatting would destroy it, so it was not done. " +
             "Check the branch, or restore to inspect what is there.", "bad");
    } else {
      status(err.message, "bad");
    }
    $("mount").disabled = false;
  }
}

$("mount").addEventListener("click", mountDisk);
$("unmount").addEventListener("click", async () => {
  $("unmount").disabled = true;
  try {
    // Binds come off first: they are separate mount entries onto the same
    // filesystem, and the disk cannot come down cleanly underneath them.
    const result = await fsModule.close(guestRun, { binds: BINDS });
    if (result.submounts.length) {
      log(`took down ${result.submounts.join(", ")} first`);
    }
    setMounted(false);
    setAlpine(state.alpine);   // the chroot is gone; its mounts are not there
    log(result.wasNotMounted ? "nothing was mounted" : "unmounted; the filesystem is clean", "ok");
  } catch (err) {
    log("unmount failed: " + err.message, "bad");
    if (err.output) {
      for (const line of String(err.output).split(/\r?\n/).slice(0, 3)) {
        if (line.trim()) log("  guest said: " + line.trim(), "bad");
      }
    }
    $("unmount").disabled = false;
  }
});

// --- the distribution on the disk --------------------------------------------

function setAlpine(version) {
  state.alpine = version || null;
  $("alpinestate").className = `mountstate${version ? " on" : ""}`;
  $("alpinestate").textContent = version ? `alpine ${version}, apk ready` : "no distribution";
  $("alpine").disabled = !!version || !state.mounted;
  $("packages").disabled = !version;
  $("packagesBtn").disabled = !version || !$("packages").files.length;
}

/** Report what is on the disk without changing anything. */
async function checkAlpine() {
  try {
    const version = await alpineModule.release(guestRun);
    setAlpine(version);
    return version;
  } catch { setAlpine(null); return null; }
}

$("alpine").addEventListener("click", async () => {
  $("alpine").disabled = true;
  try {
    log("--- putting a distribution on the disk ---");
    // From this page's own origin. No relay, no package mirror, no third party.
    const response = await fetch(ALPINE_ROOTFS);
    if (!response.ok) throw new Error(`${ALPINE_ROOTFS} is not being served`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    log(`fetched ${(bytes.length / 1048576).toFixed(2)} MB from this page's own origin`);

    state.emulator.create_file(ALPINE_NAME, bytes);
    const result = await alpineModule.bootstrap(guestRun, {
      name: ALPINE_NAME,
      onStep: (s) => {
        if (s.type === "unpacking") log("unpacking onto the disk, this takes a moment");
        if (s.type === "unpacked") log(`alpine ${s.release} unpacked`, "ok");
        if (s.type === "already-installed") log(`alpine ${s.release} was already here`);
        if (s.type === "prepared") log("proc, sys and dev mounted for the chroot");
        if (s.type === "ready") log(`${s.apk} runs inside it`, "ok");
      }
    });
    setAlpine(result.release);
    const packages = await alpineModule.installed(guestRun);
    log(`${packages.length} packages installed`);
    status(`Alpine ${result.release} is on the disk. Sync to keep it.`, "ok");
    meters();
  } catch (err) {
    log("could not put a distribution on the disk: " + err.message, "bad");
    if (err.output) log(err.output.split("\n").slice(0, 3).join(" | "), "bad");
    status(err.message, "bad");
    $("alpine").disabled = false;
  }
});

// --- packages ------------------------------------------------------------------

$("packages").addEventListener("change", () => {
  $("packagesBtn").disabled = !$("packages").files.length || !state.alpine;
});

$("packagesBtn").addEventListener("click", async () => {
  const files = [...$("packages").files];
  if (!files.length) return;
  $("packagesBtn").disabled = true;
  try {
    const total = files.reduce((sum, f) => sum + f.size, 0);
    log(`--- installing ${files.length} package${files.length > 1 ? "s" : ""}, ` +
        `${(total / 1048576).toFixed(1)} MB ---`);

    // Every package goes into the share first, then all are handed to apk at
    // once. Offline, apk resolves only the set it is given, so a package sent on
    // its own fails whenever something it needs is in the next file.
    for (const file of files) {
      state.emulator.create_file(file.name, new Uint8Array(await file.arrayBuffer()));
    }
    log(`${files.length} written to the transfer share`);

    const result = await alpineModule.installPackages(guestRun, {
      names: files.map((f) => f.name),
      onStep: (s) => {
        if (s.type === "staged") log(`staged ${s.name}`);
        if (s.type === "installing") log(`handing all ${s.count} to apk in one go`);
      }
    });

    log(result.added.length
      ? `installed: ${result.added.join(", ")}`
      : "apk reported success but nothing new appeared", "ok");
    status(`${result.added.length} packages installed. Sync to keep them.`, "ok");
    $("packages").value = "";
    meters();
  } catch (err) {
    log("install failed: " + err.message, "bad");
    if (err.output) {
      for (const line of err.output.split("\n").slice(0, 4)) if (line.trim()) log("  " + line.trim(), "bad");
    }
    status(err.message, "bad");
  }
  $("packagesBtn").disabled = !$("packages").files.length;
});

// --- installing a program ----------------------------------------------------
//
// No package manager, no network. A file goes in through the emulator's 9p
// share, which the guest mounts at /mnt, and from there onto the disk, which is
// the part that survives.

$("install").addEventListener("change", () => {
  $("installBtn").disabled = !$("install").files.length || !state.mounted;
});

$("installBtn").addEventListener("click", async () => {
  const file = $("install").files[0];
  if (!file) return;
  $("installBtn").disabled = true;
  try {
    log(`--- installing ${file.name} (${(file.size / 1024).toFixed(1)} KB) ---`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Into the share first. This lives in browser memory and is empty again
    // after a reload, so it is a staging area and never the destination.
    state.emulator.create_file(file.name, bytes);
    log(`written to the transfer share at ${fsModule.TRANSFER}/${file.name}`);

    const installed = await fsModule.install(guestRun, { name: file.name });
    log(`copied to ${installed.path} and made executable`, "ok");
    if (installed.kind) log(`what it is: ${installed.kind}`);

    // Reporting the architecture matters: a binary for the wrong one copies
    // perfectly and then fails to run with a message that explains nothing.
    if (/x86-64|ARM|aarch64/i.test(installed.kind)) {
      log("that is not an i686 binary; this guest will not be able to run it", "warn");
    } else if (/dynamically linked/i.test(installed.kind)) {
      log("dynamically linked: it needs uClibc, not glibc. A static build is safer.", "warn");
    }

    const onPath = await fsModule.rc(guestRun, `command -v ${file.name}`);
    log(onPath.ok
      ? `available as: ${file.name}`
      : `installed, but not on PATH under that name. Run it as ${installed.path}.`,
      onPath.ok ? "ok" : "warn");

    status(`${file.name} is on the disk. Sync to keep it, or it is gone on reload.`, "ok");
    meters();
  } catch (err) {
    log("install failed: " + err.message, "bad");
    status(err.message, "bad");
  }
  $("installBtn").disabled = false;
});

// --- the terminal takes input directly ---------------------------------------
//
// Not a text box that submits a line. Keystrokes are turned into the bytes a
// terminal sends and handed to the guest as they are pressed, and whatever comes
// back is displayed. Nothing is echoed locally: the tty echoes, and a terminal
// that echoed as well would double every character and would show a password
// the far side had deliberately stopped echoing.
//
// Everything that looks like a feature follows from that. History, tab
// completion, Ctrl+C and multi-line constructs work because the shell and the
// line discipline are doing them, not because this page implements them.

function sendToGuest(bytes) {
  if (!state.emulator || !bytes || !bytes.length) return;
  if (typeof state.emulator.serial_send_bytes === "function") {
    state.emulator.serial_send_bytes(0, new Uint8Array(bytes));
  } else {
    state.emulator.serial0_send(String.fromCharCode(...bytes));
  }
}

$("term").addEventListener("keydown", (event) => {
  if (!state.emulator) return;
  const bytes = keyToBytes(event);
  if (!bytes) return;          // let the browser keep its own shortcuts
  event.preventDefault();
  sendToGuest(bytes);
});

$("term").addEventListener("paste", (event) => {
  if (!state.emulator) return;
  event.preventDefault();
  const text = event.clipboardData.getData("text");
  if (!text) return;

  // A paste carrying a newline runs whatever preceded it without the user
  // pressing anything, which is how people end up running a line they did not
  // read. Terminals that care about this ask first.
  if (pasteNeedsConfirming(text)) {
    // Split for the preview only. Line endings vary, so normalise on the
    // line feed and drop any carriage return that came with it.
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const lines = text.trim().split(LF).map((l) => l.split(CR).join(""));
    const shown = lines.slice(0, 3).join(LF);
    const more = lines.length > 3 ? LF + "... and " + (lines.length - 3) + " more" : "";
    if (!confirm("Run " + lines.length + " lines in the guest?" + LF + LF + shown + more)) return;
  }
  sendToGuest(textToBytes(text));
});

$("term").addEventListener("focus", () => {
  if (terminal) { terminal.showCursor = true; terminal.render(); }
});
$("term").addEventListener("blur", () => {
  if (terminal) { terminal.showCursor = false; terminal.render(); }
});

// --- sync ------------------------------------------------------------------------

$("sync").addEventListener("click", async () => {
  enable(["sync", "compact", "restoreBtn"], false);
  try {
    log("--- sync ---");
    if (state.alpine) {
      // These are kernel state, not disk state. Leaving them mounted would
      // commit a filesystem with /proc and /dev grafted into it.
      await alpineModule.release_(guestRun);
      log("chroot mounts taken down before sealing");
    }
    const creating = state.machine.head === null;
    const result = await state.machine.sync({ message: $("message").value || undefined });
    if (result.skipped) {
      log("nothing dirty since the last sync");
      status("Nothing to sync.", "idle");
    } else if (creating && result.chunks === 0) {
      // The branch had to be created even with a clean disk, or the manifest
      // would never leave this tab.
      log(`created ${state.machine.branch} at ${result.commit.slice(0, 8)}; the disk is ` +
          `untouched so far, only the manifest was written`, "ok");
      addRow(result);
      status(`Branch ${state.machine.branch} now exists in the repository.`, "ok");
    } else {
      log(`${result.chunks} dirty chunks, ${result.uploaded} uploaded, ${result.reused} already present`);
      log(`${(result.bytesUploaded / 1048576).toFixed(2)} MB in ${result.requests} requests, ` +
          `${result.seconds.toFixed(1)}s -> ${result.commit.slice(0, 8)}`, "ok");
      addRow(result);
      status(`Synced to ${result.commit.slice(0, 8)}.`, "ok");
    }
    meters();
    setStep("s4", "on");
  } catch (err) {
    if (err instanceof ConflictError) {
      log(`conflict: ${err.overlappingChunks.length} chunks changed by both writers ` +
          `(${err.overlappingChunks.slice(0, 8).join(", ")}). Fork to a new branch.`, "bad");
      status("Conflicting writers. These states cannot be merged.", "bad");
    } else {
      log("ERROR: " + err.message, "bad");
      status(err.message, "bad");
    }
  }
  enable(["sync", "compact", "restoreBtn"], true);
});

function addRow(result) {
  const body = $("rows");
  if (body.dataset.empty) { body.innerHTML = ""; delete body.dataset.empty; }
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td>${state.machine.manifest.sync}</td>` +
    `<td>${result.chunks}</td>` +
    `<td class="hi">${result.uploaded}</td>` +
    `<td>${result.reused}</td>` +
    `<td>${(result.bytesUploaded / 1048576).toFixed(2)}</td>` +
    `<td>${result.requests}</td>` +
    `<td>${result.seconds.toFixed(1)}</td>`;
  body.appendChild(tr);
}

// --- compaction --------------------------------------------------------------------

$("compact").addEventListener("click", async () => {
  const caps = state.host.constructor.capabilities;
  if (!caps.orphanCommit) {
    status("This host cannot create a parentless commit, so history cannot be dropped atomically.", "bad");
    return;
  }
  if (!confirm(
    "Compaction rewrites the branch to a single parentless commit and discards its " +
    "history. On a full machine this reads the whole disk and can take minutes, " +
    "because it is bounded by the write rate rather than by bandwidth.\n\nContinue?"
  )) return;

  enable(["sync", "compact", "restoreBtn"], false);
  try {
    log("--- compaction ---");
    const result = await state.machine.compact({});
    log(`read ${result.chunksRead} chunks in ${result.readSeconds.toFixed(1)}s, ` +
        `${result.distinctObjects} distinct`);
    log(`uploaded ${result.uploaded}, ${result.unreachableAfter} objects now collectable, ` +
        `${result.requests} requests, ${result.seconds.toFixed(1)}s`, "ok");
    meters();
    status(`Compacted to ${result.commit.slice(0, 8)}. History dropped.`, "ok");
  } catch (err) {
    log("ERROR: " + err.message, "bad");
    status(err.message, "bad");
  }
  enable(["sync", "compact", "restoreBtn"], true);
});

// --- restore -----------------------------------------------------------------------

$("restoreBtn").addEventListener("click", async () => {
  enable(["sync", "compact", "restoreBtn"], false);
  try {
    log("--- restore from the repository alone ---");
    if (state.emulator) {
      try { await state.emulator.destroy(); } catch { /* already gone */ }
      state.emulator = null;
    }
    if (terminal) terminal.clear();

    const branch = $("branch").value.trim();
    const result = await restore({
      host: state.host, branch,
      cipher: state.cipher || undefined,
      // Restoration is base plus written chunks. A blank base takes the zeros
      // fast path; anything else must actually be fetched.
      fetchBase: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      onEvent: (e) => log(`restore: ${e.type}${e.url ? " " + e.url : ""}`)
    });
    log(`resolved ${branch} -> ${result.commit.slice(0, 8)}, applied ${result.chunksApplied} chunks`);

    state.emulator = new V86({
      wasm_path: `../vendor/v86/v86.wasm`,
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      screen_container: $("screen"),
      bios: { url: `${V86_ROOT}/bios/seabios.bin` },
      vga_bios: { url: `${V86_ROOT}/bios/vgabios.bin` },
      cdrom: { url: `${V86_ROOT}/images/linux4.iso` },
      hda: { buffer: result.disk.buffer },
      filesystem: {},
      autostart: true, disable_keyboard: true, disable_mouse: true
    });
    wireSerial();

    // Rebind the engine to the new emulator. The old device wrapped a buffer
    // belonging to an emulator that has just been destroyed, so leaving it in
    // place would make the next sync read a disk that no longer exists.
    state.device = new V86Device({
      emulator: state.emulator,
      diskSize: result.disk.length,
      flush: serialFlush(state.emulator, { prompt: /[#$%>]\s*$/ }),
      onEvent: (e) => log(`device ${e.type}: ${e.path} (${e.streamed ? "streamed" : "in memory"})`)
    });
    await state.device.waitForDevice(30000);
    state.machine = new Machine({
      host: state.host, device: state.device, branch,
      cipher: state.cipher, governor: state.governor
    });
    await state.machine.load();
    // The disk was built from this very state, so it is already put back.
    state.machine.markHydrated();
    state.device.start();

    await waitForPrompt(180000);
    meters();
    setMounted(false);
    await mountDisk();
    log("a machine rebuilt from the repository alone is running, and syncing " +
        "from here continues its history", "ok");
    status(`Rebuilt from ${result.commit.slice(0, 8)}. Check the shell.`, "ok");
  } catch (err) {
    log("ERROR: " + err.message, "bad");
    status(err.message, "bad");
  }
  enable(["restoreBtn", "sync", "compact"], true);
});

$("reset").addEventListener("click", () => location.reload());

if (location.protocol === "file:") {
  status("Serve this over http. Modules, wasm and the streamed disk all fail on file://.", "bad");
  enable(["connect"], false);
}
