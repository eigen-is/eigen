# Proposal: File-descriptor budget — graceful exhaustion

> **Status — Proposal, written 2026-07-05, reconciled 2026-07-06 against the merged
> storage-audit fixes (AUDIT_STORAGE.md) and 2026-08-04 against the 2026-07-14 home-lifecycle
> changes (per-type idle windows, collab keepalive `touchHomeIfLoaded`, `peek()` seam) —
> nothing of this proposal is built.** Every open Home costs ~30 file
> descriptors (SQLite WAL triples + maildir watchers). A cross-home fan-out under a small
> `ulimit -n` exhausts them and SQLite starts failing with `SQLITE_IOERR`, which today degrades
> *silently* (skipped recipients, swallowed watcher errors). The compose deployment pins the
> limit high since 2026-07-04; this proposal covers the rest: a startup check that warns loudly
> on a small limit (phase 1, S), deploy documentation for non-compose installs (phase 1, S),
> and an optional LRU cap on resident Homes with a retry-once valve in `ManagedDatabase.open`
> (phase 2, M, gated on need). Smallest honest design — no resource-manager framework.

## Problem

During the 2026-07-04 slow-share investigation, sharing a path to a 26-member team fanned out
`drive:acl-change` to 26 recipient Homes. On a dev machine with macOS's default `ulimit -n 256`,
the fan-out crashed with `SQLITE_IOERR_VNODE` mid-delivery and **silently skipped recipients** —
the per-recipient `catch` in `queueACLFanOut` (`apps/api/src/lib/drive/acl-propagation.ts`) logs
and moves on. Nothing told the operator the process was out of file descriptors.

The fan-out is bounded now (`FAN_OUT_CONCURRENCY = 8` semaphore in `acl-propagation.ts`), and
`docker-compose.yml` pins the limit for the `eigen-api` service:

```yaml
ulimits:
  nofile:
    soft: 1048576
    hard: 1048576
```

