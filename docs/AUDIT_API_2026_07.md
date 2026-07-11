# API Audit — `apps/api` critical systems (2026-07-11)

> Reviewer: fable (Claude). Scope: `apps/api/src` **excluding** tests. Method: full read of the
> core layers (Home/Mount/Drive/collab/mail/storage/sync/managed-db) plus six parallel domain
> sweeps (routes, calendar/caldav/webdav/chat/contacts, export/import/preview, mail-parser/IMAP,
> auth/org/team/versioning). Bun 1.3.14 native API surface reviewed against current usage.
>
> Every finding below carries `file:line`, what's wrong, why it matters, and a suggested
> direction. Severity: **P0** ship-blocker · **P1** real bug / security · **P2** worth fixing ·
> **P3** nit / smell. Findings I verified against source (incl. `node_modules`) are marked
> **[verified]**; the rest are line-precise candidates worth a confirming look before acting.

---

## Executive opinion

The codebase is, honestly, **well above the norm**. The hard parts — the write-behind S3 upload
queue, crash-recovery temp adoption, the SQLite close/checkpoint/journal-unlink dance in
`ManagedDatabase`, the `SharedDrive` union-type ACL seam, the multipart streaming parser — are
carefully reasoned and heavily commented with the *why*. The "one source of truth", "trust the type
system", and ownerId-sharding-seam disciplines from AGENTS.md are followed consistently. The
`getHome`/`Home.destruct` idempotency and race handling are genuinely subtle and look correct. This
is not a codebase with low-hanging structural rot.

So the findings cluster into three buckets:

1. **One real security bug** (2FA bypass over IMAP/CalDAV/WebDAV) that should be fixed before
   anything else.
2. **A handful of "load the whole table, filter/cap in JS" reads** that will bite as data grows —
   contacts N+1, CalDAV whole-calendar scans, chat content cap, mail attachment buffering. None are
   on fire today; all are latent scaling cliffs.
3. **Config/hygiene** — swagger in prod, an unset WS payload limit, three dead dependencies, a few
   `node:crypto` calls that could be Bun-native.

The bones are good. The list below is about hardening a strong system, not rescuing a weak one.

---

## P1 — fix first

### 1. [verified] 2FA is bypassed by the primary-password fallback on all protocol logins
`apps/api/src/lib/auth/protocol-auth.ts:43-49`

```ts
// 2. Fall back to primary password (only works when 2FA is not enabled)
try {
    await auth.api.signInEmail({ body: { email, password } });
    return user;              // ← reached even for a 2FA-enabled user
} catch { throw new ApiError(401, 'Unauthorized'); }
```

The comment's premise is **false**. I traced better-auth 1.5.6 (`apps/api/node_modules/better-auth/dist/plugins/two-factor/index.mjs:169-211`): the `after` hook on `/sign-in/email` fires *after* the session is created, and when `data.user.twoFactorEnabled` is set it **deletes the session and returns `ctx.json({ twoFactorRedirect: true })` — an HTTP 200, not a throw**. A server-side `auth.api.signInEmail(...)` call (no `asResponse`) therefore **resolves without throwing** for a 2FA user supplying the correct primary password. `verifyProtocolAuth` then falls through to `return user`.

**Impact:** any account with 2FA enabled can be logged into over WebDAV, CalDAV (public Basic-auth routers) and IMAP (`routes/internal.ts` → Dovecot → `verifyProtocolAuth`) with **just email + primary password** — exactly the credential 2FA exists to defend. App passwords (step 1) are the intended mechanism for these protocols; the fallback silently defeats them.

**Direction:** inspect the result instead of trusting throw-or-not. Either call with `asResponse: true` and treat a `twoFactorRedirect` body as failure, or hard-gate: if `user.twoFactorEnabled`, never attempt the primary-password fallback — require the app-password path.

### 2. Protocol Basic-auth is unthrottled → online brute force
`apps/api/src/lib/auth/protocol-auth.ts:32-49`, config at `apps/api/src/lib/auth/auth.ts:99-103,132-134`

