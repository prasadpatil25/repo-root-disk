// Tests for putting a distribution on the disk, against a scripted guest.
//
// The fake guest echoes each command and wraps it at eighty columns, the way a
// real serial console does, so the exit-status protocol is exercised rather than
// assumed.
//
// Run with: node src/test-alpine.mjs

import {
  isInstalled, release, unpack, prepare, release_, inside,
  useLocalRepository, addLocal, installed, bootstrap, stage, installPackages, RELEASE
} from "./guest/alpine.js";
import { MountError, MISSING, UNKNOWN } from "./guest/fs.js";

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name); console.log("  FAIL  " + name + (detail ? "   [" + detail + "]" : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function scriptedGuest(replies) {
  const seen = [];
  const run = async (command) => {
    const bare = command.replace(/; echo rc=\$\?$/, "");
    seen.push(bare);
    let reply = "", code = 0;
    for (const [pattern, value] of replies) {
      if (!pattern.test(bare)) continue;
      const resolved = typeof value === "function" ? value(bare, seen) : value;
      if (Array.isArray(resolved)) [reply, code] = resolved;
      else reply = resolved;
      break;
    }
    // A real console echoes the whole line it was sent, suffix included, and
    // wraps it at the terminal width.
    const echoed = command.match(/.{1,80}/g).join("\n");
    const body = [echoed, reply].filter(Boolean).join("\n");
    return command.endsWith("echo rc=$?") ? `${body}\nrc=${code}` : body;
  };
  run.seen = seen;
  return run;
}

/** A guest whose disk state changes as commands run. */
function livingGuest({ hasRelease = false } = {}) {
  const state = { hasRelease, mounts: new Set(), repositories: null };
  const run = scriptedGuest([
    [/test -f \/disk\/etc\/alpine-release/, () => ["", state.hasRelease ? 0 : 1]],
    [/test -f \/mnt\//, ["", 0]],
    [/^cat \/disk\/etc\/alpine-release/, () =>
      state.hasRelease ? ["3.20.10", 0] : ["", 1]],
    [/gzip -dc .* \| tar -x/, () => { state.hasRelease = true; return ["", 0]; }],
    [/mount \| grep -q ' (\S+) '/, (cmd) => {
      const path = cmd.match(/grep -q ' (\S+) '/)[1];
      return ["", state.mounts.has(path) ? 0 : 1];
    }],
    [/^mount -t|^mount --bind/, (cmd) => {
      // The destination is the last path on the line, whichever form was used.
      const target = cmd.replace(/\s*2>&1\s*$/, "").trim().split(/\s+/).pop();
      state.mounts.add(target);
      return ["", 0];
    }],
    [/^umount (\S+)/, (cmd) => { state.mounts.delete(cmd.split(" ")[1]); return ["", 0]; }],
    [/> \/disk\/etc\/apk\/repositories/, () => { state.repositories = true; return ["", 0]; }],
    [/apk --version/, ["apk-tools 2.14.4", 0]],
    [/apk info/, ["busybox\nmusl\napk-tools", 0]]
  ]);
  run.state = state;
  return run;
}

// -------------------------------------------------------------- detection

console.log("\nseeing what is already on the disk");
{
  const empty = livingGuest();
  check("a formatted but empty disk carries no distribution", !(await isInstalled(empty)));
  eq("and reports no release", await release(empty), null);

  const full = livingGuest({ hasRelease: true });
  check("a disk that has one is recognised", await isInstalled(full));
  eq("and names the release", await release(full), "3.20.10");
}

// ---------------------------------------------------------------- unpack

console.log("\nunpacking a rootfs onto the disk");
{
  const guest = livingGuest();
  const steps = [];
  const result = await unpack(guest, {
    name: "alpine-minirootfs-3.20.10-x86.tar.gz", onStep: (s) => steps.push(s.type)
  });
  eq("the release comes back", result.release, "3.20.10");
  eq("and the caller is told what happened", steps, ["unpacking", "unpacked"]);
  const extraction = guest.seen.find((c) => c.includes("tar -x"));
  check("extraction reads from the share and writes to the disk",
        /gzip -dc \/mnt\/alpine.*\| tar -x -C \/disk/.test(extraction), extraction);
  // busybox here was built without tar's compression applets, so -z is not an
  // option it has. Piping through gzip works whether or not it was.
  check("decompression does not rely on tar having -z",
        !/tar -[a-z]*z/.test(extraction), extraction);
  check("stderr is redirected for the group, not into the archive stream",
        /\} 2>&1$/.test(extraction), extraction);
}
{
  // The 9p share is browser memory and is empty again after a reload.
  const guest = scriptedGuest([[/test -f \/mnt\//, ["", 1]]]);
  let err = null;
  try { await unpack(guest, { name: "gone.tar.gz" }); } catch (e) { err = e; }
  eq("a rootfs that is not in the share is reported as missing", err.reason, MISSING);
  check("and nothing is extracted", !guest.seen.some((c) => c.includes("tar -x")));
}
{
  // Overlaying one distribution on another leaves a mixture neither package
  // manager can reason about, so this has to be refused rather than merged.
  const guest = livingGuest({ hasRelease: true });
  let err = null;
  try { await unpack(guest, { name: "alpine.tar.gz" }); } catch (e) { err = e; }
  check("unpacking over an existing distribution is refused", err instanceof MountError);
  check("and the message names what is already there",
        /3\.20\.10/.test(err.message), err.message);
  check("nothing was extracted", !guest.seen.some((c) => c.includes("tar -x")));
}
{
  // An archive that extracts but is not a rootfs.
  const guest = scriptedGuest([
    [/test -f \/mnt\//, ["", 0]],
    [/test -f \/disk\/etc\/alpine-release/, ["", 1]],
    [/^cat \/disk\/etc\/alpine-release/, ["", 1]],
    [/gzip -dc .* \| tar -x/, ["", 0]]
  ]);
  let err = null;
  try { await unpack(guest, { name: "not-a-rootfs.tar.gz" }); } catch (e) { err = e; }
  check("an archive that is not a rootfs is caught", err instanceof MountError);
  check("and says so", new RegExp(RELEASE).test(err.message), err.message);
}

// --------------------------------------------------------------- chroot

console.log("\npreparing a chroot");
{
  const guest = livingGuest({ hasRelease: true });
  const { mounted } = await prepare(guest);
  eq("proc, sys and dev are all mounted",
     mounted.map((m) => m.target), ["/disk/proc", "/disk/sys", "/disk/dev"]);
  check("dev is bound from the outer guest rather than created",
        guest.seen.some((c) => /^mount --bind \/dev \/disk\/dev/.test(c)),
        JSON.stringify(guest.seen.filter((c) => c.includes("dev"))));

  // These stack like any other mount, so a second boot must not pile them up.
  const again = await prepare(guest);
  check("preparing twice mounts nothing again",
        again.mounted.every((m) => m.alreadyMounted), JSON.stringify(again.mounted));

  const { released } = await release_(guest);
  eq("and they come down innermost first",
     released, ["/disk/dev", "/disk/sys", "/disk/proc"]);
}
{
  const guest = livingGuest({ hasRelease: true });
  const result = await inside(guest, "apk info");
  check("a command runs through chroot",
        guest.seen.some((c) => /^chroot \/disk \/bin\/sh -c 'apk info'/.test(c)),
        JSON.stringify(guest.seen));
  check("and its output comes back", result.output.includes("musl"), result.output);
}
{
  // Two levels of shell, so a quote in the command must not end the outer one.
  const guest = livingGuest({ hasRelease: true });
  await inside(guest, `echo 'hello world' > /tmp/x`);
  const sent = guest.seen.find((c) => c.startsWith("chroot"));
  check("single quotes are re-quoted rather than breaking the command",
        sent.includes(`'\\''hello world'\\''`), sent);
}

// ----------------------------------------------------------------- apk

console.log("\napk, offline");
{
  const guest = livingGuest({ hasRelease: true });
  const result = await useLocalRepository(guest);
  eq("apk is pointed at a local directory", result.repositories, "/var/cache/packages");
  check("the remote repository list is replaced, not appended to",
        guest.seen.some((c) => /> \/disk\/etc\/apk\/repositories/.test(c) && !c.includes(">>")),
        JSON.stringify(guest.seen.filter((c) => c.includes("repositories"))));
}
{
  const guest = livingGuest({ hasRelease: true });
  const list = await installed(guest);
  eq("apk lists what is installed", list, ["busybox", "musl", "apk-tools"]);
}
{
  const guest = scriptedGuest([
    [/apk add/, ["ERROR: unable to select packages: so:libfoo.so.1 (no such package)", 1]]
  ]);
  let err = null;
  try { await addLocal(guest, { file: "/var/cache/packages/vim.apk" }); } catch (e) { err = e; }
  check("a package with unmet dependencies fails loudly", err instanceof MountError);
  check("and apk's own words are kept",
        /no such package/.test(err.output), err.output);
}
{
  const guest = scriptedGuest([[/apk add/, ["OK: 12 MiB in 20 packages", 0]]]);
  const result = await addLocal(guest, { file: "/var/cache/packages/vim.apk" });
  check("a local package installs offline", result.output.includes("20 packages"));
  const sent = guest.seen.find((c) => c.includes("apk add"));
  // Offline means nothing is checked against a remote index. That is a real
  // reduction in assurance, so it should be visible in the command.
  check("with untrusted and no-network both explicit",
        sent.includes("--allow-untrusted") && sent.includes("--no-network"), sent);
}

// ---------------------------------------------------------- packages

console.log("\ninstalling packages the same way the rootfs arrived");
{
  const guest = scriptedGuest([
    [/test -f \/mnt\//, ["", 0]],
    [/^cp \/mnt\//, ["", 0]],
    [/apk info/, (cmd, seen) => {
      const done = seen.some((c) => c.includes("apk add"));
      return [done ? "busybox\nmusl\nncurses-libs\nvim" : "busybox\nmusl", 0];
    }],
    [/apk add/, ["OK: 30 MiB in 18 packages", 0]]
  ]);
  const steps = [];
  const result = await installPackages(guest, {
    names: ["vim-9.1.apk", "ncurses-libs-6.4.apk"], onStep: (s) => steps.push(s.type)
  });

  eq("each package is staged, then all are installed together",
     steps, ["staged", "staged", "installing", "installed"]);
  eq("and the caller learns what actually appeared", result.added, ["ncurses-libs", "vim"]);

  const add = guest.seen.find((c) => c.includes("apk add"));
  // One invocation, not one per file. A package with dependencies fails alone
  // and succeeds when its dependencies are named alongside it, because apk
  // resolves the set it is handed.
  eq("only one apk invocation", guest.seen.filter((c) => c.includes("apk add")).length, 1);
  check("carrying both packages",
        add.includes("vim-9.1.apk") && add.includes("ncurses-libs-6.4.apk"), add);
  check("read from the disk, not the transfer share",
        add.includes("/var/cache/packages/") && !add.includes("/mnt/"), add);
}
{
  // Staging is the same two-step the rootfs took: share to disk, then use it.
  const guest = scriptedGuest([[/test -f \/mnt\//, ["", 0]], [/^cp /, ["", 0]]]);
  const result = await stage(guest, { name: "vim-9.1.apk" });
  eq("a package lands in the cache on the disk", result.onDisk, "/disk/var/cache/packages/vim-9.1.apk");
  eq("and is named to apk by its path inside the chroot", result.path, "/var/cache/packages/vim-9.1.apk");
}
{
  const guest = scriptedGuest([[/test -f \/mnt\//, ["", 1]]]);
  let err = null;
  try { await stage(guest, { name: "gone.apk" }); } catch (e) { err = e; }
  eq("a package missing from the share is reported as missing", err.reason, MISSING);
  check("and nothing is copied", !guest.seen.some((c) => c.startsWith("cp ")));
}
{
  // The common offline failure: apk can only use what it is handed.
  const guest = scriptedGuest([
    [/test -f \/mnt\//, ["", 0]],
    [/^cp \/mnt\//, ["", 0]],
    [/apk info/, ["busybox\nmusl", 0]],
    [/apk add/, ["ERROR: unable to select packages:\n  so:libncursesw.so.6 (no such package)\n  required by: vim-9.1", 1]]
  ]);
  let err = null;
  try { await installPackages(guest, { names: ["vim-9.1.apk"] }); } catch (e) { err = e; }
  check("an unmet dependency fails", err instanceof MountError);
  check("and the message says what to do about it",
        /add that package to the same selection/.test(err.message), err.message);
  check("naming the dependency apk asked for",
        /libncursesw/.test(err.message), err.message);
}
{
  let err = null;
  try { await installPackages(scriptedGuest([]), { names: [] }); } catch (e) { err = e; }
  check("an empty selection is refused rather than running apk with no arguments",
        err instanceof Error, String(err));
}

// ----------------------------------------------------------- bootstrap

console.log("\nfrom a formatted disk to a working apk");
{
  const guest = livingGuest();
  const steps = [];
  const result = await bootstrap(guest, {
    name: "alpine-minirootfs-3.20.10-x86.tar.gz", onStep: (s) => steps.push(s.type)
  });
  eq("it unpacks, prepares and checks apk",
     steps, ["unpacking", "unpacked", "prepared", "ready"]);
  eq("reporting the release", result.release, "3.20.10");
  eq("and the apk that runs inside it", result.apk, "apk-tools 2.14.4");
  check("this was a fresh install", result.wasAlready === false);
}
{
  // The second boot of a machine that already has one: nothing to unpack, but
  // the chroot mounts are gone with the previous kernel and must be remade.
  const guest = livingGuest({ hasRelease: true });
  const steps = [];
  const result = await bootstrap(guest, { name: "alpine.tar.gz", onStep: (s) => steps.push(s.type) });
  eq("an existing distribution is not unpacked again",
     steps, ["already-installed", "prepared", "ready"]);
  check("and is reported as already there", result.wasAlready === true);
  check("nothing was extracted", !guest.seen.some((c) => c.includes("tar -x")));
}
{
  // Unpacked, but the binaries will not run: wrong architecture, or a musl
  // loader that is not where the binaries expect it.
  const guest = scriptedGuest([
    [/test -f \/mnt\//, ["", 0]],
    [/test -f \/disk\/etc\/alpine-release/, ["", 0]],
    [/^cat \/disk\/etc\/alpine-release/, ["3.20.10", 0]],
    [/mount \| grep -q/, ["", 1]],
    [/^mount -t|^mount --bind/, ["", 0]],
    [/> \/disk\/etc\/apk\/repositories/, ["", 0]],
    [/apk --version/, ["chroot: can't execute '/bin/sh': Exec format error", 1]]
  ]);
  let err = null;
  try { await bootstrap(guest, { name: "wrong-arch.tar.gz" }); } catch (e) { err = e; }
  check("a rootfs that cannot execute is caught rather than declared ready",
        err instanceof MountError);
  check("and the guest's own complaint is surfaced",
        /Exec format error/.test(err.message), err.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
