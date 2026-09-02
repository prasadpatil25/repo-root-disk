// Mounting the machine's disk inside the guest.
//
// A note on what this is. The repository is not a filesystem and cannot be
// mounted. It holds chunks of a block device. Hydration puts those chunks onto
// the emulated disk, and this mounts that disk. The consequences of the
// distinction are real: writes in the guest do not reach the repository until a
// sync, and commits made elsewhere do not reach the guest until it reboots and
// hydrates again.
//
// The guest boots from a read-only CD, so its root filesystem is fresh on every
// boot and the mountpoint has to be created each time. That is why mounting is
// worth a button rather than being left to the user.
//
// Every function here takes a `run(command) => Promise<string>` so the logic can
// be tested without a virtual machine.

export const DEVICE = "/dev/sda";

// Not under /mnt. The emulator's 9p filesystem auto-mounts there, and nesting
// the persistent disk inside a filesystem that lives in browser memory is a good
// way to lose track of which of the two a file is on.
export const MOUNTPOINT = "/disk";

/** Where the emulator's 9p share appears. The way bytes get into the guest. */
export const TRANSFER = "/mnt";

/** Directory on the disk for binaries the user installs, relative to the mount. */
export const BIN = "usr/local/bin";


// --- talking to the guest ----------------------------------------------------
//
// The serial console echoes every command back before its output, and a line
// longer than the terminal width comes back wrapped, so a caller cannot reliably
// strip the echo. That makes `cmd && echo OK` unsafe: the word OK appears in the
// echoed command whether or not the command worked, and a wrapped line turns a
// failure into a false success.
//
// Exit status has no such problem. The command carries the literal `rc=$?`,
// while only the output can carry `rc=` followed by a number.

/**
 * Whether the guest is sitting at a prompt.
 *
 * Testing the tail for a prompt character alone is not enough. A command still
 * being echoed ends, for one byte, with whatever character precedes the rest,
 * and `; echo rc=$?` ends with `$` at that instant. A caller polling then reads
 * a half-echoed command as a finished one. Two conditions rule that out: the
 * echo has ended, which the newline proves, and the last line is short, which a
 * prompt is and a wrapped command line is not.
 */