The `/sign-in/email` custom rate rule (`auth.ts:100`) only covers better-auth's *HTTP* middleware, which keys on the inbound request/IP. `verifyProtocolAuth` calls `auth.api.signInEmail(...)` / `verifyApiKey(...)` **directly** (no HTTP request → middleware never runs), and the apiKey plugin is `rateLimit: { enabled: false }` (`auth.ts:133`). WebDAV/CalDAV expose `authenticateBasic` on the **public** surface with 20+ call sites, so both app-password and primary-password guesses are unlimited.

**Direction:** wrap `verifyProtocolAuth` in a per-identifier/IP limiter (reuse the `otp-rate-limit.ts` shape), or confirm the global Elysia `elysia-rate-limit` actually covers `/webdav/*` and `/dav/*` (it keys on `clientIpKey`, so it *may* — verify, because these are the pre-auth abuse surface). Secondary: the function returns fast for an unknown email but does argon2 work for a known one — a user-enumeration timing oracle.

### 3. Waitlist invite-token claim races → one invite can mint multiple accounts
`apps/api/src/lib/waitlist/waitlist.ts:132-148` **[verified logic]**

`claimInviteToken` clears the token with an UPDATE, then **re-selects the row** and returns `updated.status === 'registered' && updated.inviteToken === null`. The re-select verifies the *row's* state, not that *this caller* did the clearing. Two concurrent `registerFromInvite` calls with the same token (each creating a distinct `username@domain`, so no email-unique collision upstream) can both pass `validateInviteToken`, both run the UPDATE (the second matches 0 rows), and both re-select `registered/null` → **both return `true`**. Sequential reuse is correctly blocked; only the concurrent window is open.

**Direction:** key off the UPDATE's affected-row count — drizzle bun-sqlite `.run()` exposes `changes`: `return res.changes === 1`. Drop the re-select entirely.

---

## P2 — worth fixing

### 4. [verified] Swagger + Server-Timing mounted unconditionally in production
`apps/api/src/app.ts:55-56`

```ts
.use(serverTiming())
.use(swagger())
```

No `isProduction()` guard (the helper exists at `lib/config/env.ts` and is used elsewhere). `swagger()` publishes the full OpenAPI schema + interactive "try it out" UI at `/swagger` — the entire authenticated route map handed to an attacker for recon. `serverTiming()` leaks internal phase timings via response headers.

**Direction:** gate both behind `!isProduction()`.

### 5. WebSocket `maxPayloadLength` is never set — large-doc sync frames can be dropped
`apps/api/src/app.ts:45-53`, comment at `apps/api/src/routes/collab.ts:44` **[verified: unset]**

The collab comment says *"WebSocket server options (perMessageDeflate, maxPayloadLength) can't live here — Elysia only honors `websocket` config on the root app instance, so it's set in app.ts."* But `app.ts` sets **only** `perMessageDeflate: true` — `maxPayloadLength` was never actually added. Bun's default is **16 MB**. The blob-codec comment notes sheet snapshots reach **~48 MB** uncompressed, and Yjs `syncStep`/`writeUpdate` sends whole-state frames; Bun measures the *decoded* message against `maxPayloadLength`, so a large sheet's initial sync frame can exceed 16 MB and the socket closes with 1009.

**Direction:** set an explicit `maxPayloadLength` (e.g. 64–128 MB) on the root `websocket` config to match the documented ~48 MB worst case. Verify against a real large sheet — this is the kind of thing that only shows up on the biggest documents.

### 6. Contacts list is a 1 + N query (one label lookup per contact)
`apps/api/src/lib/contacts/contacts.ts:247-254` (in `dbRowToContact`), called from `getContacts` (`:272-275`) **[verified]**

`dbRowToContact` runs a `contactsToLabels` SELECT **per row**; `getContacts` maps it over every contact. Contact list is a hot read — mail compose suggestions, calendar attendee picker, and `Contacts.init` on every home open. At a few hundred contacts that's hundreds of round-trips.

**Direction:** batch — one `select().from(contactsToLabels)` (optionally `inArray(contactId, ids)`), group into `Map<contactId, labelId[]>`, then map rows. The `(contactId, labelId)` PK already supports the grouped scan.

