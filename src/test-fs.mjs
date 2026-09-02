// Tests for the guest mount helpers, against a scripted guest.
//
// The interesting cases are the failures. "Invalid argument" from busybox means
// a disk with no filesystem, and telling that apart from every other mount
// failure is what decides whether formatting is safe to offer.
//
// Run with: node src/test-fs.mjs

import {
  mount, unmount, format, open, close, bind, unbind, isMounted, classify,
  install, ensureOnPath, activateProfile, submounts,
  MountError, NO_FILESYSTEM, ALREADY_MOUNTED, MISSING, UNKNOWN
} from "./guest/fs.js";

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

/**
 * A guest that answers from a table of patterns. Records everything it was
 * asked, so the order of operations can be asserted.
 */
function scriptedGuest(replies) {
  const seen = [];
  const raw = [];
  const run = async (command) => {
    // Strip the status suffix the helper appends, and record the real command.
    const bare = command.replace(/; echo rc=\$\?$/, "");
    seen.push(bare);
    raw.push(command);

    let reply = "";
    let code = 0;
    for (const [pattern, value] of replies) {
      if (!pattern.test(bare)) continue;
      const resolved = typeof value === "function" ? value(bare, seen) : value;
      if (Array.isArray(resolved)) [reply, code] = resolved;
      else reply = resolved;
      break;
    }

    // A real serial console echoes the command before its output, and wraps
    // anything past the terminal width. Reproducing that here is the point: it
    // is what made sentinel words in the command unsafe to match on.
    const echoed = bare.match(/.{1,80}/g).join("\n");
    const body = [echoed, reply].filter(Boolean).join("\n");
    return command.endsWith("echo rc=$?") ? `${body}\nrc=${code}` : body;
  };
  run.seen = seen;
  run.raw = raw;   // exactly what was sent, suffix and all
  return run;
}

// --------------------------------------------------- reading the guest's reply

console.log("\ntelling output apart from the echoed command");
{
  // The bug this pins down. The console echoes the command before its output and
  // wraps past the terminal width, so `cmd && echo PRESENT` puts the word PRESENT
  // in the echo whether or not the command succeeded. Short commands survived
  // because the echo happened to be strippable; an 87-character one did not, and
  // ensureOnPath silently decided PATH was already set on every machine.
  const guest = scriptedGuest([[/grep -Fq/, ["", 1]]]);
  const result = await ensureOnPath(guest);
  check("a wrapped echo does not read as a result",
        result.alreadyPresent === false, JSON.stringify(result));
  // The invariant that makes it safe: what the parser looks for cannot appear in
  // what it sends. The command carries rc=$?; only output carries rc=<number>.
  const leaky = guest.raw.filter((c) => /rc=\d/.test(c));
  eq("no command can be mistaken for its own result", leaky, []);
}
{
  // The same shape for the install check: a file that is not there must not be
  // reported found because the word appears in the command.
  const missing = scriptedGuest([[/test -f/, ["", 1]]]);
  let err = null;
  try { await install(missing, { name: "a-name-long-enough-to-push-this-command-past-eighty-columns" }); }
  catch (e) { err = e; }
  eq("a missing file is still missing however long the command", err.reason, MISSING);
}
{
  // A guest that says nothing useful is an error, not a silent success.
  const mute = scriptedGuest([]);
  const silent = async () => "no status here";
  let err = null;
  try { await isMounted(silent); } catch (e) { err = e; }
  check("output with no exit status is refused", err instanceof MountError, String(err));
  void mute;
}

// ------------------------------------------------------------------ classify

console.log("\nreading what the guest said");
{
  eq("a blank disk", classify("mount: mounting /dev/sda on /disk failed: Invalid argument"), NO_FILESYSTEM);
  eq("a bad superblock", classify("mount: wrong fs type, bad superblock on /dev/sda"), NO_FILESYSTEM);
  eq("a missing mountpoint", classify("mount: mounting /dev/sda on /disk failed: No such file or directory"), MISSING);
  eq("an existing mount", classify("mount: /dev/sda is busy"), ALREADY_MOUNTED);
  eq("anything else stays unknown", classify("mount: something new went wrong"), UNKNOWN);
  eq("no output at all is not a diagnosis", classify(""), UNKNOWN);
}