But the semaphore bounds *concurrent opens*, not *resident* Homes — each delivered Home stays
open for its idle window, which is per-type since 2026-07-14: `UserHome` 5 minutes
(`idleMs` in `apps/api/src/lib/home/home.ts`), `TeamHome` 30 minutes
(`TEAM_HOME_IDLE_MS`, `apps/api/src/lib/home/team-home.ts`). The longer team window is a
deliberate trade — team homes have no SSE keep-alive pin — and it **raises** resident-home fd
pressure: a team home touched once holds its descriptors six times longer than a user home
(fewer than a warm `UserHome`'s 30 — no mailbox watchers — but held six times as long).
The compose pin only covers compose. Bare-metal/systemd
deployments and dev machines still run on distro defaults (1024 soft is common; 256 on macOS),
where the failure mode is unchanged: no warning, then I/O errors in whatever subsystem happens
to open the next file.

## fd accounting (measured from code)

A fully warm `UserHome` (`apps/api/src/lib/home/user-home.ts`) holds:

| Held by | Files | fds |
|---|---|---|
| Default mount `metadata.db` (`Mount`, `mount/db-config.ts`) | main + `-wal` + `-shm` | 3 |
| `eigen.mail/mail.db` (`MailDB`) | WAL triple | 3 |
| `eigen.contacts/contacts.db` (`Contacts`) | WAL triple | 3 |
| `eigen.calendar/calendar.db` (`Calendar`) | WAL triple | 3 |
| `eigen.notifications/notifications.db` (`NotificationCenter`) | WAL triple | 3 |
| `mounts/shared.db` (`drive/shared.ts`, opened eagerly by `Drive.init`) | WAL triple | 3 |
| Maildir watchers (`MaildirStore.watch`: 6 `STANDARD_MAILBOXES` incl. INBOX × {`cur`,`new`}) | `fs.watch` handles | 12 |
| **Total** | | **30** |

All 6 DBs open **eagerly** during `Home.init` (`Drive.init` opens `shared.db`
unconditionally); the watcher count is **12** — `STANDARD_MAILBOXES` is
`['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']`, each watched on both `cur/` and `new/`
(`MaildirStore.watch`). So 30 fds is the warm ceiling, not the top of a 25–30 range — and it
is paid at open time, which is exactly the crash arithmetic: 26 fan-out opens ≈ 780 fds
against a 256 limit. The `ROADMAP.md` row already carries these measured figures; the
`docker-compose.yml` comment above the `ulimits` pin still says "~25-30 fds … ~10 maildir
fs.watch handles … ~35 homes" and updates in phase 1.

Per-home cost is **variable**:

- **+3 per extra mount** (each mount opens its own `metadata.db`). Homes with many mounts cost
  more; mounts on remote storage also run an `UploadQueue`/`ContentReindexQueue` (timers plus
  transient staging-file fds during `VACUUM INTO` + upload).
- **+3–6 per open document container** — `Mount.documentDbs` caches a `ManagedDatabase` per open
  `data.db`, and `CollabDocument` speculatively warms the sibling `comments.db`.
- **TeamHome**: no mail/contacts/notifications → `calendar.db` + per-mount `metadata.db` +
  `shared.db`, ~6–12 fds. **GuestHome** ~6–9. **OrgHome** ~0 (no subsystems).

Process-wide, independent of Homes: `users3.db` (auth — `auth.ts` opens two drizzle
connections), `eigen.db` (share registry), `waitlist.db`, the listening socket, one socket per
HTTP request / SSE stream / collab WebSocket, and the S3 client's connection pool.

**Derivation.** With soft limit `L` and a process reserve `R ≈ 256` (sockets, server DBs,
headroom), the safe resident-home count is `(L − R) / 30`: ~25 homes at the common 1024 default
(the compose comment's "~35" is the no-reserve ceiling), effectively zero at macOS's 256 — which
is exactly why 26 homes crashed — and a non-issue at the pinned 1,048,576.

## Phase 1 — startup check + deploy docs (S, ships immediately)

### Reading the soft limit

A small `checkFdBudget()` in `apps/api/src/lib/config/` (same shape as `env.ts` helpers), called
from `apps/api/src/index.ts` before `app.listen`:

- **Primary, cross-platform**: `process.report.getReport().userLimits.open_files` — the Node
  diagnostic report (since v12) that Bun implements too; verified on this repo's runtime
  (Bun 1.3.14) returning `{"soft":1048576,"hard":"unlimited"}`. One in-process call, no procfs
  parser, no subprocess. Note the values can be the string `"unlimited"`, not just numbers.
- **Fallback** if the report is absent: `ulimit` is a shell builtin and the child inherits our
  rlimits, so `Bun.spawnSync(['sh', '-c', 'ulimit -n'])` reports our own soft limit.
- Anything unparseable (or `unlimited`): log one debug line and skip. The check must never
  block boot.

### Threshold and message

Warn when `soft < R + MIN_HOMES × 30` with `R = 256`, `MIN_HOMES = 50` → warn below 1,756. That
flags every distro default (1024, 256) and passes any deliberate setting (4096+). The warning is
a loud multi-line `console.error` at startup naming the limit, the ~30 fds/home cost, and the
exact remedy per environment:

- systemd: `LimitNOFILE=1048576` in the unit
- compose: the `ulimits: nofile:` block (already pinned in `docker-compose.yml`)
- macOS dev: `launchctl limit maxfiles`

No admin notification: the audience is the operator reading logs at deploy time, and a
notification would re-fire on every boot with no in-app action to take. Log only.

### Deploy documentation

- **`docker/SETUP-GUIDE.md`** — the install doc. Add a short note under *Alternative
  deployments*: anyone running the API outside the bundled compose (host process behind their
  own proxy, future systemd unit) must raise `nofile`, with the `LimitNOFILE=1048576` line.
  The Quick Start path needs nothing — compose pins it.
- **`docs/PROPOSAL_SINGLE_MACHINE_CLUSTER.md`** — both capacity-story corrections (fds, not
  memory, are the binding resource; each `eigen-api-1..3` service needs the `ulimits` block)
  are folded into that doc as of 2026-08-04. Nothing left to do here.
- **Propagate the corrected figures** (one source per fact): the `docker-compose.yml` comment
  block above the `ulimits` pin ("~25-30 fds … ~10 maildir fs.watch handles … ~35 homes")
  updates to the measured 30-fd warm ceiling and 12 watchers. (`ROADMAP.md` already carries
  the corrected figures.)

Also fix a broken window found while reading: `MaildirStore.watch` swallows *all* `fs.watch`
errors as "directory may not exist yet". Under fd pressure that hides `EMFILE` — log anything
that isn't a missing directory.

## Phase 2 — LRU cap on resident Homes (M, optional, gated on need)

The compose pin plus the startup check remove the production risk; build this only when a
deployment cannot raise its limit or bare-metal reports pressure. Designed now so the seam is
agreed.

### Seam

`getHome` (`apps/api/src/lib/home/get-home.ts`) owns the `homeFactories` map;
`Home.touch()` already fires on every subsystem access and arms the per-type idle destruct
(5 min user, 30 min team). The cap adds: a last-touch timestamp per owner (expose `lastTouched`
on `Home`, set in `touch()`), and after installing a new factory, if `homeFactories.size > N`,
evict the least-recently-touched homes that pass the safety predicate via the existing
`evictHome()` — which already does the race-guarded shutdown-then-delete.

The map is typed `Map<string, AsyncSingleton<Home>>` and already exposes the read-only
`peek()` seam that `touchHomeIfLoaded` uses — it returns the resolved instance without
triggering the factory. The LRU sweep reuses it as-is: reading `lastTouched` and the safety
predicate off `peek()` never resurrects a home that is still loading or already gone.

### Eviction safety

Never evict a home that:

- has SSE listeners attached (expose a `hasClients` accessor over `sseListeners`);
- hosts a live collab session — a **positive** open-connections check over the collab registry's
  `CollabDocument` connections. The "stale `lastTouched`" half of this argument is outdated: since
  2026-07-14 the collab keepalive tick calls `touchHomeIfLoaded(ownerId)`
  (`apps/api/src/lib/home/get-home.ts`, wired from `apps/api/src/routes/collab.ts`), so an open
  editor keeps the *hosting* home's `lastTouched` live even when the editor's own SSE stream is on
  a different home — the alternative once floated in this bullet is the thing that shipped, and it
  closed the >5-minute cross-owner-editing-session hole in the idle destruct too. What `lastTouched`
  still cannot express is the **tick gap**: between two keepalive ticks a home with N live editors
  looks idle, and evicting it runs `Home.destruct` → collab teardown, killing the sessions
  server-side with no client resubscribe path. So the predicate keeps a direct
  "does this home host any open collab connections?" check; it is now a narrow race guard over a
  live signal, not a stand-in for a missing one;
- has a mount with a non-empty `UploadQueue` or a draining `ContentReindexQueue` — like
  `hasClients`/`lastTouched`, these need small accessors: `UploadQueue.pendingCount` is public,
  but the reindex queue's drain state, `Drive`'s mounts, and `Mount`'s queue fields are
  private/internal today;
- was touched within the last 30 seconds. Every request path goes through the `home.drive` /
  `home.mail` getters, all of which `touch()`, so a min-idle threshold is the flat, honest
  stand-in for an in-flight-request counter — no counting framework. The same threshold covers
  pending outbox deliveries once the durable outbox exists, because its drain touches the home.

If nothing is evictable, don't evict — exceed N and let the idle timers catch up. The cap is a
pressure valve, not an invariant.

### Close-vs-request races

`createAsyncSingleton` caches the resolved instance forever, so eviction can't stop a caller
that already resolved it. `getHome` already handles the converse: a cached home with
`destructing` set is awaited to full teardown (`shutdown()` is idempotent against the in-flight
`destruct()`) before the entry is dropped and re-created — LRU eviction rides that exact path.
The residual window — a request holding a `Home` reference across an eviction hits
`'Database not open'` — exists today with the idle destruct; the 30-second min-idle
guard makes it rarer, and it fails loud (500 + log), not silent. Two audit fixes (2026-07-06)
already hardened the close path eviction rides: document-DB open now waits on any in-flight
close of the same `pathId` (`closingDocumentDbs`, `mount/document-db.ts`), so an eviction
closing a container's `data.db` cannot interleave with a concurrent reopen; and
`ManagedDatabase.close()` tears down unconditionally (try/finally), so a home whose close-sync
throws still releases its fds — which is the whole point of a pressure valve.

### Retry-once emergency valve

When the cap is still too high for the actual limit, `ManagedDatabase.open`
(`apps/api/src/lib/core/managed-database.ts`) is where exhaustion lands: `openCold`'s
`new BunDatabase(...)` or the WAL pragmas throw `SQLITE_IOERR*` (`SQLITE_IOERR_VNODE` on macOS,
`SQLITE_CANTOPEN`/`EMFILE` shapes on Linux). Wrap the `openCold` call: on a first
exhaustion-shaped error, evict one LRU home and retry `openCold` once, logging at error level
either way. One retry, no loop. One care point: the hook is wired by **module-level
registration** — `setFdExhaustionHandler(fn)` in `managed-database.ts`, registered from
`get-home.ts` at boot, mirroring `ContentReindexQueue`'s injected extract dep — because a
direct core→home import would be an upward import plus a module cycle, and
`scripts/check-home-imports.ts` only greps the literal `getHome`, so the inversion would ship
silently past the lint.

Two storage-audit fixes (merged 2026-07-06) simplify and de-risk this valve; do not re-add
what they already cover:

- **Failed-open cleanup is now inside `openCold` itself** — a throw from the WAL pragmas or a
  migration closes and nulls `rawDb` before the error propagates (AUDIT_STORAGE item 8). The
  retry wrapper therefore only classifies, evicts, and re-calls `openCold`; it must NOT add
  its own handle cleanup (double-close hazard).
- **Error classification is now unambiguous.** The strict GC-assisted close eliminated the
  zombie-close→`SQLITE_IOERR_VNODE` reopen bug (a lazy close unlinking `-shm` under a live
  statement poisoned the next open of the same file). Before that fix, `SQLITE_IOERR_VNODE`
  at open could mean either fd exhaustion or the zombie-shm bug — and the valve would have
  masked the latter by evicting an innocent home. Now it is an exhaustion signal, so
  evict-and-retry is the right recovery, not a band-aid over a reopen bug. (The rare
  `Bun.gc(true)` inside `close()` fires only on its fallback path, so eviction stays cheap.)

### Choosing N

Not a magic number — derived at boot from the same read the startup check does:
`N = clamp(floor((soft − 256) / 60), 8, 512)` — half the theoretical `(soft − R)/30` max, the
other half left for sockets, document DBs, and multi-mount variance. Pinned compose → 512
(effectively uncapped); 1024 soft → 12; 256 → 8 (churny, but degrading to eviction instead of
`SQLITE_IOERR`, and the startup check already screamed). Env override
`EIGEN_MAX_RESIDENT_HOMES` for tests and as an operator escape hatch.

### Composition with the home-relay outbox

`PROPOSAL_HOME_RELAY_OUTBOX.md` (being written concurrently) adds a **global home-open
concurrency budget** — a bound on *in-flight opens* (flow). The LRU cap bounds *resident homes*
(stock). They compose without coordination: a fan-out opens at most `budget` homes concurrently,
each install may evict the least-recently-used resident, so residency overshoots N by at most
the open budget. The outbox's per-seam predecessor is today's `FAN_OUT_CONCURRENCY` semaphore.

## Failure honesty

Today fd pressure is invisible until SQLite errors, and even then the ACL fan-out logs per
recipient and continues, while `MaildirStore.watch` swallows `EMFILE` entirely. After this work,
pressure is visible at three points: the startup warning (before it can bite), an error-level
log line whenever LRU eviction or the retry-once valve fires (`[Home] LRU evicted <owner>
(resident=N)` / `[ManagedDatabase] <name>: SQLITE_IOERR, evicted LRU home, retrying`), and the
un-swallowed watcher errors. The log lines are the counters — grep-able, alertable from the
compose log driver; a metrics endpoint is out of scope. Periodic fd-pressure logging via
`scheduleInterval` (`apps/api/src/lib/scheduler/`) was considered and dropped: `/proc/self/fd`
counting is Linux-only and the three points above cover the honest signal (D3).

## Testing

- **Limit reader** (phase 1): unit tests over the diagnostic-report shapes — numeric and
  `"unlimited"` `userLimits.open_files` values, a missing report — plus the `ulimit -n`
  fallback output (`256`, `unlimited`, garbage).
- **LRU** (phase 2): extract victim selection as a pure function over
  `(ownerId, lastTouched, evictable)` tuples; unit-test eviction order and every safety
  predicate. One integration test with `EIGEN_MAX_RESIDENT_HOMES=2` opening the three
  `getTestContext()` homes: assert the least-recently-touched closes, and a home with an SSE
  subscriber or an open collab connection never does.
- **Retry-once** (phase 2): unit-level — stub the cold-open seam to throw `SQLITE_IOERR` once,
  assert one eviction-hook call, one retry, success, and the log line.
- **rlimit integration test**: lowering `nofile` is unprivileged, so
  `Bun.spawn(['sh', '-c', 'ulimit -n 128 && exec bun test …'])` works portably — but it means
  booting the whole API in a child process, and the single-file test recipe (preload,
  `--concurrency 1`) makes that fragile. **Recommendation: skip it**; the parser and retry unit
  tests plus the pinned compose limit cover the behaviour without a canary test that will flake.

## Open questions

- **D1 — Warn threshold.** Headroom for how many homes? *Recommendation:* 50 (`warn < 1,756`) —
  flags every distro default, passes any deliberate 4096+ setting.
- **D2 — Admin notification on low limit?** *Recommendation:* no — startup log only; revisit if
  an admin health surface ever exists.
- **D3 — Periodic fd-pressure logging?** *Recommendation:* no for phase 1 (Linux-only, low
  signal once the limit is pinned); the scheduler seam is there if incidents recur.
- **D4 — Ship phase 2 now?** *Recommendation:* no — gate on a real deployment that cannot raise
  its limit. Phase 1 closes the incident class for compose and documents the rest.
- **D5 — N override.** *Recommendation:* yes, `EIGEN_MAX_RESIDENT_HOMES`, primarily for tests.

## Phasing

1. **S — ships immediately:** `checkFdBudget()` at boot + loud warning; `docker/SETUP-GUIDE.md`
   note for non-compose deploys; the corrected
   fd figures in the `docker-compose.yml` comment (`ROADMAP.md` is already corrected); log
   non-ENOENT `fs.watch` failures in `MaildirStore.watch`.
2. **M — optional, gated on need:** LRU cap over `homeFactories`/`touch()` with the safety
   predicate, derived N, and the `ManagedDatabase.open` retry-once valve.
