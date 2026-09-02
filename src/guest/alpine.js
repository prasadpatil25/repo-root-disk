// Putting a real distribution on the disk.
//
// The guest that boots from the CD is Buildroot with uClibc. It has no package
// manager, and it cannot acquire a useful one: nothing in any mainstream
// repository is built against uClibc. Copying an apk binary onto it would
// produce a working package manager with no installable packages.
//
// So the distribution goes on the disk instead. An Alpine minirootfs is musl
// based and ships apk, and once it is unpacked onto the disk a chroot into it is
// a real Alpine userland. Everything apk writes then lands on the disk, which is
// the thing that syncs to the repository.
//
// That also removes the reason the bind mounts existed. They were scaffolding to
// make a few paths persistent under a root filesystem that was not. With the
// distribution itself on the disk, persistence is the default rather than a
// thing arranged path by path.
//
// No network is involved. The tarball is served from the same static origin as
// the page and injected through the emulator's 9p share, and packages are
// installed from local files the same way.

import { MOUNTPOINT, TRANSFER, MountError, MISSING, UNKNOWN, rc } from "./fs.js";

/** Marker file that says a distribution is unpacked on the disk. */
export const RELEASE = "etc/alpine-release";

/** Mounts a chroot needs before anything inside it will behave. */
const CHROOT_MOUNTS = [
  { type: "proc", source: "proc", target: "proc" },
  { type: "sysfs", source: "sys", target: "sys" },
  { bind: "/dev", target: "dev" }
];

/** Whether a distribution is already unpacked on the disk. */
export async function isInstalled(run, { mountpoint = MOUNTPOINT } = {}) {
  const { ok } = await rc(run, `test -f ${mountpoint}/${RELEASE}`);
  return ok;
}

/** Which release, for a disk that already has one. */
export async function release(run, { mountpoint = MOUNTPOINT } = {}) {
  const { ok, output } = await rc(run, `cat ${mountpoint}/${RELEASE} 2>/dev/null`);
  return ok ? output.split(/\r?\n/).pop().trim() : null;
}

/**
 * Unpack a rootfs tarball from the transfer share onto the disk.
 *
 * The outer guest's busybox tar does the work, so the archive has to be one it
 * can read. Alpine ships gzip, which busybox handles.
 *
 * @param {string} options.name filename as it appears in the 9p share
 */
export async function unpack(run, {
  name, mountpoint = MOUNTPOINT, transfer = TRANSFER, timeoutMs = 600000, onStep = () => {}
} = {}) {
  const archive = `${transfer}/${name}`;

  const present = await rc(run, `test -f ${archive}`);
  if (!present.ok) {
    throw new MountError(
      MISSING,
      `${name} is not in ${transfer}. The emulator writes it there, and the share ` +
      `is empty again after a reload.`,
      present.output
    );
  }

  // Refuse to unpack over an existing installation. Overlaying one distribution
  // on another leaves a mixture that neither package manager can reason about.
  if (await isInstalled(run, { mountpoint })) {
    const existing = await release(run, { mountpoint });
    throw new MountError(
      UNKNOWN,
      `the disk already carries a distribution (${existing}). Unpacking over it ` +
      `would leave a mixture of two. Format the disk first if that is what you want.`
    );
  }

  onStep({ type: "unpacking", archive, mountpoint });

  // Decompress through gzip rather than asking tar to do it. This image's
  // busybox tar was built without the compression applets, so -z is not an
  // option it has; piping works either way. Redirecting stderr for the group
  // rather than per command matters: putting 2>&1 on gzip alone would fold its
  // error text into the archive stream that tar is reading.
  const extracted = await rc(
    run, `{ gzip -dc ${archive} | tar -x -C ${mountpoint} ; } 2>&1`, timeoutMs
  );
  if (!extracted.ok) {
    throw new MountError(UNKNOWN, `unpacking ${name} onto the disk failed.`, extracted.output);
  }

  const version = await release(run, { mountpoint });
  if (!version) {
    throw new MountError(
      UNKNOWN,
      `${name} unpacked but left no ${RELEASE}. Is it a rootfs archive?`,
      extracted.output
    );
  }

  onStep({ type: "unpacked", release: version });
  return { release: version, mountpoint };
}