// --------------------------------------------------------------------- mount

console.log("\nmounting");
{
  const run = scriptedGuest([[/^mount \/dev\/sda/, ["", 0]]]);
  const result = await mount(run);
  eq("it mounts where expected", result.mountpoint, "/disk");
  check("the mountpoint is created first", /^mkdir -p \/disk$/.test(run.seen[0]), run.seen[0]);
  check("and only then mounted", /^mount \/dev\/sda \/disk/.test(run.seen[1]), run.seen[1]);
}
{
  // The guest root comes from a read-only CD, so the mountpoint is gone on every
  // boot. Skipping the mkdir is the failure the user actually hit.
  const run = scriptedGuest([
    [/^mkdir/, ""],
    [/^mount \/dev\/sda/, (cmd, seen) =>
      seen.some((c) => /^mkdir/.test(c))
        ? ["", 0]
        : ["mount: mounting /dev/sda on /disk failed: No such file or directory", 1]]
  ]);
  const result = await mount(run);
  check("making the mountpoint is what lets the mount succeed", !!result.mountpoint);
}
{
  const run = scriptedGuest([
    [/^mount \/dev\/sda/, ["mount: mounting /dev/sda on /disk failed: Invalid argument", 1]]
  ]);
  let err = null;
  try { await mount(run); } catch (e) { err = e; }
  check("a blank disk raises a MountError", err instanceof MountError);
  eq("classified so a caller can offer to format", err.reason, NO_FILESYSTEM);
  check("and the message says what a blank disk means",
        /no filesystem yet/.test(err.message), err.message);
  check("the guest's own words are kept", /Invalid argument/.test(err.output));
}
{
  const run = scriptedGuest([[/^mount \/dev\/sda/, ["mount: /dev/sda is busy", 1]]]);
  const result = await mount(run);
  check("mounting something already mounted is not an error", result.alreadyMounted === true);
}

// ------------------------------------------------------------------- unmount

console.log("\nunmounting");
{
  const run = scriptedGuest([[/^umount/, ["", 0]]]);
  const result = await unmount(run);
  eq("it unmounts the mountpoint", result.mountpoint, "/disk");
}
{
  const run = scriptedGuest([[/^umount/, ["umount: /disk: not mounted", 1]]]);
  const result = await unmount(run);
  check("unmounting nothing is not an error", result.wasNotMounted === true);
}
{
  const run = scriptedGuest([[/^umount/, ["umount: /disk: target is busy", 1]]]);
  let err = null;
  try { await unmount(run); } catch (e) { err = e; }
  check("a genuine unmount failure is raised", err instanceof MountError);
}

// -------------------------------------------------------------------- format

console.log("\nformatting");
{
  const run = scriptedGuest([[/^mke2fs/, ["", 0]]]);
  const result = await format(run);
  eq("it formats the device", result.device, "/dev/sda");
}
{
  const run = scriptedGuest([[/^mke2fs/, ["mke2fs: No such device", 1]]]);
  let err = null;
  try { await format(run); } catch (e) { err = e; }
  check("a failed format is raised rather than assumed", err instanceof MountError);
}

// ---------------------------------------------------------------------- open

