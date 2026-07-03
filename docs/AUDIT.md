# Eigen Codebase Audit

_Full-codebase review, 2026-07-01. Focus on `apps/api`; `packages/sheet` deliberately out of scope
(see [SHEETS-XLSX-FIDELITY.md](SHEETS-XLSX-FIDELITY.md) for its own status). Deep-dives for the
god files live in [AUDIT_DRIVE.md](AUDIT_DRIVE.md), [AUDIT_MOUNT.md](AUDIT_MOUNT.md),
[AUDIT_MAIL.md](AUDIT_MAIL.md), and [AUDIT_CALENDAR.md](AUDIT_CALENDAR.md)._

## How to read this

This is a health check, not a punch list of complaints. It was produced by reading the code across
every backend domain plus the shared frontend layers, judged against **this project's own
conventions** ([AGENTS.md](../AGENTS.md), [CODE-STANDARDS.md](CODE-STANDARDS.md)) rather than generic
enterprise best practice — "flat and direct, no service layers" is a deliberate choice and the audit
respects it.

The headline is simple: **the architecture is genuinely good and the engineering discipline is high,
but there is a cluster of security and data-integrity bugs that a live product with real users needs
to close before anything else.** None of them are "the design is wrong." All of them are "a specific
seam leaks." That is the good kind of audit result — the bones are sound.

Every finding cites `file:line`. Confidence is tagged where it isn't certain. I verified the
security and data-loss headliners against source myself; the rest come from a per-domain reading pass
and are marked by confidence.

---

## Scorecard

| Area | Grade | One-line |
|---|---|---|
| API core (Home, ManagedDatabase, config, auth wiring) | B- | Incident-hardened and well-commented; a teardown race + a sync bookkeeping bug remain |
| Mount / storage / sync | B | Excellent write-behind pipeline; move/rename stale-key loss on the default backend |
| Drive (ACL/sharing) | B+ | The `Drive|SharedDrive` union is A-grade security design; edges leak |
| Calendar / CalDAV / Contacts | B- | Libraries chosen well; three real bugs in the untrusted-input paths |
| Mail | C+ | Clean seam and atomic writes; two P1s (one exposed endpoint, one charset corruption) |
| Collab / chat / documents | B- | Strong Yjs lifecycle engineering; one exploitable attachment seam |
| Route / protocol perimeter | B | `:ownerId` discipline airtight, WebDAV hardened; IP-trust boundary bugs |
| Import / export | B | Great debt hygiene post-program; slides-export XSS + xlsx bomb |
| packages/lib (shared FE/BE) | B+ | Convention-dense and disciplined; systemic error-swallowing in queries |
| packages/ui + apps (frontend) | A- | Best layering discipline I've seen at this scale; dead code + stale docs |
| Test suite | B+ | Contract-first, real fault injection; concentrated gaps on security negatives |
| **Overall** | **B** | **Sound architecture, high discipline, a real pre-1.0 bug cluster to clear** |

Read that overall B as "a strong codebase with a to-do list it can actually finish," not "mediocre."
Very few live products of this breadth (drive, mail, calendar, contacts, five collaborative editors,
WebDAV, CalDAV, IMAP coexistence, search, sharing) would score this consistently.

---

## The findings that matter

If you do nothing else from this audit, do these. They are ordered by "how much I'd want this fixed
before I told a stranger to trust Eigen with their data."

### 1. Two "localhost-only" endpoints are reachable from the public internet (SECURITY, verified)

`requireLocalhost()` ([lib/core/access.ts:33](../apps/api/src/lib/core/access.ts)) trusts the
**socket peer IP** against `TRUSTED_NETWORKS`. In production that is
`127.0.0.0/8,::1,172.16.0.0/12` ([docker-compose.yml:53](../docker-compose.yml),
[generate-env.sh:70](../scripts/generate-env.sh)) — the whole Docker bridge. Caddy runs on that
bridge (`172.20.0.0/24`), and `handle_path /eigen/*` proxies **everything** under `/eigen/` with no
sub-path exclusion ([Caddyfile:33](../Caddyfile)). So any request to
`https://<domain>/eigen/<localhost-route>` arrives at the API with Caddy's trusted IP as the socket
peer, and the guard passes.

Two routes use this guard, and **both are proxied**:

- **`POST /eigen/mail/deliver/:to`** ([routes/mail.ts:50](../apps/api/src/routes/mail.ts)) —
  unauthenticated. An internet caller can inject arbitrary RFC822 into any user's inbox (phishing
  that looks server-delivered, bypassing SPF/DKIM/DMARC because it never transits SMTP), and because
  `mailboxDeliver` runs `processInboundImip` **synchronously**, can inject spoofed calendar invites
  into any user's calendar. Bounded only by the 25 MB body cap.
- **`POST /eigen/internal/auth/verify`** ([routes/internal.ts:8](../apps/api/src/routes/internal.ts))
  — a credential/app-password verification oracle. It calls `auth.api.signInEmail` server-side,
  bypassing better-auth's per-account 10/min sign-in throttle; only the global 1000/min-per-IP limit
  applies, so a credential-stuffing list can be validated against the live server at volume.

Postfix and Dovecot reach `eigen-api:8000` **directly on the bridge**, not through Caddy
([docker/postfix/eigen-deliver:10](../docker/postfix/eigen-deliver)), so closing this at the edge
breaks nothing.

**Fix (belt and suspenders):** (a) add a Caddy matcher that `respond 404` for
`/eigen/internal/*` and `/eigen/mail/deliver/*` in both Caddyfiles; (b) make `requireLocalhost`
**reject when `X-Real-IP`/`X-Forwarded-For` are present** — genuine bridge callers never set those
headers, a Caddy-proxied request always does. This is the same IP-trust class as the 2026-06 429
lockout; it deserves a single shared `clientIpKey(request, server)` helper used everywhere
(see finding 6).

### 2. Data can be silently lost through several storage seams (DATA INTEGRITY)

The roadmap's own P0 is "I would not yet trust it with data you cannot afford to lose." These are the
concrete reasons why. Details and fixes in [AUDIT_MOUNT.md](AUDIT_MOUNT.md) and
[AUDIT_DRIVE.md](AUDIT_DRIVE.md).

- **Move/rename loses post-move edits on `local` mounts** (the default self-host backend).
  `buildDocumentDb` captures the storage key once ([mount.ts:1329](../apps/api/src/lib/mount/mount.ts)),
  but `Drive.movePath`/`renamePath` don't close open collab/chat DBs, so every later sync writes
  `data.db` to the **old** hierarchical path. Edits after the move become orphaned bytes; the doc
  reverts to its move-time state on reopen. `s3`/`local-key` are immune (id-based keys). _[certain]_
- **`sync()` can mark the session's last write as synced without staging it.**
  `lastSyncedChanges = getTotalChanges()` is captured **after** `await onSync()`
  ([managed-database.ts:171](../apps/api/src/lib/core/managed-database.ts)); a write landing during
  the callback is counted as synced but was never in the staged copy. Same silent-tail-loss family as
  the incidents `markDirty`/`mustExist` fixed. Fix: capture before the await. _[certain]_
- **Inbound 8-bit / non-UTF-8 mail is corrupted before it hits disk.**
  `new TextDecoder().decode(...)` ([mail.ts:22](../apps/api/src/lib/mail/mail.ts)) replaces every
  non-UTF-8 byte with U+FFFD, then writes that string as the `.eml` source of truth. Latin-1 bodies,
  Shift-JIS, binary MIME — permanently mangled, wrong size hint. Fix: pass the `Buffer` through
  unchanged. _[certain]_
- **Home teardown race deletes journals under a live connection.** `getHome` evicts a destructing
  home and installs a replacement **without awaiting** the old `destruct()`
  ([get-home.ts:26](../apps/api/src/lib/home/get-home.ts)); the new Home opens the same DB files while
  the old `close()` runs `wal_checkpoint(TRUNCATE)` + unlinks `-wal`/`-shm`. Hit at the 5-min idle
  boundary. `evictHome` does it correctly (awaits `shutdown()`); `getHome` should too. _[likely]_
- **Smaller loss windows in the same class** (all in [AUDIT_MOUNT.md](AUDIT_MOUNT.md)): the 1-hour
  tmp sweep deletes crash-recovery temps on a delayed restart; `pending_uploads.stagingPath` stores
  absolute paths that a data-dir relocation invalidates (queued bytes then swept); `copyPath` reads a
  possibly-stale storage object for a doc with a pending upload; delete/trash don't evict cached DBs,
  so a later sync can resurrect a deleted object.

### 3. Cross-calendar write escalation (SECURITY, verified)