### 7. CalDAV "load entire calendar, filter in JS" on poll-heavy endpoints
`apps/api/src/lib/caldav/caldav-router.ts:94`, `report.ts:82`, `resource.ts:141`

Each loads the **whole** calendar via `getRawEvents(calendarId)` to select one uid (`GET .ics`), one parent's exceptions (`PUT` sync), or a handful of multiget URIs. Indexes for the scoped queries already exist (`idx_events_uid_calendar`, `idx_events_parent`). Apple/Thunderbird poll these constantly, so cost scales with total calendar size on every sync tick.

**Direction:** add calendar-scoped helpers (`getRawEventsByUid(calendarId, uid)`, `getExceptionsForParent(parentId)`, uid-set `inArray` for multiget). Note `getEventsByUid` exists but is **not** calendar-scoped — don't just reuse it.

### 8. RECURRENCE-ID stored as UTC date while EXDATE/expansion key on wall-clock date
`apps/api/src/lib/caldav/ical-parse.ts:99-104` vs EXDATE at `:200-203`; keying in `calendar/recurrence.ts:130` **[verified: the two code paths differ]**

RECURRENCE-ID derives its date from `rid.toJSDate()` **UTC** fields; EXDATE (same file) and occurrence keying (`occurrenceDateToString`) use **wall-clock** components. For a timed recurring event in an offset timezone where an occurrence's wall-clock date ≠ its UTC date (e.g. 23:00 America/New_York → next-day UTC), a CalDAV-synced modification/cancellation attaches to the wrong occurrence: the cancelled instance still renders, the modified one duplicates. EXDATE cancellations work; RECURRENCE-ID ones don't — the inconsistency is within one file.

**Direction:** derive `recurrenceDate` from the `ICAL.Time` components (`rid.year/rid.month/rid.day`), matching EXDATE.

### 9. Attendee editing a linked event still runs the organizer invitation fan-out
`apps/api/src/lib/calendar/calendar.ts:414-421` (attendee guard) and `:507-515` (fan-out) **[verified: both run]**

The `:414` guard establishes "this home is an attendee" (linked copy has `data.organizer`) and restricts input to reminders/color. But the `:507` organizer block still fires: `incrementSequence(id)` + `propagateInvitation(...)`. For external/guest attendees that sends a `composeUpdateEmail` iMIP "Updated invitation" with `organizer = {this attendee}` — the attendee spoofed as organizer — and bumps SEQUENCE on every local reminder/color toggle. (Internal attendees no-op via `findLinkedEvent`; the external-mail + sequence-bump side effects are real.)

**Direction:** gate the `:507` propagate/`incrementSequence` block on the organizer case — skip when `existing.data?.organizer` is set (mirror the `:414` discriminator).

### 10. Chat `readChatContent` materializes up to 100 000 rows to honor a 100 KB cap
`apps/api/src/lib/document/chat.ts:24-32` **[verified]**

```ts
.limit(capBytes)   // capBytes = 100_000 → LIMIT 100000 rows
.all();
// byte-break loop runs only AFTER all rows are in memory
```

The byte cap is applied by a JS loop that runs *after* `.all()`, so the `LIMIT` can't shrink the fetch. The loop typically breaks after a few hundred rows, but a large chat still transfers up to 100 000 `{content, authorEmail}` rows into memory per content-reindex pass. The defending comment ("caps how many rows we materialise") is the reasoning error — rows ≠ bytes.

**Direction:** use `.iterator()` and break at the byte cap so materialization stops early, or `.limit(a few hundred)`.

### 11. Uncapped `htmlToText` on untrusted mail HTML (guard exists, never set)
`apps/api/src/lib/mail/mail-parser/mail-parser.ts:963-978` (guard), caller `apps/api/src/lib/mail/mail-parse.ts:18` (`simpleParser(bytes, {})`)