export function atPrompt(tail, { prompt = /[#$%>]\s*$/, maxLength = 24 } = {}) {
  if (!tail) return false;
  const lines = tail.split(/\r?\n/);
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1];
  return last.length <= maxLength && prompt.test(last);
}

export async function rc(run, command, timeoutMs) {
  const sent = `${command}; echo rc=$?`;
  // Wait for the marker itself rather than for a prompt. The command carries
  // `rc=$?` and only the output can carry `rc=` followed by a number, so this
  // cannot fire early no matter how the echo is wrapped or timed.
  const output = await run(sent, {
    timeoutMs,
    until: (tail) => /rc=\d/.test(tail)
  });
  const matches = [...output.matchAll(/rc=(\d+)/g)];
  if (!matches.length) {
    throw new MountError(UNKNOWN, `no exit status came back from: ${command}`, output);
  }
  const code = Number(matches[matches.length - 1][1]);
  const body = output.slice(0, output.lastIndexOf("rc="));
  return { code, ok: code === 0, output: stripEcho(body, sent) };
}

/**
 * Remove the command the console echoed back, so what remains is only what the
 * command printed.
 *
 * The echo arrives wrapped at the terminal width, so it cannot be matched line
 * by line. Comparing with whitespace squeezed out finds where it ends however it
 * was broken up. If the leading text turns out not to be the echo, nothing is
 * removed: guessing would eat real output.
 */
function stripEcho(output, sent) {
  const squash = (text) => text.replace(/\s+/g, "");
  const target = squash(sent);
  const lines = output.split(/\r?\n/);

  let accumulated = "";
  for (let i = 0; i < lines.length; i++) {
    accumulated += squash(lines[i]);
    if (accumulated === target) return lines.slice(i + 1).join("\n").trim();
    if (!target.startsWith(accumulated)) break;
  }
  return output.trim();
}

/** Why a mount failed, in terms a caller can act on. */
export const NO_FILESYSTEM = "no-filesystem";
export const ALREADY_MOUNTED = "already-mounted";
export const MISSING = "missing";
export const UNKNOWN = "unknown";

export class MountError extends Error {
  constructor(reason, message, output) {
    super(message);
    this.name = "MountError";
    this.reason = reason;
    this.output = output;
  }
}

/**
 * Classify what the guest said. busybox mount reports a bare errno, so the same
 * message covers several causes and the wording differs between builds.
 */
export function classify(output) {
  const text = (output || "").toLowerCase();
  if (/busy/.test(text)) return ALREADY_MOUNTED;
  // "Invalid argument" is what a disk with no filesystem produces. So does a
  // wrong explicit fs type, but this always mounts by autodetection.
  if (/invalid argument|wrong fs type|bad superblock|invalid superblock/.test(text)) {
    return NO_FILESYSTEM;
  }
  if (/no such file or directory|not found/.test(text)) return MISSING;
  return UNKNOWN;
}

/** Whether anything is mounted at the mountpoint. */
export async function isMounted(run, { mountpoint = MOUNTPOINT } = {}) {
  const { ok } = await rc(run, `mount | grep -q ' ${mountpoint} '`);
  return ok;
}

/**
 * Create the mountpoint and mount the disk.
 *
 * @throws {MountError} with `reason` set, so a caller can offer to format only
 *   when the disk genuinely has no filesystem.
 */
export async function mount(run, { device = DEVICE, mountpoint = MOUNTPOINT } = {}) {
  await rc(run, `mkdir -p ${mountpoint}`);
  const { ok, output: out } = await rc(run, `mount ${device} ${mountpoint} 2>&1`);
  if (ok) return { mountpoint, device };

  const reason = classify(out);
  if (reason === ALREADY_MOUNTED) return { mountpoint, device, alreadyMounted: true };
  throw new MountError(reason, mountFailureMessage(reason, device, mountpoint), out);
}

function mountFailureMessage(reason, device, mountpoint) {
  if (reason === NO_FILESYSTEM) {
    return `${device} carries no filesystem yet. A new machine starts as a blank ` +
           `disk and has to be formatted once before it can hold files.`;
  }
  if (reason === MISSING) {
    return `${device} or ${mountpoint} does not exist in the guest. Is this kernel ` +
           `built with the IDE driver?`;
  }
  return `mounting ${device} on ${mountpoint} failed.`;
}

/**
 * Unmount, which also forces the guest to write out everything it was holding.
 *
 * Syncing does not require this: the flush strategy runs `sync`, which writes
 * dirty pages to the device. Unmounting additionally marks the filesystem clean,
 * which is worth doing before walking away from a machine.
 */
export async function unmount(run, { mountpoint = MOUNTPOINT } = {}) {
  const { ok, output: out } = await rc(run, `umount ${mountpoint} 2>&1`);
  if (ok) return { mountpoint };
  if (/not mounted|no such/i.test(out)) return { mountpoint, wasNotMounted: true };
  throw new MountError(UNKNOWN, `unmounting ${mountpoint} failed.`, out);
}

/**
 * Put a filesystem on the disk. This destroys whatever was there, so the caller
 * is responsible for knowing the machine is empty or for asking first.
 */
export async function format(run, { device = DEVICE, timeoutMs = 300000 } = {}) {
  const { ok, output: out } = await rc(run, `mke2fs -q ${device} 2>&1`, timeoutMs);
  if (!ok) {
    throw new MountError(UNKNOWN, `formatting ${device} failed.`, out);
  }
  return { device };
}

/**
 * Show a directory of the disk at a second path.
 *
 * One branch is one device is one filesystem, and a filesystem can appear at as
 * many paths as you like. A bind is the right tool rather than mounting the
 * device twice, because it can expose a subdirectory: one disk can hold /home
 * and anything else side by side, each surfacing where the guest expects it.
 * Both views are the same superblock, so a write through one is immediately
 * visible through the other.
 *
 * Idempotent. Binds stack silently if repeated, leaving a pile of mount entries
 * that have to be unwound one at a time.
 *
 * @param {string} options.source path on the disk, relative to the mountpoint
 * @param {string} options.target absolute path in the guest
 */
export async function bind(run, { source, target, mountpoint = MOUNTPOINT } = {}) {
  if (await isMounted(run, { mountpoint: target })) {
    return { target, alreadyBound: true };
  }
  const from = source ? `${mountpoint}/${source}` : mountpoint;
  await rc(run, `mkdir -p ${from} ${target}`);
  const { ok, output: out } = await rc(run, `mount --bind ${from} ${target} 2>&1`);
  if (!ok) {
    throw new MountError(classify(out), `binding ${from} to ${target} failed.`, out);
  }
  return { target, source: from, alreadyBound: false };
}

export async function unbind(run, { target } = {}) {
  if (!(await isMounted(run, { mountpoint: target }))) return { target, wasNotBound: true };
  const { ok, output: out } = await rc(run, `umount ${target} 2>&1`);
  if (!ok) {
    const reason = classify(out);
    throw new MountError(
      reason,
      reason === ALREADY_MOUNTED
        // busybox says "busy" for both. Naming the likely cause saves the reader
        // guessing, since the shell sitting in a bound directory is the common one.
        ? `${target} is in use, so it cannot be unbound. Something is still inside ` +
          `it: a shell whose working directory is there, or a mount underneath it.`
        : `unbinding ${target} failed.`,
      out
    );
  }
  return { target };
}

/**
 * Bring the disk up: mount it, format first only when it is genuinely blank and
 * the machine holds nothing worth protecting, then surface any extra paths.
 *
 * `allowFormat` must be false for a machine that has chunks. A mount failure
 * there means something is wrong, and formatting would destroy the very state
 * the user came back for.
 *
 * @param {Array<{source: string, target: string}>} [options.binds]
 */
export async function open(run, {
  device = DEVICE, mountpoint = MOUNTPOINT, allowFormat = false,
  binds = [], onStep = () => {}
} = {}) {
  let result;
  let formatted = false;
  try {
    result = await mount(run, { device, mountpoint });
    onStep({ type: result.alreadyMounted ? "already-mounted" : "mounted", mountpoint });
  } catch (err) {
    if (!(err instanceof MountError) || err.reason !== NO_FILESYSTEM) throw err;
    if (!allowFormat) throw err;

    onStep({ type: "formatting", device });
    await format(run, { device });
    result = await mount(run, { device, mountpoint });
    formatted = true;
    onStep({ type: "mounted", mountpoint });
  }

  const bound = [];
  for (const spec of binds) {
    const b = await bind(run, { ...spec, mountpoint });
    bound.push(b);
    if (!b.alreadyBound) onStep({ type: "bound", source: b.source, target: b.target });
  }

  return { ...result, formatted, bound };
}

/**
 * Take the disk down. Binds come off first: they are separate mount entries onto
 * the same filesystem, and leaving them behind means the next boot finds paths
 * pointing at a device that is no longer there.
 */
/**
 * Everything mounted inside the disk, deepest first.
 *
 * A chroot puts proc, sys and dev in here, and they are kernel state that no
 * caller of close() should have to remember on its behalf.
 */
export async function submounts(run, { mountpoint = MOUNTPOINT } = {}) {
  const { output } = await rc(run, `mount | awk '{print $3}' | grep '^${mountpoint}/' || true`);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${mountpoint}/`))
    // Deepest first: /disk/a/b has to come off before /disk/a.
    .sort((a, b) => b.split("/").length - a.split("/").length);
}

export async function close(run, { mountpoint = MOUNTPOINT, binds = [] } = {}) {
  // A filesystem with things mounted inside it cannot be unmounted, so those go
  // first. Leaving this to the caller meant unmounting worked after a sync,
  // which tears the chroot down for its own reasons, and failed otherwise.
  const inner = [];
  for (const target of await submounts(run, { mountpoint })) {
    const { ok, output } = await rc(run, `umount ${target} 2>&1`);
    if (!ok) throw new MountError(classify(output), `unmounting ${target} failed.`, output);
    inner.push(target);
  }

  const unbound = [];
  for (const spec of [...binds].reverse()) {
    unbound.push(await unbind(run, { target: spec.target }));
  }
  const result = await unmount(run, { mountpoint });
  return { ...result, unbound, submounts: inner };
}

// --- installing things ------------------------------------------------------
//
// This guest has no package manager and, by default, no network. Bytes get in
// through the emulator's 9p share, which the image mounts at /mnt: the browser
// writes a file with emulator.create_file(), and it appears there.
//
// That share lives in browser memory and does not survive a reload, so anything
// worth keeping has to be copied onto the disk. These helpers do that, and put
// the destination on PATH in a profile that is itself on the disk.
//
// A binary must match the guest, not the host: this image is i686 with uClibc,
// so a static i686 build is the safe choice. A glibc-linked binary will not run.

/**
 * Copy a file from the 9p share onto the disk and make it runnable.
 *
 * @param {string} options.name filename as it appears in the transfer share
 * @param {string} [options.dir] destination on the disk, relative to the mount
 */
export async function install(run, {
  name, mountpoint = MOUNTPOINT, transfer = TRANSFER, dir = BIN, executable = true
} = {}) {
  const target = `${mountpoint}/${dir}`;
  const path = `${target}/${name}`;

  const present = await rc(run, `test -f ${transfer}/${name}`);
  if (!present.ok) {
    throw new MountError(
      MISSING,
      `${name} is not in ${transfer}. The emulator has to write it there first, ` +
      `and the share is empty again after a reload.`,
      present.output
    );
  }

  await rc(run, `mkdir -p ${target}`);
  const copied = await rc(run, `cp ${transfer}/${name} ${path} 2>&1`);
  if (!copied.ok) {
    throw new MountError(UNKNOWN, `copying ${name} onto the disk failed.`, copied.output);
  }
  if (executable) await rc(run, `chmod +x ${path}`);

  // Report what it actually is. A binary for the wrong architecture copies
  // perfectly well and then fails to run with a message that explains nothing.
  const kind = (await rc(run, `file ${path} 2>/dev/null || head -c 20 ${path} | od -c | head -1`)).output;
  return { name, path, kind: kind.trim() };
}

/**
 * Make sure a directory is on PATH for future shells, by way of a profile that
 * lives on the disk and therefore survives a reboot.
 *
 * Idempotent: a profile that gathers a duplicate PATH line on every boot grows
 * without bound and is tedious to clean up by hand.
 */
export async function ensureOnPath(run, {
  mountpoint = MOUNTPOINT, dir = BIN, profile = "/root/.profile"
} = {}) {
  const target = `${mountpoint}/${dir}`;
  const line = `export PATH="$PATH:${target}"`;
  const already = await rc(run, `grep -Fq '${target}' ${profile} 2>/dev/null`);
  if (already.ok) return { profile, dir: target, alreadyPresent: true };

  await rc(run, `mkdir -p $(dirname ${profile}) && echo '${line}' >> ${profile}`);
  return { profile, dir: target, alreadyPresent: false };
}

/**
 * Apply the profile to the shell that is already running.
 *
 * The shell starts at boot, before the disk is mounted, so it read whatever
 * profile the CD provided rather than the one on the disk. Without this the
 * user's PATH only takes effect on the next boot.
 */
export async function activateProfile(run, { profile = "/root/.profile" } = {}) {
  const out = (await rc(run, `test -f ${profile} && . ${profile}; echo $PATH`)).output;
  return { profile, path: out.trim().split(/\r?\n/).pop() };
}