console.log("\nbringing the disk up");
{
  // A new machine: blank disk, nothing to lose, so formatting is allowed.
  let formatted = false;
  const run = scriptedGuest([
    [/^mke2fs/, () => { formatted = true; return ["", 0]; }],
    [/^mount \/dev\/sda/, () =>
      formatted ? ["", 0] : ["mount: mounting /dev/sda on /disk failed: Invalid argument", 1]]
  ]);
  const steps = [];
  const result = await open(run, { allowFormat: true, onStep: (s) => steps.push(s.type) });
  check("a blank disk is formatted and mounted", result.formatted === true);
  eq("and the caller is told what happened", steps, ["formatting", "mounted"]);
}
{
  // A machine that holds chunks. A mount failure here means something is wrong,
  // and formatting would destroy exactly the state the user came back for.
  const run = scriptedGuest([
    [/^mke2fs/, ["", 0]],
    [/^mount \/dev\/sda/, ["mount: mounting /dev/sda on /disk failed: Invalid argument", 1]]
  ]);
  let err = null;
  try { await open(run, { allowFormat: false }); } catch (e) { err = e; }
  check("a populated machine is never formatted to make it mount", err instanceof MountError);
  eq("the reason survives for the caller to explain", err.reason, NO_FILESYSTEM);
  check("and mke2fs was never run", !run.seen.some((c) => /mke2fs/.test(c)),
        JSON.stringify(run.seen));
}
{
  // Permission to format is not permission to format on any failure.
  const run = scriptedGuest([
    [/^mke2fs/, ["", 0]],
    [/^mount \/dev\/sda/, ["mount: mounting /dev/sda on /disk failed: No such file or directory", 1]]
  ]);
  let err = null;
  try { await open(run, { allowFormat: true }); } catch (e) { err = e; }
  eq("a missing device is not treated as a blank disk", err.reason, MISSING);
  check("so it is not formatted either", !run.seen.some((c) => /mke2fs/.test(c)));
}
{
  const run = scriptedGuest([[/^mount \/dev\/sda/, ["", 0]]]);
  const result = await open(run, { allowFormat: true });
  check("a disk that already has a filesystem is left alone", result.formatted === false);
  check("and mke2fs was never run", !run.seen.some((c) => /mke2fs/.test(c)));
}

// --------------------------------------------------------------------- binds

console.log("\nshowing one disk at several paths");
{
  const mounts = new Set();
  const run = scriptedGuest([
    [/grep -q ' (\S+) '/, (cmd) => {
      const path = cmd.match(/grep -q ' (\S+) '/)[1];
      return ["", mounts.has(path) ? 0 : 1];
    }],
    [/^mount --bind/, (cmd) => { mounts.add(cmd.split(" ")[3]); return "BIND-OK"; }]
  ]);
  const result = await bind(run, { source: "home", target: "/home" });
  eq("it binds a subdirectory of the disk", result.source, "/disk/home");
  check("both paths are created first",
        run.seen.some((c) => /^mkdir -p \/disk\/home \/home$/.test(c)), JSON.stringify(run.seen));

  // Binds stack silently if repeated, leaving mount entries to unwind one by one.
  const again = await bind(run, { source: "home", target: "/home" });
  check("binding twice is a no-op rather than a second mount", again.alreadyBound === true);
  eq("so only one bind was ever issued",
     run.seen.filter((c) => /^mount --bind/.test(c)).length, 1);
}
{
  const run = scriptedGuest([
    [/grep -q/, ["", 1]],
    [/^mount --bind/, ["mount: mounting /disk/home on /home failed: No such file or directory", 1]]
  ]);
  let err = null;
  try { await bind(run, { source: "home", target: "/home" }); } catch (e) { err = e; }
  check("a failed bind is raised, not assumed", err instanceof MountError);
}
{
  // Binding the whole disk rather than a subdirectory.
  const run = scriptedGuest([[/grep -q/, ["", 1]], [/^mount --bind/, ["", 0]]]);
  const result = await bind(run, { source: "", target: "/home" });
  eq("an empty source binds the mountpoint itself", result.source, "/disk");
}
{
  const bound = scriptedGuest([[/grep -q/, ["", 0]], [/^umount/, "UNBIND-OK"]]);
  const result = await unbind(bound, { target: "/home" });
  eq("unbinding releases the path", result.target, "/home");

  const never = scriptedGuest([[/grep -q/, ["", 1]]]);
  const noop = await unbind(never, { target: "/home" });
  check("unbinding something never bound is not an error", noop.wasNotBound === true);
  check("and issues no umount", !never.seen.some((c) => /^umount/.test(c)));
}
{
  // open() surfaces the extra paths, close() takes them down first.
  const mounts = new Set();
  const run = scriptedGuest([
    [/grep -q ' (\S+) '/, (cmd) => {
      const path = cmd.match(/grep -q ' (\S+) '/)[1];
      return ["", mounts.has(path) ? 0 : 1];
    }],
    [/^mount --bind/, (cmd) => { mounts.add(cmd.split(" ")[3]); return ["", 0]; }],
    [/^mount \/dev\/sda/, ["", 0]],
    [/^umount/, (cmd) => { mounts.delete(cmd.split(" ")[1]); return ["", 0]; }]
  ]);
  const binds = [{ source: "home", target: "/home" }, { source: "root", target: "/root" }];
  const steps = [];
  const opened = await open(run, { binds, onStep: (s) => steps.push(s.type) });
  eq("open mounts then binds each path", steps, ["mounted", "bound", "bound"]);
  eq("and reports what it bound", opened.bound.map((b) => b.target), ["/home", "/root"]);

  const order = [];
  // Echo back whatever token the command asked for, the way a real shell would.
  const closeRun = scriptedGuest([
    [/grep -q/, ["", 0]],
    [/^umount (\S+)/, (cmd) => { order.push(cmd.split(" ")[1]); return ["", 0]; }]
  ]);
  await close(closeRun, { binds });
  eq("close takes the binds off before the disk itself",
     order, ["/root", "/home", "/disk"]);
}