The parser caps HTML→text conversion only when `options.maxHtmlLengthToParse` is truthy; the caller passes empty options. The splitter caps *structure* (`MAX_HEAD_SIZE = 1 MB`, `MAX_CHILD_NODES = 1000`) — DoS was considered — but *content* size is uncapped. `parseEml` runs on the request path (`messageGet`) **and** for every message in the cold-index/sync loop, so one hostile inbound email can burn unbounded CPU on the shared event loop.

**Direction:** pass `maxHtmlLengthToParse`; consider a raw-eml size cap before parse.

### 12. Every attachment fully decoded + buffered even for summary-only parses
`apps/api/src/lib/mail/mail-parser/simple-parser.ts:82-97`, entry `mail-parse.ts:12`

`simpleParser` always decodes and buffers **all** attachment bytes into `attachment.content: Buffer`, on top of the already-resident raw eml. The cold-index/sync path only consumes `subject/from/to/textShort` yet pays full decode + buffer per message across tens of thousands of messages. There's no header/text-only mode.

**Direction:** a summary parse mode that stops after headers + first `text/plain` and skips attachment decode, used by the index/sync path. (Primary consumer `maildir-store.ts` is the beneficiary; the in-scope gap is that the parser offers no lighter mode.)

### 13. Chat `postMessage` fans out notifications with sequential awaits on the send hot path
`apps/api/src/lib/chat/chat.ts:174-203` (mentions) and `:255-260` (activity participants)

`postMessage` is awaited by the route, so the sender's HTTP response blocks on N sequential `getUserByEmail` + `sendToHome` (mentions) and M sequential activity sends. Latency grows linearly with participant/mention count.

**Direction:** collect the sends and `Promise.all` (each already has its own try/catch), or fire-and-forget the fan-out after the row commits. (`drive/history.ts:notifyWatchers` already does the concurrent-fan-out pattern correctly — mirror it.)

### 14. `checkBoundary` CRLF test uses `||` where it needs `&&`
`apps/api/src/lib/mail/mail-split/message-splitter.ts:267-273`

```ts
if (line.length >= 1 && (line[0] === 0x0d || line[0] === 0x0a)) {
    startpos++;
    if (line.length >= 2 && (line[0] === 0x0d || line[1] === 0x0a)) {  // ← should be line[0]===0x0d && line[1]===0x0a
        startpos++;
    }
}
```

The outer `if` already proved `line[0]` is CR or LF. The inner test means to detect a 2-byte **CRLF** and skip a second byte, which needs `line[0]===0x0d && line[1]===0x0a` (matches upstream mailsplit). As written, whenever `line[0]` is CR the inner is trivially true, over-advancing `startpos`; the `--` check at `:275` then reads one byte too far and fails to recognize a valid boundary on adversarial mixed-EOL input (e.g. `"\r--boundary\r\n"`) → mis-split multipart (parts merged / attachment dropped). Narrow trigger, but it's untrusted-input parsing.

**Direction:** change `||` to `&&`; add a splitter test with bare-CR / mixed-EOL boundary lines.

---

## P3 — nits, smells, dead code

### 15. [verified] Three dead / misplaced dependencies in `apps/api/package.json`
- **`docx` (^9.6.1)** — 0 imports anywhere; docx export uses `@turbodocx/html-to-docx`. Remove.
- **`@libsql/client` (^0.17.2)** — 0 imports; the app uses `bun:sqlite` throughout. Remove.
- **`drizzle-kit`** — 0 imports in `src`; only the `drizzle.config.ts` CLI uses it. Move to `devDependencies`.

### 16. Chat `?limit` can become `NaN` and escape the [1,200] clamp
`apps/api/src/routes/chat.ts:18,22-25` **[verified]**

`limit: t.Optional(t.String())` → `parseInt("abc")` = `NaN` → `Math.min(Math.max(1, NaN), 200)` = `NaN` → `LIMIT NaN` (SQLite treats a NaN bind as no-limit → unbounded fetch, or 500). Siblings `mail.ts`/`notification.ts` correctly use `t.Numeric()`/`t.Number({minimum,maximum})`.

**Direction:** `limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 }))`; drop the manual clamp.

### 17. `request-access` reads a foreign Home directly instead of via the relay
`apps/api/src/routes/drive.ts:550` → `lib/drive/access-request-propagation.ts:16`

