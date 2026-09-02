# Repo as Root Disk

A browser-native Linux VM whose disk is committed into a git repository. The
guest's dirty block set becomes a commit, so a machine's state has a version
history and can be rebuilt on any device from a reference alone. There is no
server: a static page, the user's repository, and the user's browser.

This is the artifact for a paper of the same name, which is under review. The
manuscript is not distributed here; this repository is the code, the harnesses
and the data behind its measurements.

The engine does not know what a browser is. The contract it needs from a device
is five operations wide, and there are three implementations of it: in memory
for the tests, over v86's buffer for the browser, and over NBD for a real Linux
kernel.

## Requirements

Node 20 or newer (developed on 22). No build step, no bundler, no framework.
Python 3 for the static server. A TeX installation only if you want to rebuild
the paper. 

## Reproducing the paper

Everything below runs from the repository root. The three that need no
credentials are the ones to start with, and they cover the paper's central
claims.

| Claim in the paper | Command | Needs a token |
|---|---|---|
| Restore cost is the live set plus three requests, constant in history | `node src/analysis/restore-scaling.mjs` | no |
| Write amplification and the chunk-size trade-off | `node src/analysis/report.mjs traces/mke2fs-256mb.json` | no |
| Every invariant the design rests on (618 tests, 12 suites) | see below | no |
| GitHub costs 20x the requests and 13x the time of a batch-commit host | `node src/analysis/batch-commit.mjs github <owner/repo>` then `gitlab` | **yes** |
| Whether a batch-commit host offers a compare-and-swap | `node src/analysis/cas-probe.mjs gitlab <owner/repo>` | **yes** |

`restore-scaling.mjs` runs 120 sequential syncs against an in-process host that
counts every request. The second half of its table is the result: the live set
stops growing while the history and the repository keep growing, and the restore
column stays flat. It emits LaTeX, which is what the paper's table is made of.

`report.mjs` reads a captured write trace and reports what each chunk size would
have cost. `traces/mke2fs-256mb.json` is a real capture of `mke2fs` on a 256 MB
disk, not a synthetic workload.

### Tests

```
for t in test test-engine test-device test-fs test-runner test-terminal \
         test-keyboard test-alpine test-sweep test-bisect test-nbd test-batch; do
  node src/$t.mjs
done
```

618 assertions. They need no network and no credentials. `test-nbd.mjs` speaks
the client half of the NBD protocol over a real socket, so the wire format and
the server loop are exercised rather than mocked; the one hop that needs Linux
is `nbd-client` binding the export to `/dev/nbd0`.

## Before you run anything that takes a token

**The two credentialed harnesses write real commits to a real repository and
consume real rate limit.** `batch-commit.mjs` uploads roughly 60 MB of random
data by default and leaves a branch behind, which it names on exit for you to
delete. Point them at a repository you are willing to fill with junk. Shrink a
run with `SIZES=1,2,4 ROUNDS=2 MAX_CHUNKS=16`.

Tokens are read from the environment, never from an argument, because arguments
are visible in the process table to every user on the machine:

```
GITHUB_TOKEN=... node src/analysis/batch-commit.mjs github owner/repo
GITLAB_TOKEN=... node src/analysis/batch-commit.mjs gitlab owner/repo
```

Use a fine-grained token scoped to the one repository, with the shortest expiry
your workflow tolerates. Rotation is the only revocation this design offers.

## The browser machine

```
python serve.py
```

then open `/app/`. Nothing else is needed: the emulator, its wasm, the BIOS and
the ISO are all committed, and a blank disk is built in the tab rather than
downloaded, so no disk image is fetched at all.

`spike-b/` and `spike-c/` are earlier prototypes, kept because the paper refers
to their measurements. Those two still load a blank image from disk, so if you
want to run them, create the zeros they expect:

```
truncate -s 16M  spike-c/images/blank-16mb.img
truncate -s 256M spike-c/images/blank-256mb.img
truncate -s 16M  spike-b/images/blank-16mb.img
```

## Attaching a repository to a real kernel

Linux only, and the last hop needs root:

```
GIT_DISK_TOKEN=... node src/nbd-daemon.mjs --host github --repo owner/name \
    --branch machine-1 --size 512M
```

```
modprobe nbd
nbd-client 127.0.0.1 10809 /dev/nbd0 -N disk
mkfs.ext4 /dev/nbd0        # first time only
mount /dev/nbd0 /mnt/disk
```

Unmount before stopping the daemon, or it commits a filesystem the kernel was
still writing to.

## Layout

```
src/core/       the sync engine: chunker, manifest, governor, machine, bisect
src/device/     the five-operation device contract, and its three implementations
src/host/       GitHub, GitLab and Forgejo adapters behind one interface
src/guest/      driving a guest shell: exit codes, mounts, Alpine, apk
src/ui/         terminal renderer and keyboard mapping
src/analysis/   the measurement harnesses behind the paper's tables
traces/         captured write traces
vendor/         redistributed third-party material; see NOTICE
```


## Licence

MIT, see `LICENSE`. Third-party material under `vendor/` keeps its own licences;
see `NOTICE`.

