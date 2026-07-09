# Proposal: Mail performance at large mailbox sizes

Status: proposal — researched 2026-07-09, nothing implemented.
Scenario studied: a real account shape of **~50,000 mails in Inbox + ~50,000 in Archive**.

## Current situation

### What one "archive" costs today

The FE has **zero optimistic updates** in mail — every mutation is `invalidateQueries` only
(`packages/lib/src/core/mail/hooks/use-emails.ts`). Archiving one email while the Inbox is open:

1. `useMoveEmail.onSuccess` → `invalidateMailMoved` invalidates **detail + source list + target
   list + mailbox counts** (`use-emails.ts:195-207`).
2. The source list (Inbox) is active/mounted → TanStack Query **immediately refetches all
   50,000 summaries**. The Archive list is marked stale (refetches on next visit).
3. The server then echoes `MAIL_MOVED` over SSE **to the same client** — `home.broadcast()`
   (`apps/api/src/lib/home/home.ts:306`) has no origin exclusion — and the SSE handler
   (`sse-handlers.ts:40`) invalidates the same keys again. Measured in the browser: **three**
   full-list refetches fire per archive (mutation + mailboxes-invalidation + SSE echo).
4. Every refetched array is a new reference, so `use-mail-list.ts` re-runs a **full 50k
   filter + sort** (with a `new Date()` per comparison), plus O(50k) `findIndex`/`some` scans.

Read/flag toggles behave the same (`invalidateMailReadChanged` / `invalidateMailFlagsChanged`
→ full list refetch to flip one boolean). Batch actions fire N independent mutations, each
invalidating again.

### The list endpoint has no pagination

`GET /mail/:ownerId/mailbox/:path` → `store.listMessages()` → `SELECT * FROM emails WHERE
mailbox = ?` — **no LIMIT, no ORDER BY** (`apps/api/src/lib/mail/maildb.ts:148-150`). All
50k rows serialize into one JSON response. Each `EmailSummary` carries 17 fields including
`textShort` (≤200 chars preview), `recipientsAll`, `filename` — roughly 0.3–0.6 KB/row, so
**~15–30 MB per mailbox fetch**, parsed on the FE main thread on every (re)fetch.

Rendering itself is fine — the list is virtualized (`@tanstack/react-virtual`); the cost is
the transfer + JSON parse + the full-array memos, not the DOM.

### Sync runs on the request path, under a per-user global lock

`listMessages` **awaits `syncMailbox` before returning** (`maildir-store.ts:117-123`).
`doSyncMailbox` (`maildir-store.ts:255-316`) is a full O(N) reconciliation every time:
`readdir` all ~50k `cur/` entries, load **all 50k DB rows**, build two Maps, diff filenames
for flag changes, detect deletes. With new mail it additionally runs **one serial awaited
`parseEml` (full MIME parse + DOMPurify) per new file**, each with a synchronous
`db.addEmail` (+ FTS5 trigger) and an SSE broadcast + notification persist.

All of this runs inside `storeLock` — a `Semaphore(1)` shared with **every** mail mutation
(move/setFlags/delete/append). A long sync therefore queues all archive/read actions for
that user. And none of it is off-thread: parses, `readdir`, sqlite calls and the 20 MB JSON
serialize all run on the **single Bun event loop shared by all users**.

Sync triggers: on **every list request**, on fs-watcher events, and on delivery. There is no
timer and no incremental/cursor mechanism to build on — but also nothing that needs one yet.

### Measured (dev Mac, Bun 1.3.14, real `MaildirStore` on an isolated maildir + fresh mail.db)

All numbers **measured at full scale** (50,000 Inbox + 50,000 Archive), not extrapolated.
Warm/list/mutation rows are medians of 3. Throwaway bench scripts kept at
`~/eigen-mail-bench/{bench,profile}.ts` (run from repo root).

| Operation | Result |
|---|---|
| Cold sync (first index) of 100k messages | **92 s** (~1,090 msg/s), holds `storeLock` throughout |
| Warm no-op sync of 50k mailbox (open, 0 new) | **160 ms** (dominated by loading all 50k DB rows to diff) |
| Incremental sync, +1,000 new files | **991 ms** — the reconcile still reads all 51k rows + readdirs all files, so cost scales with *total* size, not the delta |
| List query (`getAllEmails`, 51k rows) | **110 ms** DB time |
| List JSON payload, 51k Inbox | **34 MB** (~700 B/row) per (re)fetch |
| `listMessages()` route path (sync + read) | **301 ms** per list request, every time |
| Single move (archive) at 100k rows | **3.9 ms** |
| Single setFlags at 100k rows | **1.9 ms** |

Phase attribution of cold sync (isolated, N=10k): `db.addEmail` **71%**, `parseEml` **29%**,
filesystem readdir **0.1%**. The intuition "MIME parsing is the bottleneck" is wrong —
**SQLite insertion dominates**: `addEmail` (`maildb.ts:28`) does a SELECT existence check +
INSERT per message, each insert firing the FTS5 trigger over 7 columns, with **no
transaction batching**. Mutations themselves are cheap (2–4 ms); the problem is volume ×
serialization, not per-op cost.

### Measured end-to-end (Playwright + Chrome against the dev server)