// ------------------------------------------------------------- installing

console.log("\ninstalling something onto the disk");
{
  const run = scriptedGuest([
    [/test -f \/mnt\/busybox-vi/, ["", 0]],
    [/^cp /, ["", 0]],
    [/^file /, "/disk/usr/local/bin/busybox-vi: ELF 32-bit LSB executable, Intel 80386, statically linked"]
  ]);
  const result = await install(run, { name: "busybox-vi" });
  eq("it lands on the disk, not the transfer share", result.path, "/disk/usr/local/bin/busybox-vi");
  check("and is made runnable",
        run.seen.some((c) => /^chmod \+x \/disk\/usr\/local\/bin\/busybox-vi$/.test(c)),
        JSON.stringify(run.seen));
  // A binary for the wrong architecture copies fine and then fails to run with a
  // message that explains nothing, so report what it actually is.
  check("what it is gets reported back", /Intel 80386/.test(result.kind), result.kind);
}
{
  // The 9p share is browser memory and is empty again after a reload, so a name
  // that is not there is the common case, not an exotic one.
  const run = scriptedGuest([[/test -f/, ["", 1]]]);
  let err = null;
  try { await install(run, { name: "gone" }); } catch (e) { err = e; }
  check("a file that is not in the share is reported clearly", err instanceof MountError);
  eq("as missing", err.reason, MISSING);
  check("and nothing was copied", !run.seen.some((c) => /^cp /.test(c)));
}
{
  const run = scriptedGuest([[/test -f/, ["", 0]], [/^cp /, ["cp: can't create: No space left", 1]]]);
  let err = null;
  try { await install(run, { name: "big" }); } catch (e) { err = e; }
  check("a failed copy is raised rather than assumed", err instanceof MountError);
  check("and it is not marked executable", !run.seen.some((c) => /chmod/.test(c)));
}

console.log("\nputting it on PATH for good");
{
  const run = scriptedGuest([[/grep -Fq/, ["", 1]]]);
  const result = await ensureOnPath(run);
  check("the profile gains the directory", result.alreadyPresent === false);
  check("written to a profile that lives on the disk",
        run.seen.some((c) => /\/root\/\.profile/.test(c)), JSON.stringify(run.seen));
  check("and the line exports the right path",
        run.seen.some((c) => c.includes('export PATH="$PATH:/disk/usr/local/bin"')),
        JSON.stringify(run.seen));
}
{
  // A profile that gathers a duplicate line on every boot grows without bound.
  const run = scriptedGuest([[/grep -Fq/, ["", 0]]]);
  const result = await ensureOnPath(run);
  check("a directory already on PATH is not added twice", result.alreadyPresent === true);
  check("and nothing is appended", !run.seen.some((c) => /echo .*>>/.test(c)));
}
{
  // The shell starts before the disk is mounted, so it read the CD's profile.
  const run = scriptedGuest([
    [/\. \/root\/\.profile/, "/bin:/sbin:/usr/bin:/usr/sbin:/disk/usr/local/bin"]
  ]);
  const result = await activateProfile(run);
  check("sourcing it updates the running shell",
        result.path.includes("/disk/usr/local/bin"), result.path);
}