The one authenticated route that calls `getHome(params.ownerId)` for an owner that is deliberately *not* the caller. The notification half already uses `sendToHome`; only the `home.drive.getPath(...)` read is off-seam. No runtime bug on one server, but it breaks the sharding abstraction the ownerId rule exists to protect.

**Direction:** add a `pull*`-style relay read (mirroring `pullCalendarById`) for the owner-side path lookup.

### 18. exiftool spawned without a timeout — orphaned child on a crafted file
`apps/api/src/lib/preview/exiftool-preview.ts:43-46` (and the `:21` `-ver` probe) **[verified]**

The **only** child-process spawn in the preview stack without a timeout+kill. weasyprint (`weasyprint.ts:36`), ffmpeg/ffprobe (`video-thumbnail.ts:31`) all wrap `setTimeout → kill`; exiftool does not. It runs in the thumbnail worker, whose 30s outer timeout only calls `worker.terminate()` — that ends the JS thread but does **not** reap the OS child, so a hostile file that hangs exiftool leaves an orphaned process. Repeated uploads pile up orphans — the weasyprint-EPIPE-incident shape.

**Direction:** pass `{ timeout: N, killSignal: 'SIGKILL' }` to `execFileAsync` (execFile natively kills the child on timeout).

### 19. No worker pool / concurrency cap on preview generation
`apps/api/src/lib/shared/thumbnails.ts:60-101`, unbounded fan-out at `export/media.ts:7-14`

`generateImagePreview` does `new Worker(...)` per call. `export/media.ts` does `Promise.all([...mediaByName].map(getScreenPreview))` — a cold-cache image-heavy doc/deck spawns N Workers at once, each loading the `sharp` native addon (and image ones may spawn exiftool). No semaphore anywhere in the preview tree (the only limiter in the repo is the S3 upload queue).

**Direction:** a small worker pool or shared concurrency limiter around `generateImagePreview`. `apps/api/src/utils/semaphore.ts` already exists.

### 20. `getOrCacheImage` lacks the in-flight dedup + TOCTOU guard its text sibling has
`apps/api/src/lib/preview/preview-cache.ts:48-66`

`getOrCacheText` dedupes concurrent regenerations (`inFlightText`) and try/catches cache reads; `getOrCacheImage` does neither. A folder grid of N tiles for one just-edited raster fires N concurrent `generate()`; and `existsSync(cacheFile)` → `Bun.file(cacheFile).arrayBuffer()` (`:56-57`) is a TOCTOU — a newer version's `pruneOldVersions` can unlink between the two → uncaught 500 during a version transition.

**Direction:** mirror the text path's dedup map + try/catch.

### 21. Duplicated WebDAV/CalDAV XML envelope + byte-identical `escapeXml`
`apps/api/src/lib/caldav/xml-builder.ts:7-21,72-79` and `apps/api/src/lib/webdav/xml.ts:6-33`

Both hand-roll `escapeXml` (identical five-`.replace` chain) and the `multistatus`/`response`/`propstat*` envelope, already drifting in whitespace/namespace decls. This is the "two lists of one fact drift" case from AGENTS.md; a fix to escaping in one won't reach the other. (Note: this — not "fast-xml-parser vs xml.ts" — is the real duplication. `webdav/xml.ts` only *builds*; fast-xml-parser only *parses*. And `ical-parse.ts` is *not* hand-rolled — it uses `ical.js`; only `ical-serialize.ts` re-implements RFC-5545, which round-trip tests cover, so leave it.)

**Direction:** hoist the shared envelope + `escapeXml` into one module both import.

### 22. Scheduler primitive has no `unref()` and no overlap guard
`apps/api/src/lib/scheduler/scheduler.ts:14-20`

Timers are never `.unref()`d, and `setInterval(run, ms)` re-invokes regardless of whether the prior async `fn()` resolved — no re-entrancy protection. Harmless for today's single idempotent daily `guest-cleanup`, but this is the generic primitive `jobs.ts` builds on.