Throwaway user seeded with 20,000 mails (Inbox 9,084 / Archive 5,025 / rest spread). Dev
build (unminified), so FE times are pessimistic; transfer sizes are exact.

| Scenario | List request | Payload | To first row |
|---|---|---|---|
| First-ever open (builds index) | **11.5 s** | 6.5 MB | index-bound |
| Cold open, index persisted | 122 ms | 6.5 MB | ~0.9 s |
| Warm reload | 106 ms | 6.5 MB | ~0.9 s |

**Archiving one mail** (detail-toolbar button): **3 full-list refetches** of the Inbox
within 5 s — mutation invalidation + `invalidateMailboxes` + SSE echo — totalling
**19.5 MB re-downloaded** for a single-row change, with ~100 ms of main-thread stall.
At a 9k inbox. Linear extrapolation to 50k: **~35 MB per fetch, ~105 MB per archive.**

Scrolling the virtualized list: smooth, 0 long tasks, ~21 rows in DOM — rendering is not
the problem; transfer + parse + invalidation amplification are.

## Improvement options

Ordered smallest-first. Each step is independently shippable and useful on its own.

### Step 1 — Optimistic cache updates instead of invalidation (FE only, small)

The single highest-leverage change. On move/read/flag, surgically patch the cached arrays
with `setQueryData` (remove the row from the source list, flip the boolean) instead of
invalidating. The repo already has this exact pattern in
`use-drive-view-preferences.ts:69-78` (onMutate snapshot + patch + rollback on error) and
`use-draft.ts:90,107` (already in the mail domain).

- Archive of one mail: 0 refetches instead of 1–2 × 20 MB.
- Also fixes the pre-existing "unread dot lags" bug found during the shortcuts work
  (inbox rows carry `mailbox: ""` which never matched the invalidation key — a surgical
  patch by id doesn't care).
- SSE echo handling: keep SSE invalidation for *other* clients but make it cheap for the
  originator — e.g. skip invalidation when the cache already reflects the change (compare
  the row state), or simply accept one background refetch. Simplest correct version: keep
  SSE as-is initially; the optimistic patch already makes the UI instant.

### Step 2 — Server-side pagination + `ORDER BY date DESC` (BE + FE, medium)

Add `?limit=&before=` (date cursor) to the mailbox list route; default limit ~200–500.
`idx_emails_date` already exists. FE switches `useEmails` to `useInfiniteQuery` — a working
in-repo template exists in chat (`use-chat.ts:32-43`, `before` cursor). The virtualizer's
`onChange` fetches the next page when the last rendered index nears the loaded count.

- First paint of a 50k mailbox: ~100 KB instead of ~20 MB.
- Client-side filter/sort in `use-mail-list.ts` collapses to the loaded window; server owns
  the order. The list search box should then hit the existing FTS5 `searchMail` (already
  LIMIT-ed) instead of filtering the full array locally.
- This is the step that makes 50k *feel* like 50 — but it touches list/cursor/selection/
  shortcuts code, so do it after Step 1, not together.

### Step 3 — Take sync off the request path (BE, small-medium)

`listMessages` currently blocks on a full reconciliation. Change to: serve the DB rows
immediately, kick `syncMailbox` fire-and-forget (it already coalesces concurrent syncs via
`syncingMailboxes`); new/changed rows arrive via the existing per-message SSE events.
Optionally keep the blocking sync only when the DB has zero rows for the mailbox (first
open). This removes the "open Inbox with 1,000 new mails = stare at a spinner for the whole
parse" case: the stale list shows instantly and fills in.

Cheap add-on in the same area — and per the phase measurements the **biggest cold-sync
win**: wrap the new-message loop's inserts in **one transaction** (and drop the per-insert
SELECT existence check — the sync already knows the id is new from its diff map). With
`addEmail` at 71% of a 92 s cold sync, transaction batching alone should cut first-index
time by well over half. Also coalesce the per-message `received` notifications (the
notification center already supports `coalesce`).

### Step 4 — Only if measurements demand it: worker offload / body cache

- Move `parseEml` for sync into a Bun `Worker` so a cold 50k index doesn't block the event
  loop for all users. Note: measurement says parsing is only ~29% of cold sync — do the
  Step-3 transaction batching first; a worker only helps the residual. Only worth it for
  self-hosters importing big mailboxes.
- A FE persistence layer (IndexedDB via `persistQueryClient`) for summaries/bodies. **Not
  recommended now**: bodies are already fetched per-message (cheap, cache-hits via
  `emailKeys.detail` + staleTime), and after Steps 1–2 the summary traffic is small. This
  is the classic overengineering trap — skip until a real need shows.

## What NOT to do

- Don't build a client-side mail database / full offline store — Steps 1+2 get ~99% of the
  win for ~5% of the complexity.
- Don't split summaries into "ids+flags" and "content" endpoints — the summary row is
  already the light representation; pagination fixes the volume problem more simply.
- Don't debounce/queue invalidations as a band-aid — optimistic updates remove the need.

## Suggested order

1. Step 1 (optimistic updates) — small PR, immediate UX win at any mailbox size, fixes the
   known stale-dot bug.
2. Step 3 (non-blocking sync) — small BE PR, fixes the big-sync stall.
3. Step 2 (pagination) — the structural fix; do it as its own cycle with the shortcuts/
   cursor interactions in scope.
4. Re-measure; only then consider Step 4.