// ------------------------------------------------------ taking the disk down

console.log("\nunmounting a disk that has things mounted inside it");
{
  // The reported failure. Mount, then a chroot puts proc, sys and dev inside the
  // disk, then unmount. A filesystem with submounts cannot be unmounted, and
  // close() used to know only about the binds the caller named.
  const mounts = new Set(["/disk", "/home", "/root", "/disk/proc", "/disk/sys", "/disk/dev"]);
  const order = [];
  const run = scriptedGuest([
    [/mount \| awk/, () =>
      [[...mounts].filter((m) => m.startsWith("/disk/")).join("\n"), 0]],
    [/mount \| grep -q ' (\S+) '/, (cmd) => {
      const path = cmd.match(/grep -q ' (\S+) '/)[1];
      return ["", mounts.has(path) ? 0 : 1];
    }],
    [/^umount (\S+)/, (cmd) => {
      const target = cmd.split(" ")[1];
      // A real kernel refuses this, which is exactly what went wrong.
      const inner = [...mounts].some((m) => m.startsWith(target + "/"));
      if (inner) return ["umount: can't unmount " + target + ": Resource busy", 1];
      mounts.delete(target);
      order.push(target);
      return ["", 0];
    }]
  ]);

  const binds = [{ source: "home", target: "/home" }, { source: "root", target: "/root" }];
  const result = await close(run, { binds });

  eq("the chroot mounts come off first, deepest first",
     order.slice(0, 3).sort(), ["/disk/dev", "/disk/proc", "/disk/sys"]);
  eq("then the binds, in reverse", order.slice(3, 5), ["/root", "/home"]);
  eq("and the disk itself last", order[5], "/disk");
  eq("the caller is told what was taken down first",
     result.submounts.sort(), ["/disk/dev", "/disk/proc", "/disk/sys"]);
  check("nothing is left mounted", mounts.size === 0, [...mounts].join(", "));
}
{
  // Deeper nesting still has to unwind from the inside out.
  const mounts = new Set(["/disk", "/disk/a", "/disk/a/b"]);
  const order = [];
  const run = scriptedGuest([
    [/mount \| awk/, () => [[...mounts].filter((m) => m.startsWith("/disk/")).join("\n"), 0]],
    [/mount \| grep -q/, ["", 1]],
    [/^umount (\S+)/, (cmd) => {
      const target = cmd.split(" ")[1];
      if ([...mounts].some((m) => m.startsWith(target + "/"))) return ["Resource busy", 1];
      mounts.delete(target); order.push(target); return ["", 0];
    }]
  ]);
  await close(run, { binds: [] });
  eq("the deeper mount comes off before the shallower one",
     order, ["/disk/a/b", "/disk/a", "/disk"]);
}
{
  const run = scriptedGuest([[/mount \| awk/, ["", 0]], [/mount \| grep -q/, ["", 1]], [/^umount/, ["", 0]]]);
  const result = await close(run, { binds: [] });
  eq("a disk with nothing inside it reports no submounts", result.submounts, []);
}
{
  // Busy for a reason we cannot clear: say so usefully rather than "failed".
  const run = scriptedGuest([
    [/mount \| grep -q/, ["", 0]],
    [/^umount/, ["umount: /home: target is busy", 1]]
  ]);
  let err = null;
  try { await unbind(run, { target: "/home" }); } catch (e) { err = e; }
  eq("a busy bind is classified, not lumped in with unknown failures",
     err.reason, ALREADY_MOUNTED);
  check("and the message suggests where to look",
        /working directory|mount underneath/.test(err.message), err.message);
  check("the guest's own words are kept", /target is busy/.test(err.output), err.output);
}

// ---------------------------------------------------------------- isMounted

console.log("\nchecking the mount state");
{
  const mounted = scriptedGuest([[/grep -q/, ["", 0]]]);
  check("a mounted disk reads as mounted", await isMounted(mounted));
  const not = scriptedGuest([[/grep -q/, ["", 1]]]);
  check("an unmounted one does not", !(await isMounted(not)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
