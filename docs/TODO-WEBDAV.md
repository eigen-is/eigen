# WebDAV TODO

Follow-ups deferred from the WebDAV server branch (`feat/webdav-server`).
Litmus baseline at branch end: **96/101** (97%). Real macOS Finder copy
verified working with a 160 MB MP4. None of the items below are blockers
to shipping; they're known gaps worth addressing in a follow-up session.

For protocol architecture see `docs/PROPOSAL_DRIVE_MOUNT.md`.
For client recipes see `docs/WEBDAV-RCLONE.md`, `docs/WEBDAV-MOUNTAIN-DUCK.md`.

---

## Outstanding

### 1. Overwrite-PUT path skips thumbnail regeneration

**Symptom:** An image dropped onto a Finder-mounted drive does not get a
thumbnail.

**Why it happens:** Finder's two-step copy goes:
1. `PUT Content-Length: 0` — placeholder, lands via `createFileFromData`
   → `finalizeUpload` (`drive.ts:1067`) runs `saveThumbnail` on **0 bytes**
   and produces nothing.
2. `LOCK` → `PUT` chunked with the real content → routed through
   `writeFileContent` (`drive.ts:527`), which **does not call
   `saveThumbnail`** — it only writes bytes and emits
   `DRIVE_FILE_UPLOADED`.

Net effect: file lands at correct size, but the row's `thumbnail` column
stays null and `details.width`/`height` are unset.

**Scope:** This is not just a WebDAV bug — `writeFileContent` is the
generic overwrite path. Any flow that overwrites an existing file's
content (chat re-upload, future API endpoints) has the same hole. WebDAV
just makes it visible because Finder *always* overwrites.

**Fix sketch:** Have `writeFileContent` regenerate the thumbnail after
the write, mirroring `finalizeUpload`'s async block. Keep it
non-blocking so a slow ImageMagick run doesn't stall the response.
Consider extracting the "regenerate thumbnail for pathId" block into a
helper both call sites can share.

**Bonus:** The 0-byte placeholder PUT also runs `saveThumbnail` once for
nothing. Cheap to skip when `size === 0`, saves an ImageMagick spawn per
Finder copy.

---

### 2. `X-Expected-Entity-Length` not honored for quota pre-check

**Symptom:** A Finder user with a chunked PUT can overshoot mount quota
by one upload. Authenticated-user-noisy, not adversarial — but a real gap.

**Why it happens:** `handlePut` (`apps/api/src/lib/webdav/resource.ts`)
pre-checks quota against `Content-Length`. Finder's actual content PUT
uses `Transfer-Encoding: chunked` (no `Content-Length`) and signals the
true size via `X-Expected-Entity-Length` (an Apple-specific header).
Today we treat that as missing and skip the pre-check.

**Fix sketch:** In the route handler (or `handlePut` itself), fall back
to `X-Expected-Entity-Length` when `Content-Length` is null. The header
is advisory — still enforce quota *during* the write — but using it for
the cheap pre-reject improves the error message (507 up front vs.
mid-stream failure).

---

### 3. Mount migration framework is content-blind

**Symptom (during this branch):** Adding a `webdav_dead_props` migration
at version 2 silently failed on existing dev DBs because they were
already stamped at version 2 by a *different* migration that had been
rolled back into v1. Worked around by bumping the new migration to
version 3 with a comment (`db-config.ts`).

**Why it matters:** A future contributor adding a v3 migration could
trip the same way. The framework records `__schema_version` but not
*what* ran. Two divergent dev DBs both stamped "v3" can hold different
schemas.

**Fix sketch (rough — needs design):** Track per-migration identifiers
(name + content hash) in a `__schema_migrations` table, alongside the
running `__schema_version` counter. On startup, refuse to proceed if a
recorded migration's hash mismatches the current code. Out of scope for
the WebDAV branch; flag it before it bites someone.

---

### 4. Litmus failures left intentionally

