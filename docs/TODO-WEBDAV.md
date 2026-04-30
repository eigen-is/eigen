# WebDAV TODO

Follow-ups deferred from the WebDAV server branch (`feat/webdav-server`).
Litmus baseline at branch end: **96/101** (97%). Real macOS Finder copy
verified working with a 160 MB MP4. None of the items below are blockers
to shipping; they're known gaps worth addressing in a follow-up session.

For protocol architecture see `docs/PROPOSAL-WEBDAV-CALDAV.md`.
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

`litmus http://localhost:3000/webdav/<owner>/<mount>/ <user> <pass>`
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

## Done in this branch (for reference)

All review issues closed: R1–R5 (architectural cleanups), L1–L5 (lock
state correctness), P1 (PROPFIND XML validation), C1 (COPY Depth: 0).
End-to-end verified with macOS Finder. Branch shipped with
`accept 0-byte PUT (Finder placeholder pattern)` (`cb590182`).