/**
 * Prepare the mounts a chroot needs. Without /proc a package manager cannot
 * read its own environment, and without /dev it cannot write anything.
 *
 * Idempotent, because these stack the same way any other mount does.
 */
export async function prepare(run, { mountpoint = MOUNTPOINT } = {}) {
  const mounted = [];
  for (const spec of CHROOT_MOUNTS) {
    const target = `${mountpoint}/${spec.target}`;
    const already = await rc(run, `mount | grep -q ' ${target} '`);
    if (already.ok) { mounted.push({ target, alreadyMounted: true }); continue; }

    await rc(run, `mkdir -p ${target}`);
    const command = spec.bind
      ? `mount --bind ${spec.bind} ${target} 2>&1`
      : `mount -t ${spec.type} ${spec.source} ${target} 2>&1`;
    const { ok, output } = await rc(run, command);
    if (!ok) throw new MountError(UNKNOWN, `preparing ${target} failed.`, output);
    mounted.push({ target, alreadyMounted: false });
  }
  return { mounted };
}

/** Take those mounts back down, innermost first. */
export async function release_(run, { mountpoint = MOUNTPOINT } = {}) {
  const released = [];
  for (const spec of [...CHROOT_MOUNTS].reverse()) {
    const target = `${mountpoint}/${spec.target}`;
    const mounted = await rc(run, `mount | grep -q ' ${target} '`);
    if (!mounted.ok) continue;
    await rc(run, `umount ${target} 2>&1`);
    released.push(target);
  }
  return { released };
}

/**
 * Run a command inside the distribution on the disk.
 *
 * Single quotes in the command are re-quoted for the shell, so a caller can pass
 * an ordinary command line without thinking about the two levels of shell it
 * passes through.
 */