`litmus http://localhost:8000/webdav/<owner>/<mount>/ <user> <pass>`
final score: 96/101.

| # | Group | Test | Verdict |
|---|-------|------|---------|
| locks#19 | locks | cond_put_corrupt_token | **Defer.** Needs full RFC 4918 §10.4 tagged-list `If` parser (URI tag + multi-condition). Real work, not a one-line fix. |
| locks#21 | locks | complex_conditionals | **Defer.** Same parser as #19. |
| locks#37 | locks | indirect_refresh on lock-null | **Won't fix.** Lock-null resources are a deprecated WebDAV concept — RFC 4918 explicitly drops them in favour of LOCK on a created resource. |
| props#2 | props | propfind_invalid2 | **Defer.** We accept some malformed-namespace XML that an expat-strict parser would reject. Stricter validation would also need to keep our own well-formed bodies passing. |

Pursuing locks#19/#21 is the only one that meaningfully closes a real
RFC 4918 gap. props#2 is a strictness call. locks#37 is dead.

---

## From 2026-04-30 deep code review (all addressed 2026-05-01)

Five-agent parallel review. Container-internals-readable was confirmed
by Reinder ("fine if someone reads content of an eigendoc, it should be
read-only"), so the guard is correct as written: writes blocked, reads
permitted. Items 5–14 below are kept for the audit trail; all are now
fixed — see "Done in this branch" at the bottom for commit links.

### 5. LOCK `acquire` ignores ancestor depth-infinity locks

**Symptom:** A client `LOCK`s a child of a depth-infinity-locked
collection. The acquire succeeds and returns a token. The first write
with that token returns 423.

**Why it happens:** `LockManager.acquire`
(`apps/api/src/lib/drive/lock-manager.ts:51`) only consults
`byPath.get(args.pathId)` for conflicts. `isWriteAllowed` correctly
walks ancestors via `coveringLocks`, so writes are gated — but the
acquire path skips the same walk. Acquire and write-check use
inconsistent conflict logic.

**Fix sketch:** Mirror `coveringLocks(pathId, ancestorIds)` at acquire
time. The handler already has the breadcrumb (or can compute it). May
require threading `ancestorIds` into `acquire` args. Pairs naturally
with the depth-infinity write check shipped in `206a19a8`.

---

### 6. Lock `Timeout` header has no upper bound

**Symptom:** Authenticated user sends `Timeout: Second-2147483647`,
pinning an in-memory lock for ~68 years. With no per-user lock count
limit either, this is a memory exhaustion vector for any auth user.

**Why it happens:** `parseTimeoutHeader` in
`apps/api/src/lib/webdav/locks.ts:9-13` does `Number(match[1]) * 1000`
with no clamp. GC only runs on `acquire`/`listForPath` and only evicts
expired locks — multi-year TTL never expires.

**Fix sketch:** Cap at a reasonable ceiling at parse time
(`Math.min(parsed, MAX_LOCK_TTL_MS)`). 24h or 7d is plenty for any real
client. Optional: per-user lock count cap in `acquire`.

---

### 7. DELETE and cross-mount MOVE leak source locks

**Symptom:** After `drive.deletePath(...)` (or the cross-mount MOVE
source-delete), the in-memory `LockManager` still holds entries keyed
by the now-deleted `pathId`. Memory leaks until TTL expiry. Combined
with #6, the leak is unbounded.

**Why it happens:** `handleDelete` in
`apps/api/src/lib/webdav/resource.ts:226` and the cross-mount MOVE arm
in `move-copy.ts:113-114` don't release locks for the deleted source.
LockManager only GC's on TTL.

**Fix sketch:** After `deletePath`, iterate
`drive.lockManager.listForPath(path.id)` and `release()` each token.
Same in the cross-mount MOVE arm before the source delete. Cheap.

---

### 8. `If-None-Match` evaluated before `If-Match` (RFC 7232 §6 order)

**Symptom:** A request with conflicting `If-Match` and `If-None-Match`
headers returns 304 when it should return 412. Rare in practice (most
clients send only one), but technically incorrect.

**Why it happens:**
`apps/api/src/lib/webdav/resource.ts:40-45` checks `If-None-Match`
first. RFC 7232 §6 specifies `If-Match` → `If-Unmodified-Since` →
`If-None-Match` → `If-Modified-Since` → `If-Range`.

**Fix sketch:** Swap the two `if` blocks. One-line diff.

---

### 9. No body-size cap on PROPPATCH/LOCK XML

**Symptom:** Authenticated user sends a 100MB+ PROPPATCH or LOCK body;
`await request.text()` reads it whole, `fast-xml-parser` parses
synchronously, event loop blocks. DoS vector for auth users.

**Why it happens:** Handlers don't gate on `Content-Length` before
reading body. Bun has implicit limits, but they're per-process not
per-handler.

**Fix sketch:** Cheap byte-length cap (e.g. 64KB) at handler entry.
PROPFIND, PROPPATCH, LOCK bodies are all small in normal use; anything
bigger is suspicious.

---

### 10. `Resolved | Response` discriminated union return (cleanup)

**Symptom:**
`apps/api/src/lib/webdav/move-copy.ts:35-87`'s `resolveMoveCopy`
returns either a `Resolved` bag or a precondition-failed `Response`.
Both callers do `if (resolved instanceof Response) return resolved`.
CODE-STANDARDS.md flags this exact shape as BAD ("Unnecessary
discriminated union for two cases").

**Fix sketch:** Replace the `return new Response(null, { status: 412 })`
at line 66 with `throw new ApiError(412, 'Destination exists, no
overwrite')`. Function returns plain `Resolved`. Both callers drop the
`instanceof` check.

---

### 11. `WebdavPathCache` is over-engineered (cleanup)

**Symptom:** A single-method class wrapping a `Map.get/set` with one
indirection (`apps/api/src/lib/webdav/path-resolve.ts`). Instantiated
fresh in every handler. CalDAV has no equivalent.

**Fix sketch:** Inline `const cache = new Map<string, DrivePath |
null>()` per handler with a small `resolveCached(cache, drive, mountId,
pathStr)` helper if the dedup is worth it. Or just dedupe at callsites
— most handlers resolve only 2–3 paths.

---

### 12. `assertWritable` parameter type alias (cleanup)

**Symptom:**
`apps/api/src/lib/webdav/locks.ts:19` types `drive` as
`Awaited<ReturnType<typeof getSharedDrive>>`. The aliased type is
exactly `Drive | SharedDrive`, and a `DriveLike` alias already exists
in `path-resolve.ts:5`.

**Fix sketch:** Import and use `DriveLike` (or `Drive | SharedDrive`
directly).

---

### 13. `buildXmlResponse` adds undocumented Cache-Control (cleanup)

**Symptom:** Every WebDAV XML response includes `Cache-Control:
no-cache, must-revalidate` (`apps/api/src/lib/webdav/xml.ts`
`buildXmlResponse`). CalDAV's equivalent doesn't. No comment explains
why.

**Fix sketch:** Either add a one-line WHY comment (RFC ref or specific
client incompat that motivated it) or drop the header.

---

### 14. Container-detection logic spelled three different ways

**Symptom:** "Is this path inside / under an `.eigen*` container?" is
now answered by three independent code paths with three slightly
different filters.

| Where | Filter | Walks |
|---|---|---|
| `Drive.findContainerPath` → `findContainerFromAncestors` (`acl.ts:87`) | `isCollabType(p.type)` — **excludes chat** | up |
| `Drive.isInsideContainer` / `isContainerWriteBlocked` (`drive.ts:489-501`) — new in this branch | `isContainerType(p.type) && !== DRIVE_TYPE_FOLDER` — **includes chat** | up |
| `Mount.getPathsByMimeType` `excludeDocumentChildren` CTE (`mount.ts:1007`) | inline `IN (DRIVE_TYPE_DOC, _STICKIES, _SLIDES, _SHEETS, _CHAT)` — **includes chat** | down |

The chat-included variants and chat-excluded variant disagree on
purpose (ACL inheritance is collab-only; WebDAV write-protect must
include chats; mime-type filtering also includes chats), but the
type-set is hard-coded in three places. Adding a new container type
(or removing one) requires touching all three.

Additionally, `webdav/resource.ts handlePut` walks the breadcrumb
**three** times per request:
1. `drive.isInsideContainer(existing)` (resource.ts:115)
2. `drive.isContainerWriteBlocked(parent)` (resource.ts:140)
3. `assertWritable` → `drive.breadCrumb` (locks.ts:25)

Three SQLite recursive-CTE walks for the same ancestor chain.

**Fix sketch:**
- Centralise the "non-folder container types" set as a single exported
  constant (e.g. `EIGEN_CONTAINER_TYPES` in `types/drive.ts`) and use
  it from all three call sites. `isCollabType` stays as the
  chat-excluded variant for ACL inheritance.
- Consider replacing `isInsideContainer`/`isContainerWriteBlocked`
  with a parameterised `findContainerPath(mountId, pathId, {
  includeChat: true })` so there's one ancestor-walking helper, not
  three.
- In `handlePut`, fetch the breadcrumb once at the top and pass it to
  the three checks instead of re-querying. Same for `handleMove` /
  `handleCopy` / `handleDelete`.

The new functions are only called from WebDAV today, so this refactor
is local and safe.

---

## Done in this branch (for reference)

**Initial review pass (through 2026-04-30).** R1–R5 (architectural
cleanups), L1–L5 (lock state correctness), P1 (PROPFIND XML validation),
C1 (COPY Depth: 0). End-to-end verified with macOS Finder. Capped by
`accept 0-byte PUT (Finder placeholder pattern)` (`cb590182`).

**Follow-up pass (2026-05-01).** Items 5–14 above plus one Cyberduck-
discovered fix:

| # | Commit | Summary |
|---|---|---|
| 5 | `33945d54` | LOCK acquire honors ancestor depth-infinity locks |
| 6 | `6c8f12db` | Cap LOCK Timeout at 24h |
| 7 | `aac632c5` | Release source locks on DELETE / cross-mount MOVE |
| 8 | `9de3ee19` | If-Match before If-None-Match (RFC 7232 §6) |
| 9 | `38a354b9` | Cap PROPFIND/PROPPATCH/LOCK XML bodies at 64KB |
| 10–13 | `f798ee64` | Post-review cleanups: drop `Resolved \| Response` union, drop `WebdavPathCache`, use `Drive \| SharedDrive` directly, drop undocumented Cache-Control |
| — | `203143b3` | URL-decode wildcard params and Destination header (Cyberduck's `My%20Folder` was 404) |
| dead-props | `d6c9f470` | Store dead-props in `DrivePath.details` (table dropped, 9 methods → 1) |
| 14 | `680ae3e5` | Single breadcrumb walk per write handler, `EIGEN_DOCUMENT_TYPES` constant, `Drive.isInsideContainer/isContainerWriteBlocked` removed |
| discovery | (this branch) | `/webdav/` and `/webdav/<ownerId>/` no longer discoverable; canonical URL is `/webdav/<ownerId>/<mountId>/`. Space Integrations page lists one URL per mount (personal + team). `discovery.ts` deleted. |

End state of WebDAV-flavored Drive surface: `lockManager` field +
`updatePathDetails` (generic). Container-detection logic lives in
`lib/webdav/container-guard.ts` as a pure function over a pre-fetched
breadcrumb. Type-set has one source of truth (`isDocumentType` /
`EIGEN_DOCUMENT_TYPES`).