The event routes check `write` permission on `params.calId`, but `updateEvent`/`deleteEvent` resolve
the event by `id` alone and never assert `existing.calendarId === calId`
([routes/calendar.ts:203](../apps/api/src/routes/calendar.ts),
[calendar.ts:605](../apps/api/src/lib/calendar/calendar.ts)). A single write-share on one calendar
lets the grantee edit/delete/cancel events in **every** calendar in that owner's home; event IDs are
discoverable through team-calendar reads and the ICS every attendee receives. Classic IDOR. Fix:
thread `calId` through and assert it matches, as `createEvent` already does.
See [AUDIT_CALENDAR.md](AUDIT_CALENDAR.md).

### 4. Chat attachments give any writer an owner-privileged delete primitive (SECURITY, verified)

`deleteMessage` passes each string attachment to `deletePath`
([chat.ts:383](../apps/api/src/lib/chat/chat.ts)), which authorizes against
`canWrite(..., this.owner)` — the **home owner**, not the acting user. A crafted message with
`attachments: ["<any pathId>"]` followed by deleting your own message trashes that path with owner
privileges (an ACL bypass reachable by anyone with write to any chat in the mount). The same lines
are **also dead**: real attachments are stored by _name_, but `deletePath` expects a _pathId_, so
legit media is never cleaned up (orphan leak). Both fix in one move: resolve the name inside the
chat's `media/` folder and delete that id. See [AUDIT_DRIVE.md](AUDIT_DRIVE.md) (drive/collab seam).

### 5. Slides/sheets export → XSS on open, SSRF on PDF (SECURITY, verified)

`export/slides/render.ts` interpolates attacker-controllable style values (`borderColor`,
`background.color`, gradient stops, `color`, `fontFamily`) into `style="…"` **unescaped**
([render.ts:44,57,63,71,73,121](../apps/api/src/lib/export/slides/render.ts)) — while escaping
`highlightColor` and DOMPurifying `text` in the same file, so the author knew. The export callers
apply **no** DOMPurify (the preview path does — [eigenslides-preview.ts:25](../apps/api/src/lib/preview/eigenslides-preview.ts)),
so the safe surface is guarded and the download/print surface isn't. Slides are schemaless Yjs CRDTs,
so a collaborator sets arbitrary strings regardless of the color pickers. HTML export → XSS on open;
PDF export → the server's WeasyPrint fetches an injected `url()` (SSRF from the API host). Sheets HTML
export has the same unescaped-color pattern, saved only by caller-side DOMPurify. Fix: sanitize the
assembled body in both export callers and escape colors at the interpolation site.

### 6. IP-trust boundary bugs recur (SECURITY / RELIABILITY, verified pattern)

The 2026-06 server-wide 429 lockout was "we keyed a limit on Caddy's IP." Two live instances of the
same class remain:

- **Guest OTP limiter** keys on `server.requestIP()`
  ([guest-auth.ts:8](../apps/api/src/routes/guest-auth.ts)) → behind Caddy that's one shared bucket,
  so `MAX_PER_IP=10/hr` becomes a **global** cap; ~10 guest OTP requests/hour lock out all guest
  onboarding, and the per-attacker control is nil. (Three separate audit passes flagged this
  independently — it's real.) _[certain]_
- **`/dav/*` rate-limit key is client-spoofable.** The app limiter prefers `X-Real-IP`, but Caddy
  only overwrites that header on `/eigen/*`; the `/dav/*` block forwards client headers verbatim
  ([Caddyfile:43](../Caddyfile)), so a CalDAV client sets its own bucket key and evades the global
  limiter (brute-force CalDAV Basic auth). _[likely]_

Fix both by extracting one `clientIpKey()` helper (used by `app.ts`, `guest-auth.ts`, better-auth
config) and adding `header_up X-Real-IP {remote_host}` + `header_up -X-Forwarded-For` to the `/dav/*`
Caddy block. Unit-test the header precedence — incident (b) has **zero** regression coverage today.

### 7. Two more untrusted-input security bugs (SECURITY)

- **iMIP trusts ICS-declared identities.** `processInboundImip(home, mail)` never checks the SMTP
  sender ([imip.ts:158](../apps/api/src/lib/calendar/imip.ts)); a forged `METHOD:REPLY` marks another
  attendee accepted/declined, a forged `REQUEST` injects events attributed to a spoofed organizer.
  The caller already has `parsed.from` ([mail.ts:31](../apps/api/src/lib/mail/mail.ts)) — thread it in
  and require it to match. _[likely]_ See [AUDIT_CALENDAR.md](AUDIT_CALENDAR.md).
- **Unvalidated `TZID` from untrusted iCal is a stored crash.** A raw `TZID` (e.g. Outlook's
  `W. Europe Standard Time`) is persisted and later fed to `Intl.DateTimeFormat`, which throws
  `RangeError` — breaking the whole event-range fetch, CalDAV serialization, and RSVP for that user
  until manual repair. A single real Outlook invite triggers it. Validate at parse; degrade to
  floating/UTC. _[certain]_

### 8. One transient 5xx can blank the drive until a hard reload (RELIABILITY)

38 of 55 query hooks in `packages/lib` return `response.data || []` instead of throwing on Eden
errors, violating the codified "queryFn with error checking" rule. Combined with `staleTime: Infinity`
on the three foundational drive queries (`useMounts`, `useRootFolder`, `useCheckPermissions`), a
single 502 at app load caches an empty result **forever**: empty sidebar, or a spurious "no access"
screen, with no error state and no refetch. Mechanical sweep to add the existing `AppError` check;
prioritize the Infinity-staleTime trio.

### 9. Denial-of-service via unbounded work (AVAILABILITY)

Three places let one request consume the whole box:

- **WebDAV `COPY` of a folder into its own subtree** recurses forever (disk fill). The guard exists in
  the JSON route but not in `Drive.copyPath` where WebDAV enters
  ([webdav/move-copy.ts:160](../apps/api/src/lib/webdav/move-copy.ts)). Hoist it into
  `Drive.copyPath`. _[certain]_
- **Unbounded RRULE expansion.** `rule.between(from, to)` with no window clamp or count cap
  ([calendar.ts:1481](../apps/api/src/lib/calendar/calendar.ts)); `FREQ=SECONDLY` is accepted. A
  read-permitted range query over a hostile recurring event blocks the event loop for all users. _[likely]_
- **xlsx decompression bomb.** `workbook.xlsx.load(buffer)` loads everything in memory and a second
  JSZip pass re-decompresses ([from-xlsx.ts:119](../apps/api/src/lib/import/sheets/from-xlsx.ts)); only
  the _compressed_ upload is bounded, so a file at the ceiling expands to many GB → OOM kills the
  process → every Home on the box drops. Cap decompressed bytes/cell count. _[likely]_

---

## Full findings by severity

Where a finding has a fuller write-up in a deep-dive doc, that's noted. This table is the index; the
deep-dive docs carry the reproduction detail.

### P1 — fix before 1.0

| # | Finding | Location | Doc |
|---|---|---|---|
| 1 | `/mail/deliver` + `/internal/auth/verify` internet-reachable | routes/mail.ts:50, routes/internal.ts:8, Caddyfile:33 | this |
| 2a | Move/rename loses post-move edits on `local` | mount.ts:1329 | [MOUNT](AUDIT_MOUNT.md) |
| 2b | `sync()` marks last write synced without staging | managed-database.ts:171 | this |
| 2c | Inbound 8-bit mail corrupted at write | mail.ts:22 | [MAIL](AUDIT_MAIL.md) |
| 2d | Home teardown race unlinks journals under live conn | get-home.ts:26 | this |
| 3 | Cross-calendar write escalation (IDOR) | routes/calendar.ts:203; calendar.ts:605,703 | [CALENDAR](AUDIT_CALENDAR.md) |
| 4 | Chat attachment owner-privileged delete + orphan leak | chat.ts:383 | [DRIVE](AUDIT_DRIVE.md) |
| 5 | Slides/sheets export XSS + PDF SSRF | export/slides/render.ts:44+ | this |
| 6a | Guest OTP limiter keyed on proxy IP | guest-auth.ts:8 | this |
| 7a | iMIP trusts ICS sender identity | imip.ts:158 | [CALENDAR](AUDIT_CALENDAR.md) |
| 7b | Unvalidated TZID → stored `Intl` crash | calendar.ts:392; ical-parse.ts:73 | [CALENDAR](AUDIT_CALENDAR.md) |
| 8 | 38/55 queryFns swallow errors + Infinity staleTime | packages/lib core hooks | this |
| 9a | WebDAV COPY-into-subtree unbounded recursion | webdav/move-copy.ts:160 | [DRIVE](AUDIT_DRIVE.md) |

### P2 — high value, fix next

| # | Finding | Location | Doc |
|---|---|---|---|
| 10 | Read-ACL revocation never closes live collab WS | routes/collab.ts:122 | this |
| 11 | `TeamHome.updateMount` never reaches the live Drive | team-home.ts:81 | this |
| 12 | `JsonStore.load()` error → defaults → next `set()` persists the wipe | json-store.ts:44 | this |
| 13 | Partial `Home.init()` failure leaks DBs + timers | home.ts:98 | this |
| 14 | `/dav/*` rate-limit key spoofable | Caddyfile:43 | this |
| 15 | Inline-editor save bypasses quota + 5 MB cap | routes/editor.ts:21 | [DRIVE](AUDIT_DRIVE.md) |
| 16 | `renamePath` propagates pre-rename name to recipients | drive.ts:588 | [DRIVE](AUDIT_DRIVE.md) |
| 17 | `SharedDrive.openDatabase/createDatabase/closeDatabase` ungated | sharedDrive.ts:420 | [DRIVE](AUDIT_DRIVE.md) |
| 18 | Reindex clears dirty bit on extraction failure → un-indexed | content-reindex-queue.ts:69 | [MOUNT](AUDIT_MOUNT.md) |
| 19 | Unbounded RRULE expansion (DoS) | calendar.ts:1481 | [CALENDAR](AUDIT_CALENDAR.md) |
| 20 | CalDAV time-range parsed with `new Date()` → empty REPORT | xml-parser.ts:52 | [CALENDAR](AUDIT_CALENDAR.md) |
| 21 | xlsx decompression bomb (OOM) | from-xlsx.ts:119 | this |
| 22 | Waitlist DB singleton race → "Database not open" | waitlist.ts:20 | this |
| 23 | Overwrite upload leaves path-detail cache stale | sse-handlers.ts:34 | this |
| 24 | `Drive.create` lacks parent-liveness guard (doc into trashed folder) | drive.ts:232 | [DRIVE](AUDIT_DRIVE.md) |
| 25 | `messageGet` masks all errors as 404 | maildir.ts:158 | [MAIL](AUDIT_MAIL.md) |
| 26 | `use-calendar.ts` casts a union Eden response | use-calendar.ts:116 | this |
| 27 | Concurrent same-name create clobbers on `local` (no unique index) | mount.ts:386 | [MOUNT](AUDIT_MOUNT.md) |

### P3 — cleanup, correctness nits, and debt

Grouped; full lists in the deep-dive docs. Highlights:

- **Dead code:** `components/sidebar.tsx` (666 LOC) + ~690 LOC of other unused stock shadcn (7 files,
  0 importers, verified); `Drive.removeMount` (0 callers); `invalidateWatches`; the `SearchSource`
  re-export; `CHAT_MEMBER_ENTERED/LEFT/TYPING` SSE types (never broadcast); `mail-split/`
  node-rewriter + node-streamer + message-joiner (~360 LOC, 0 importers).
- **Two sources of one fact (the standards' own bugbear):** `createFolder`'s inline type→mime map vs
  `EIGEN_DOC_TYPE_INFO` (mount.ts:412); `resetAuthDatabase` DDL vs `auth-schema.ts`; client-IP
  derivation written three ways (one drifted wrong → finding 6); xlsx round-trip reverse-maps
  ([MAIL](AUDIT_MAIL.md)/import).
- **Duplication worth folding:** `use-drive.ts` copy-mutation quartet (~130 LOC, already drifting);
  drive's 4 list-route handlers + a validator that already exists unused; `_auth.tsx` guard copied
  across 10 apps in 3 accidental variants.
- **Correctness nits:** `disposition-notification.ts-to` header typo (a mechanical `.ts` rename hit a
  string literal — [mail-parser.ts:600](../apps/api/src/lib/mail/mail-parser/mail-parser.ts));
  `validateName` accepts control chars that `resolvePath` rejects; `parseOwnerId` returns
  `{id:''}` for garbage so `!parsed` checks are dead and bad IDs 404 instead of 400.
- **Flaky test root cause (diagnosed):** `settings.test.ts` "disabling one mount does not affect the
  other" fails ~1-in-48 because 8-hex mount IDs are ~2.1% likely to be all-digits, which reorders
  `Object.keys` ahead of a residual disabled mount left by an earlier test. Fix: select mounts by
  name and normalize state; optionally prefix generated mount IDs with a letter.

---

## Cross-cutting themes

Five patterns recur across domains. Each is a _class_ — fixing the class is worth more than fixing the
instances.

1. **IP-trust at the reverse-proxy boundary.** Findings 1, 6a, 6b. The project _knows_ this class
   (the 2026-06 incident, the `app.ts` fix), but `requireLocalhost` and `guest-auth` didn't get the
   memo, and `/dav/*` isn't sanitized at the edge. One `clientIpKey()` helper + a Caddy exclusion for
   localhost-only routes closes all of it, and it's the kind of thing that should have a unit test so
   it can't regress a third time.

2. **A resolved location captured across a mutation.** The mount P1 cluster (finding 2a and its
   siblings) all come from caching a _path_ (storage key, staging path, breadcrumb) that a later
   move/rename/relocate invalidates. `s3`/`local-key` dodge it because their keys are id-stable; the
   default `local` backend pays the tax. The durable fix is "resolve inside the callback / evict the
   cache on mutation," not more guards.

3. **Guards that live one layer too high.** Findings 9a (cycle guard in the route, not `Drive`), 15
   (quota in WebDAV, not `writeFileContent`), 24 (`create` missed the liveness check its siblings
   have). A domain invariant enforced per-route is one new caller away from a hole. These belong in
   Drive/Mount.

4. **Untrusted input reaching typed internals without a boundary check.** Findings 5, 7a, 7b, plus the
   MIME parser's happy-path-only tests. Mail and calendar ingest from the open internet; those seams
   are exactly where CODE-STANDARDS' "validate at boundaries" earns its keep, and they're where the
   validation is thinnest.

5. **Docs drifting behind the code — which, in an agent-driven workflow, actively causes wrong work.**
   `AGENTS.md:335` still describes "four near-identical editor routes" that were unified a month ago
   (`ad055d42`); `LAYOUT.md` references files that don't exist (`EigenDocSidebar`, `eigendoc-configs`,
   a `Mod+B` shortcut that isn't bound); `ROADMAP.md` lists Search Phase 2 as 0% when it shipped
   (`2c7a5ed4`); `SERVER-SETTINGS.md` claims a storage-inheritance behavior with no backing code;
   `AGENTS.md:365`'s single-test command contradicts the `--preload` rule the tests actually need.
   Since your own working method makes these docs required reading for every subagent, stale docs
   aren't cosmetic — they send agents to fix things that are already fixed or to trust APIs that don't
   exist.

---

## My opinion

You asked for it, so here it is, direct.

### What Eigen is, and my overall impression

Eigen is an ambitious, unusually _coherent_ self-hosted Workspace. The surface area is enormous — a
drive with three storage backends and WebDAV, mail with IMAP coexistence, a calendar with CalDAV and
iMIP, contacts with CardDAV, five collaborative editors on Yjs, search, sharing, orgs/teams — and yet
it reads like it was built by someone with a clear, consistent mental model. That coherence is the
single most valuable thing here and it's rare. Most projects this broad are a patchwork of five
different people's instincts; this one has a spine.

The spine is: **per-user `Home` isolation → `ownerId` routing → a single `home-relay` seam for all
cross-user interaction.** That's not just tidy, it's the thing that makes the whole product shardable
later without a rewrite, and it's _enforced_ (a lint rule blocks `getHome` imports in `lib/`). The
audit found **zero** violations of that seam. When a codebase's most important architectural rule has
zero violations across 63k lines of API code, that tells you the discipline is real and not
aspirational.

The second thing that stands out is the **incident scar tissue.** The `mustExist` guard, the
`markDirty` crash-recovery, the staged-upload replay, the `restoreYjsDoc` AbstractType handling — each
is precisely commented with the failure it prevents and often the date it was found. That is exactly
what you want from a pre-1.0 product that's already live: every scar is a test and a comment, not just
a patch. The `UploadQueue` in particular is genuinely excellent — I tried to construct an interleaving
of cancel/supersede/crash that loses or resurrects data and couldn't.

So my overall read: **this is a B+ / A- codebase carrying a handful of B-/C bugs that are loud because
the product is live.** The grade is dragged down by specific leaks, not by anything structural. If the
finding-1-through-9 cluster were closed, I'd grade the whole thing a solid A-.

### Strengths — what's genuinely good (not flattery)

- **The `Drive | SharedDrive` union type.** Making "reachable from a route" and "ACL-checked"
  the _same_ compile-time fact is a genuinely clever, genuinely effective security design. It held up
  under adversarial review: every route-callable method has a wrapper with the right check, and the
  two documented escape hatches both `requireSelf`. This is the best single idea in the codebase.
- **The write-behind storage pipeline.** Durable queue-as-dirty-bit, per-destination concurrency,
  self-scheduling backoff, replay-on-open, no global sweeper. Symmetrically reused for the reindex
  queue. This is hard to get right and it's right.
- **Frontend layering.** ~100% adherence to "no `useQuery`/`useMutation`/`toast`/`try-catch` in app
  components" across 26k lines of app code, with a config-driven family where adding an editor app is
  a single-source edit. This is the best layering discipline I've reviewed at this scale.
- **Library choices at the dangerous seams.** `ical.js`/`rrule`/`fast-xml-parser` for calendar (no
  XXE), `sharp` in a worker with a timeout, `exiftool` via arg-arrays (no shell), DOMPurify on preview
  surfaces. The homegrown code is where it buys something specific (Bun-native MIME streaming); the
  risky parsing is delegated.
- **The test suite's character.** Contract-first HTTP round-trips, on-disk artifact assertions (real
  Maildir files, xlsx zip XML, Yjs snapshots read back), deterministic fault injection for sync, real
  binaries instead of mocks. When it tests something, it tests it well.
- **Tooling.** `bun run check` runs lint + typecheck + the home-import lint + the shared-primitives
  drift check + tests. TS `strict`. Biome. The guardrails are wired into one command.

### Weak spots — where the risk actually lives

- **The reverse-proxy trust boundary** (theme 1). It's bitten you once and there are three live
  instances. This is the highest-severity, lowest-effort cluster in the whole audit.
- **`local`-backend path caching** (theme 2). The default backend is the one with the move/rename
  data-loss class. Self-hosters running the default are the exposed population.
- **Untrusted-input validation on the mail/calendar ingest paths** (theme 4). These are internet-
  facing and under-checked, and the MIME parser — 1424 lines of code parsing hostile input — has only
  happy-path tests.
- **God files.** `mount.ts` (1835), `calendar.ts` (1633), `drive.ts` (1490), `mail-parser.ts` (1424),
  `maildir.ts` (837). None are _tangled_ — they all have clean internal seams — but they're big enough
  that the "guard one layer too high" bugs hide in them. The deep-dive docs propose concrete,
  low-risk decompositions that stay flat-and-direct.
- **Error-swallowing as a habit** on the read paths (`response.data || []`, `messageGet` → null,
  `getTeamMembers` → `[]`). It's the flip side of "trust the type system" done slightly too
  enthusiastically: genuine faults become invisible empty results.

### Is this a solid foundation to build features on?

**Yes — with one qualifier.** The architecture is the right shape for growth: the layering is clean,
the shared-primitive discipline means new features find existing hooks instead of rebuilding them, the
`ownerId`/`Home` model means new domains slot in the same way every existing one did, and the type
chain (Elysia → Eden → hooks) means backend changes propagate to the frontend without manual sync.
Adding the next feature will feel like the last one, which is the definition of a solid foundation.

The qualifier: **do the data-trust pass first.** You already know this — it's literally your roadmap's
P0. This audit gives you the concrete list (finding 2 and its cluster). Shipping more features on top
of a storage layer that can silently lose post-move edits on the default backend just means more
features that can lose data. The foundation is solid _structurally_; the data-integrity layer needs
the pass you've already scheduled before it's solid _operationally_. Everything else — search, file
history, SSO — is genuinely well-positioned to build on top.

### Patterns: what to adopt, and what to leave alone

First, what **not** to do, because it's tempting and it's wrong for this codebase:

- **Don't introduce service layers, DI, or repository patterns.** The flat-and-direct philosophy is
  working. The god files are not a symptom of missing abstraction; they're a symptom of a few
  functions that want to be in a sibling file. The deep-dive docs deliberately propose _plain-function
  modules taking `mount`/`drive` as an argument_ (the existing `copy-across.ts` shape), never
  managers.
- **Don't chase the token-level duplication.** A jscpd sweep found 0.2%. The duplication that matters
  is structural (the copy-mutation quartet, the `_auth.tsx` variants), and it's already mostly
  extracted. This codebase does not have a DRY problem.

What I _would_ adopt, all of it small and in-keeping:

- **A `clientIpKey()` helper and a "boundary-check" convention** for the internet-facing ingest paths.
  One helper for the proxy-IP class; one explicit `validate at boundary` pass on mail/calendar/iMIP
  input. These are the two classes that keep producing security findings.
- **"Evict-or-rebind the cached DB on row mutation"** as a single seam in Mount (theme 2). Move,
  rename, trash, and delete should all go through one `evictCachedDb(pathId)` call. That one seam
  closes most of the mount P1 cluster.
- **A boundary-validation habit for `Intl`/`new Date`** on parsed input (findings 7b, 20). Both bugs
  are "we passed untrusted text straight into a platform API that throws."
- **Finish the extractions you start.** The pattern across the frontend is "shared hook extracted,
  per-app JSX left behind" and "factory built for login but not for the auth guard." You're 85% of the
  way through several unifications; the last 15% is where the drift accumulates.
- **A docs-freshness check.** Given how load-bearing your docs are for the agent workflow, a
  lightweight "does this referenced symbol still exist" linter (or just a discipline of updating the
  domain doc _in the same cycle_, which AGENTS.md already mandates but which is slipping) would pay for
  itself. The stale `AGENTS.md`/`LAYOUT.md`/`ROADMAP.md` lines are actively costing agent time.

### If this were my project: what I'd do, in order

1. **Close finding 1 today.** It's a live, unauthenticated, internet-reachable mail+calendar injection
   plus a credential oracle. Two Caddy lines and one `requireLocalhost` change. This is not a
   "schedule it" — it's a "this afternoon."
2. **Sweep the IP-trust class** (findings 6a, 6b) while you're in there, with the shared `clientIpKey`
   helper and a unit test. Same afternoon, closes the class for good.
3. **The data-trust pass** (finding 2), which is your roadmap P0 anyway. Order within it: the `sync()`
   capture-before-await one-liner (2b, cheapest, highest-leverage), then the move/rename evict seam
   (2a, the default-backend one), then the mail charset fix (2c), then the teardown race (2d). Add the
   incident-regression tests the test audit calls out (the `mustExist` call-site wiring, the 429 IP
   plumbing) so this class can't quietly come back.
4. **The three remaining verified security bugs** (3 calendar IDOR, 4 chat delete, 5 export XSS). Each
   is a contained fix with a clear repro.
5. **The reliability sweep** (finding 8): add the `AppError` check to the query hooks, drop the two
   `staleTime: Infinity` values that turn a transient error permanent. Mechanical, high user-felt
   value.
6. **Then, and only then, the cleanups**: delete the ~1,050 lines of dead code (it's pure win — less
   for every future agent to wade through), fix the stale docs (theme 5), fold the duplication. These
   make the codebase _nicer_ but nothing depends on them.
7. **Opportunistically, the god-file decompositions** in the deep-dive docs — do them _when you next
   touch each file for a feature_, not as standalone PRs. `mount.ts` and `calendar.ts` benefit most.

The DoS trio (finding 9) slots in wherever it's convenient — none are one-request-kills-you from an
_unauthenticated_ actor except the mail-bomb-via-finding-1, which finding 1's fix mostly closes.

---

## Deep-dive documents

The four largest / most load-bearing files got their own audit with a concrete, dependency-ordered,
flat-and-direct decomposition proposal:

- **[AUDIT_MOUNT.md](AUDIT_MOUNT.md)** — `mount.ts` (1835 LOC), storage, sync. The data-integrity
  center of gravity.
- **[AUDIT_DRIVE.md](AUDIT_DRIVE.md)** — `drive.ts` (1490 LOC), `sharedDrive.ts`, the ACL seam.
- **[AUDIT_MAIL.md](AUDIT_MAIL.md)** — the mail domain, `maildir.ts` (837) + the 1424-LOC MIME parser,
  and a full **backend-abstraction analysis** for a future Stalwart/JMAP or external-IMAP source.
- **[AUDIT_CALENDAR.md](AUDIT_CALENDAR.md)** — `calendar.ts` (1633 LOC), CalDAV, iMIP.

---

## Methodology

Twelve parallel read-only passes (one per domain: API core, mount/storage/sync, drive, mail,
collab/chat, calendar/CalDAV, route/protocol perimeter, packages/lib, frontend, tests, import/export),
each briefed to judge against this project's conventions, report only genuinely real findings with
`file:line` evidence, and verify negatives before claiming something is missing. The security and
data-loss headliners (findings 1, 3, 4, 5, and the calendar IDOR) were then re-verified by hand
against source. A `jscpd` token-duplication sweep (0.2% — negligible) confirmed the duplication that
matters is structural, not copy-paste. No code was modified; no tests were run (a concurrent editing
session was active). "Clean" was treated as a valid result — several passes returned genuine
strengths and short finding lists, and those are reported as-is rather than padded.