export async function inside(run, command, { mountpoint = MOUNTPOINT, timeoutMs } = {}) {
  const quoted = command.replace(/'/g, `'\\''`);
  return rc(run, `chroot ${mountpoint} /bin/sh -c '${quoted}' 2>&1`, timeoutMs);
}

/**
 * Point apk at a local package directory rather than the network.
 *
 * The minirootfs ships remote repository URLs, which cannot resolve here. A
 * local directory of .apk files with an index is what apk reads instead.
 */
export async function useLocalRepository(run, {
  mountpoint = MOUNTPOINT, dir = "/var/cache/packages"
} = {}) {
  await rc(run, `mkdir -p ${mountpoint}${dir}`);
  const { ok, output } = await rc(
    run, `echo '${dir}' > ${mountpoint}/etc/apk/repositories 2>&1`
  );
  if (!ok) {
    throw new MountError(UNKNOWN, `pointing apk at ${dir} failed.`, output);
  }
  return { repositories: dir };
}

/**
 * Install a package from a local .apk file.
 *
 * Offline, so nothing is fetched and nothing is verified against a remote index:
 * --allow-untrusted is what makes a local file installable at all. That is a
 * real reduction in assurance and the caller should know it, which is why it is
 * spelled out here rather than buried in a flag.
 */
export async function addLocal(run, {
  file, mountpoint = MOUNTPOINT, timeoutMs = 300000
} = {}) {
  const result = await inside(
    run, `apk add --allow-untrusted --no-network ${file}`, { mountpoint, timeoutMs }
  );
  if (!result.ok) {
    throw new MountError(UNKNOWN, `apk could not install ${file}.`, result.output);
  }
  return { file, output: result.output };
}

/** Where staged packages live inside the distribution. */
export const CACHE = "/var/cache/packages";

/**
 * Copy a package from the transfer share into the distribution's cache.
 *
 * The same two-step the rootfs took: the browser writes into the 9p share, which
 * is memory and does not survive a reload, and the guest copies from there onto
 * the disk, which does.
 */
export async function stage(run, {
  name, mountpoint = MOUNTPOINT, transfer = TRANSFER, dir = CACHE
} = {}) {
  const present = await rc(run, `test -f ${transfer}/${name}`);
  if (!present.ok) {
    throw new MountError(
      MISSING,
      `${name} is not in ${transfer}. The emulator writes it there, and the share ` +
      `is empty again after a reload.`,
      present.output
    );
  }

  await rc(run, `mkdir -p ${mountpoint}${dir}`);
  const copied = await rc(run, `cp ${transfer}/${name} ${mountpoint}${dir}/${name} 2>&1`);
  if (!copied.ok) {
    throw new MountError(UNKNOWN, `staging ${name} onto the disk failed.`, copied.output);
  }
  return { name, path: `${dir}/${name}`, onDisk: `${mountpoint}${dir}/${name}` };
}

/**
 * Stage a set of packages and install them in one apk invocation.
 *
 * One invocation, not one per file, and that is the whole point. A package with
 * dependencies fails on its own but succeeds when its dependencies are named
 * alongside it, because apk resolves the set it is given. Installing them one at
 * a time would fail on whichever happened to come first.
 */
export async function installPackages(run, {
  names, mountpoint = MOUNTPOINT, transfer = TRANSFER, dir = CACHE,
  timeoutMs = 600000, onStep = () => {}
} = {}) {
  if (!names || !names.length) throw new Error("no packages given");

  const staged = [];
  for (const name of names) {
    staged.push(await stage(run, { name, mountpoint, transfer, dir }));
    onStep({ type: "staged", name });
  }

  const before = await installed(run, { mountpoint });
  const paths = staged.map((s) => s.path).join(" ");
  onStep({ type: "installing", count: staged.length });

  const result = await inside(
    run, `apk add --allow-untrusted --no-network ${paths}`, { mountpoint, timeoutMs }
  );
  if (!result.ok) {
    throw new MountError(
      UNKNOWN,
      unmetDependency(result.output)
        ? `apk could not install these: ${unmetDependency(result.output)} is missing. ` +
          `Offline, apk can only use what it is handed, so add that package to the ` +
          `same selection.`
        : `apk could not install ${names.join(", ")}.`,
      result.output
    );
  }

  const after = await installed(run, { mountpoint });
  const added = after.filter((p) => !before.includes(p));
  onStep({ type: "installed", added });
  return { staged: staged.map((s) => s.name), added, output: result.output };
}

/** The dependency apk complained about, if that is what went wrong. */
function unmetDependency(output) {
  const match = (output || "").match(/required by:|unable to select packages:\s*([^\n]*)/i);
  if (!match) return null;
  const missing = (output.match(/so:(\S+)|^\s*(\S+)\s+\(no such package\)/im) || [])
    .filter(Boolean).slice(1)[0];
  return missing || null;
}

/** What apk thinks is installed. A cheap way to prove the chroot works. */
export async function installed(run, { mountpoint = MOUNTPOINT } = {}) {
  const result = await inside(run, "apk info", { mountpoint });
  if (!result.ok) throw new MountError(UNKNOWN, "apk did not run.", result.output);
  return result.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Everything needed to go from a formatted disk to a usable Alpine: unpack,
 * mount what a chroot needs, and point apk somewhere that exists.
 */
export async function bootstrap(run, {
  name, mountpoint = MOUNTPOINT, transfer = TRANSFER, onStep = () => {}
} = {}) {
  const already = await isInstalled(run, { mountpoint });
  let version;
  if (already) {
    version = await release(run, { mountpoint });
    onStep({ type: "already-installed", release: version });
  } else {
    ({ release: version } = await unpack(run, { name, mountpoint, transfer, onStep }));
  }

  await prepare(run, { mountpoint });
  onStep({ type: "prepared" });
  await useLocalRepository(run, { mountpoint });

  const check = await inside(run, "apk --version", { mountpoint });
  if (!check.ok) {
    throw new MountError(
      UNKNOWN,
      `Alpine is on the disk but apk will not run inside it. ${check.output}`,
      check.output
    );
  }
  onStep({ type: "ready", apk: check.output.split(/\r?\n/).pop().trim() });

  return { release: version, apk: check.output.split(/\r?\n/).pop().trim(), wasAlready: already };
}