**Direction:** `.unref()` the interval; guard `run` with an `isRunning` skip-if-still-running flag.

### 23. Temp-file leak in `replaceContainerDataDb` on early failure
`apps/api/src/lib/versioning/snapshot.ts:153-172`

`writeTempWithHash(mount.getTempPath(tempId), Bun.file(sourcePath))` (`:154`) runs *before* the `try { … } finally { cleanupTemp(tempId) }`. If that write/hash throws (bad source read), the partial temp is never cleaned. (Restore's own temp handling in `restore.ts:25-39` is correct.)

**Direction:** move the `writeTempWithHash` inside the `try`.

### 24. Small correctness/hygiene nits
- **`buildRecentText` unbounded** (`chat.ts:458-472`): `select().all()` then break at 8 KB — add `.limit(N)` so SQL does the bounding (same shape as #10).
- **`getTeamMembers` swallows all errors → `[]`** (`team.ts:14-26`): a real DB failure silently becomes "no members," masking ACL breakage. Drop the try/catch (CODE-STANDARDS "unnecessary error handling").
- **`computeEtag` omits `timezone`** at `rsvpForOccurrence` (`calendar.ts:1099`) and `removeThisAndFuture` (`:1259`) while create/update include it → same event hashes differently across paths → spurious CalDAV re-sync. Include `timezone` consistently.
- **Mail attachment `:index` unvalidated** (`mail.ts:282,289`): `Number("abc")` → `NaN`; benign today (`?? null`) but add `params: t.Object({ index: t.Numeric() })`.
- **SMTP `tls: { rejectUnauthorized: false }`** (`mailer.ts:44`): accepts any cert on the SMTP hop. Likely intentional for an internal relay — make it env-opt-out or add a WHY comment.
- **`my-teams` swallows relay-pull failures silently** (`home.ts:39-42`): `.catch(() => [])` renders a team with zero mounts/calendars with no log. Add `console.error`.
- **UUID source drift**: `chat.ts`/`mount.ts`/`maildir-store.ts` use `node:crypto randomUUID`; `calendar.ts`/`contacts.ts` use the `uuid` npm package's `v4`. `crypto.randomUUID` is a Bun global — unify on it and drop the `uuid` dep.
- **Dead rewrite-path code in the mailsplit fork**: `mail-split/mime-node.ts:189,196,233` + `headers.ts:70,87,119,147` + `flowed-decoder.ts:46-48` (base64 branch) — the encode/re-emit half, zero callers repo-wide (EML generation lives in `mailfile.ts`). ~80 lines of untested surface; delete.

---

## Bun-native optimization opportunities

Most of the obvious wins are **already taken** — `Bun.CryptoHasher` in the multipart stream and `StreamHash`, `Bun.zstdCompressSync` at the collab blob seam, `Bun.file`/`Bun.write` throughout storage, `S3Client` for S3, `FileSink` writers with `highWaterMark` for streaming uploads. Credit where due. Remaining, in rough value order:

1. **`node:crypto` → `Bun.CryptoHasher`** at the two remaining sites: `calendar/mappers.ts:19` (`createHash('md5')`) and `storage/s3-storage.ts:49,75,79` (the AWS SigV4 HMAC/SHA-256 for the versioning probe). Marginal, but it removes the `node:crypto` import from hot-ish paths.
2. **S3 versioning check is a hand-rolled SigV4 `fetch`** (`s3-storage.ts:31-72`). Bun's `S3Client` doesn't expose bucket-versioning status, so this is defensible — but it's ~40 lines of crypto that only runs on the admin connection-test. Fine to leave; noted for the record.
3. **`Bun.spawn({ timeout, killSignal })`** over the hand-rolled `setTimeout → proc.kill()` in `weasyprint.ts:36` and `video-thumbnail.ts:31`. Both currently send default SIGTERM, which a wedged renderer can ignore; Bun's native option guarantees reaping (and fixes #18 for exiftool). Simpler *and* more correct.
4. **`Bun.Image`** (Bun 1.3, no npm dep, off-thread, Sharp-like API) could in principle replace `sharp` in the thumbnail worker. **Not recommended now** — the worker also does HEIC (`heic-convert`) and EXIF extraction, and `sharp` is battle-tested here. Flag only as a future dependency-shedding option once `Bun.Image` HEIC/AVIF coverage is confirmed against your fixtures.
5. **`he` (HTML entities) and `linkify-it`** — Bun has no native replacement; keep. `encoding-japanese` / `iconv-lite` likewise have no Bun equivalent for legacy mail charsets; keep.

Net: the Bun-native story is already strong. Don't chase #4 — the risk/reward is bad. #1 and #3 are clean, low-risk touch-ups.

---

## Honest assessment & where I'd spend more time

**What I'm confident about:** the 2FA bypass (#1) is real and verified against the installed
better-auth source — that's the one thing I'd fix today. The dead deps (#15), swagger (#4), and the
WS payload gap (#5) are cheap certainties.

**What I'd want more time on — these deserve a dedicated pass, not a drive-by:**

1. **The collab/Yjs persistence + snapshot lifecycle** (`collabDocument.ts`, `yjs-loader.ts`,
   `document-db.ts`). I read it and it looks coherent, but the interaction between
   `DbProvider.createSnapshot`'s transaction, the write-behind `onSync` staging, and version
   restore's `applySnapshotState` is the highest-consequence, hardest-to-test surface in the
   system (data loss lives here — the code is littered with "the 2026-05-30 chat loss" /
   "2026-06-08 wipe" scars). I'd want to write adversarial concurrency tests (snapshot racing a
   close racing a restore) before trusting any change here. The `maxPayloadLength` gap (#5) is
   probably the *observable* tip of this iceberg.

2. **The S3 write-behind upload queue under real failure injection** (`upload-queue.ts`). The
   logic is careful (per-destination semaphore, `inFlight` set, cancel-mid-PUT resurrection guard,
   the 120s `Promise.race` timeout). But the "orphaned PUT lands after a newer PUT and regresses
   the object" case it *documents but accepts* (`:246-250`) is exactly the kind of thing that
   causes a rare, unreproducible data regression in prod. I'd want a chaos test: kill the process
   mid-drain, corrupt a staging file, stall a PUT past timeout, and assert the object always
   converges.

3. **CalDAV timezone correctness end-to-end** (#8, #9). I found two concrete discrepancies by
   reading, but recurrence + timezone + RECURRENCE-ID + EXDATE is a domain where reading isn't
   enough — I'd drive real Apple Calendar / Thunderbird against a DST-boundary recurring event and
   diff what round-trips. There are likely a couple more of these lurking.

4. **The mailparser fork's behavior on hostile input.** I confirmed it delegates correctly and
   found the `checkBoundary` typo (#14), but a 1424-line vendored parser fed untrusted email is
   worth a fuzzing pass (malformed MIME, charset bombs, deeply nested multipart) rather than a
   line read.

**What I explicitly did NOT audit:** tests (out of scope), the frontend apps, `packages/`, and the
non-critical route domains beyond a sweep. The findings here are `apps/api/src` core + domains.

---

## Cleared (checked, not findings) — so you know they were covered

ownerId rule + carve-outs (correct on every authenticated route); path/name traversal (`validateName`
+ `resolveWithinBase` + S3 segment guard all sound); header injection via `contentDisposition`
(strips CR/LF, escapes quotes); contacts avatar traversal (guarded); chat invite ACL (enforced in
`SharedDrive.inviteToChat`); guest OTP (hashed, expiring, single-use, rate-limited on request);
`requireLocalhost`/`clientIpKey` (rejects spoofed proxy headers); `Home`/`getHome` destruct
idempotency + race handling; `createAsyncSingleton`; the multipart parser's boundary skip-table
(Uint16, can't wrap); `ManagedDatabase` close/checkpoint/journal handling; WebDAV range streaming
(`.stream()`, no whole-file buffer); the sync-resilience temp-adoption guards
(`isViableRecoveryTemp`); notification-center timestamp comparisons; share reconciliation; the
in-repo IMAP question (there is none — Dovecot external, auth via `verifyProtocolAuth`).
