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
| Three commit shapes compared on one workload: restore, storage, upload against history | `node src/analysis/compare-baselines.mjs` | no |
| restic, a real chunked store, on that same workload | `node src/analysis/restic-baseline.mjs` (needs `restic` and `rest-server` on PATH) | no |
| All four on a captured 43-sync history of a real machine | `node src/analysis/replay-history.mjs` | no |
| v86's native snapshot of that machine, and the wrapper's cost to the guest | `app/demo-native.js` from the browser console | no |
| Restore wall clock from GitHub, serial and eight-wide | `node src/analysis/restore-wallclock.mjs <owner/repo>` | **yes** |
| Write amplification and the chunk-size trade-off | `node src/analysis/report.mjs traces/mke2fs-256mb.json` | no |
| Every invariant the design rests on (742 tests, 14 suites) | see below | no |
| GitHub costs 20x the requests and 13x the time of a batch-commit host | `node src/analysis/batch-commit.mjs github <owner/repo>` then `gitlab` | **yes** |
| Whether a batch-commit host offers a compare-and-swap | `node src/analysis/cas-probe.mjs gitlab <owner/repo>` | **yes** |

`restore-scaling.mjs` runs 120 sequential syncs against an in-process host that
counts every request. The second half of its table is the result: the live set
stops growing while the history and the repository keep growing, and the restore
column stays flat. It emits LaTeX, which is what the paper's table is made of.

`compare-baselines.mjs` runs whole-image, delta-pack and chunk-exploded commit
shapes as working systems on byte-identical workloads, with every cost read off
one counting host so no shape reports its own. It emits the comparison table
and a CSV for plotting.

`restic-baseline.mjs` runs restic itself on the same write plan, against
`rest-server` on the loopback, with every request read off the server's access
log and storage off its directory. It needs both binaries installed (`winget
install restic.restic restic.server`, or the release archives); nothing leaves
the machine. At 1,000 syncs on 256 MB the result is in
`traces/restic-1000x256mb.csv`: restore grows one request per sync until
`repair index`, then 171 requests to ours at 404, for twice the bytes and 3.9
times the storage. `traces/restic-120x64mb-run{1,2,3}.csv` are three repeats of
the default run; restic's chunker is seeded per repository, and they agree
within one request and four percent of bytes.

`replay-history.mjs` runs the same four stores on a history a real guest wrote:
`traces/history/history.json` records 44 phases (format, Alpine, vim, then a
forty-step working session) with the chunks each one dirtied, which is enough
for the three in-process shapes. The chunk contents, 190 MB, are not in git;
restic needs them, and `app/demo-history.js` records them again in about two
minutes: serve the project with `python serve.py`, open `/app/`, and run the
snippet at the top of that file from the browser console. The results are in
`traces/history-replay.csv`.

`app/demo-native.js`, run the same way, measures the emulator's own
persistence on that machine: v86's `save_state` blob (443 MB, since it carries
the 256 MB of memory), how long it takes to save and to restore without a
reboot, and what the interception wrapper costs the guest (96 MB written
through the device, attached against detached, interleaved). Results go to
`traces/history/native.json`. `restore-wallclock.mjs` commits the same machine
to a throwaway branch and times its restore from the object API, serially and
eight-wide, three rounds each; it needs a token in `GITHUB_TOKEN` and deletes
the branch afterwards.

`report.mjs` reads a captured write trace and reports what each chunk size would
have cost. `traces/mke2fs-256mb.json` is a real capture of `mke2fs` on a 256 MB
disk, not a synthetic workload.

### Tests

```
for t in test test-engine test-device test-fs test-runner test-terminal \
         test-keyboard test-alpine test-sweep test-bisect test-nbd test-batch \
         test-baselines test-restic; do
  node src/$t.mjs
done
```

742 assertions. They need no network and no credentials. `test-nbd.mjs` speaks
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
