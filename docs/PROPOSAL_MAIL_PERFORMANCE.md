# Proposal: Mail performance at large mailbox sizes

Status: **Steps 1, 2, 3 IMPLEMENTED** on branch `feat/mail-performance` (2026-07-09), verified
at full scale (a throwaway dev user with 50,000 Inbox + 50,000 Archive). `bun run check` green
(1744 pass / 0 fail, lint + typecheck clean); independent whole-branch review "sound to merge".
Measured live: first inbox paint ~130 KB / one 200-row page (was ~34 MB), keyset scroll pages
with no gaps/dups, instant optimistic archive, inbox-scoped server search, non-blocking sync
serving stale in ~5 ms while the background cold-index runs (~1.6k msg/s). NOT pushed / no PR —
the branch sits on top of the unmerged `feat/mail-gmail-shortcuts`. Step 4 (worker offload) and
the "recently-mutated registry" (Step 1 option b) remain deferred follow-ups (see the note at the
end of Step 1 and § What NOT to do); the shipped Step 1 uses the chosen default, option (a).
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
`textShort`, `recipientsAll`, `filename` — roughly 0.3–0.6 KB/row, so **~15–30 MB per
mailbox fetch**, parsed on the FE main thread on every (re)fetch.

*Review correction:* `textShort` is **not** a ≤200-char preview for ingested mail —
`parseEmlBytes` (`mail-parse.ts`) stores the **full plain-text body** (`parsedMail.text ||
''`); only the draft path truncates to 200 (`MailDB.updateDraftContent`). The ~700 B/row
measured reflects the short synthetic bench mails; real newsletters/long threads put
multi-KB bodies in every list row, so real-world payloads can be substantially worse than
the measured 34 MB. The full text is also what feeds FTS5 body search, so it must NOT be
truncated in the DB — cap it at the list-response seam instead (see Step 2).

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
Warm/list/mutation rows are medians of 3. Bench scripts live at
`apps/api/scripts/mail-{bench,profile}.ts` (run from repo root).

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

- Archive of one mail: instant UI, and 0 mutation-triggered list refetches instead of 1–2
  × 20 MB. (The SSE echo still causes one background refetch until the echo is handled —
  see below.)
- Also fixes the pre-existing "unread dot lags" bug found during the shortcuts work:
  inbox rows carry `mailbox: ""` (the BE canonical form for INBOX). The SSE path already
  normalizes `'' → 'inbox'` (`normalizeMailbox` in `sse-handlers.ts`), but the mutation
  `onSuccess` path passes `email.mailbox` straight into `emailKeys.list()`, building key
  `{mailbox: ''}` which misses the cached `{mailbox: 'inbox'}` list. An id-based patch
  applied across all cached lists doesn't care.
- SSE echo handling: the server echoes every mutation back to the originator
  (`home.broadcast` has no origin exclusion), and the handler invalidates the same keys.
  "Compare cached row state to decide whether to skip" does NOT work in general: SSE
  payloads carry only `{messageId, mailbox, toMailbox?}` — no target flag values to
  compare against (read/flag events are effectively toggles from the FE's view). Two
  workable options: (a) ship with the echo untouched — UI is already instant, one
  background refetch per mutation is acceptable pre-pagination and cheap post-pagination;
  (b) a short-TTL "recently mutated" registry (module-level `Set` of
  `${eventType}:${messageId}` entries, ~5 s TTL, written in `onSuccess`, consulted by the
  SSE handler before invalidating). Do (a) first; add (b) only if batch actions still feel
  heavy. Don't build server-side origin exclusion for this — it touches all SSE plumbing
  for marginal gain.

Implementation notes (reviewed against the code):

- **Patch by predicate, not by key.** Use
  `queryClient.setQueriesData({ queryKey: emailKeys.lists(ownerId) }, updater)` to patch
  the row by `id` in *every* cached list rather than computing which mailbox key holds it.
  This sidesteps the `''`/`'inbox'`/case normalization pitfalls entirely (list keys are
  lowercased, SSE events use canonical case, inbox is `''` on the BE) and handles the row
  appearing in multiple caches.
- **Scope: optimistically patch only the list arrays.** Keep the existing
  `invalidateQueries` for the detail key and `invalidateMailboxes` (both are cheap — one
  message fetch, one counts fetch). Move: remove the row from all lists; leave the target
  list to its existing invalidation (usually unmounted → lazily refetched on next visit).
  Read/flag: flip the boolean on the row in place. Delete/trash: remove the row
  (`useDeleteEmail` has two paths — permanent delete and move-to-trash — patch both).
- **Follow the full onMutate contract** from `use-drive-view-preferences.ts`:
  `cancelQueries` → snapshot (`getQueriesData`) → patch → return context → restore in
  `onError` (+ `onMutationError`). Note `useToggleReadEmail` short-circuits when
  `isRead === email.isRead` without calling the API — keep the patch consistent with that.
- **Write the list-patch as one small shared helper** (e.g. `patchEmailInLists(qc,
  ownerId, id, updater | 'remove')`) in `use-emails.ts` next to the invalidation helpers.
  Step 2 later changes the cache shape to `InfiniteData<EmailSummary[]>` — with a single
  helper, that migration touches one function.
- Batch actions (`use-mail-actions.ts`) fire N independent mutations via
  `Promise.allSettled` — with patches these become N cheap in-place updates; no change
  needed there for this step.

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

Implementation notes (reviewed against the code):

- **Cursor must be composite `(date, id)`.** `date` is a Unix-epoch integer (Drizzle
  `mode: 'timestamp'`) with duplicate values in practice; a bare `before=date` cursor
  skips or repeats rows at page boundaries. Use keyset pagination:
  `WHERE mailbox = ? AND (date, id) < (?, ?) ORDER BY date DESC, id DESC LIMIT ?`.
  `id` (TEXT PK) is the tiebreaker. Chat's id-only cursor is the template for the FE
  shape, not for the SQL.
- **Add the missing composite index** `idx_emails_mailbox_date ON emails(mailbox, date DESC, id DESC)`
  as a new `db-config.ts` migration version — existing indexes are `(mailbox)`,
  `(mailbox, isRead)`, `(date)`; none serves this query at 50k rows.
- **Cap `textShort` in the list response** (e.g. `.slice(0, 200)` at the DTO seam in
  `listMessages`/route mapping, NOT in the DB — see the correction above; the full text
  must stay in the DB for FTS5). This multiplies the pagination win for real mailboxes.
- **Route contract:** add an optional `t.Object` query schema (`limit`, `before`);
  omitted params → current full-list behavior or first page, either is fine as long as
  the FE and any other consumers agree. Keep the response an `EmailSummary[]` page (the
  FE derives `hasMore` from `page.length === limit`, as chat does) — no envelope needed.
- **FE blast radius is the real work** — everything below assumes a complete array today
  and must be checked against a partial window (all verified in code):
  - `use-mail-list.ts`: client sort (`new Date()` per comparison — after this step the
    server owns the order; drop the client sort or keep it as a cheap merge of pages),
    search filter (switch to FTS5 `searchMail` via the existing search route),
    id-based cursor with index derivation.
  - `use-mail-shortcuts.ts`: j/k, `[`/`]` archive-and-advance, `*r/*u/*s/*t` select
    chords, Cmd+A — all operate on `orderedEmails`; acceptable semantics is "within the
    loaded window", but j/k at the bottom edge should trigger `fetchNextPage`.
  - `_auth.$filterType.$filterId.tsx`: auto-advance neighbour lookup
    (`orderedEmails[idx ± 1]`) and the `displayEmails` isRead overlay
    (`emails.some((m) => m.id === openId)`) — both silently no-op when the open email
    isn't in the loaded window; decide and document the fallback (stay on list).
  - Sidebar unread counts are already decoupled (they come from `useMailboxes`, not from
    counting list rows) — no work needed there.
- **Invalidation amplification warning:** on an infinite query, plain `invalidateQueries`
  refetches *every loaded page*. Step 1's surgical patches (via the single list-patch
  helper, updated for `InfiniteData` shape) become load-bearing here, and the SSE echo
  refetch that was "acceptable" in Step 1 should be revisited: either set
  `maxPages` (supported in TanStack Query v5, in use here) to bound the damage, or add
  the recently-mutated registry from Step 1 option (b).
- `MAIL_RECEIVED` SSE for a new message can keep invalidating — with `maxPages`/first-page
  refetch that's the correct, cheap behavior for "new mail arrives at the top".

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

Implementation notes (reviewed against the code):

- **Correctness of serve-stale is already guaranteed by the existing design** (verified):
  user mutations (`move`/`setFlags`/`delete`/`append`) update `mail.db` synchronously
  inside `storeLock` before responding, so the DB is never stale w.r.t. the user's own
  actions. Staleness only concerns externally-changed mail (new delivery, another client
  touching the maildir), and `doSyncMailbox` emits `received`/`flagsChanged`/`deleted`
  events for exactly those discoveries — the SSE handlers invalidate the list and the FE
  converges. No new mechanism needed; just don't await.
- Fire-and-forget must carry `.catch()` (AGENTS.md rule); the fs-watcher call site in
  `watch()` is the exact template. `syncingMailboxes` coalescing means a burst of list
  requests still runs one sync.
- First-open detection: `db.getEmailsCount(mailbox) === 0` (method exists, used by
  `getMailboxInfo`). Keep the `mailboxDirExists` 404 check blocking as-is.
- **The transaction wrap cannot be a literal wrap of the current loop.** The loop `await`s
  `parseEml` per message, and this stack's transactions are synchronous — bun:sqlite via
  Drizzle; every `.transaction()` call in the repo uses a sync callback, and holding
  BEGIN across an `await` on a shared connection is not safe. Restructure into
  parse-then-insert chunks: async-parse a chunk (~250–500 files) into an array, then one
  synchronous `db.transaction(() => { insert each })` per chunk. Chunking also bounds
  memory on a 50k cold index and keeps SSE reasonably live.
- The insert path for sync can skip the existence check (diff map guarantees new): add a
  bulk insert-only method on `MailDB` alongside `addEmail`; keep `addEmail`'s
  check-then-update semantics for the draft path (`saveDraft`), its only other caller.
- The `received` SSE event also fires per message inside the loop — during a 1,000-mail
  sync that's 1,000 `MAIL_RECEIVED` events each triggering a full list invalidation on
  every connected client. Move the `events.received` calls after each chunk's commit and
  it's naturally throttled to one burst per chunk; if that's still noisy, emit one
  synthetic per-chunk event. (FE-side SSE has no debounce at all — verified.)
- Notification coalescing is a one-word change: the `received` callback in
  `mail-domain.ts` already persists with `tag: 'mail:new'` (upsert on tag) but doesn't
  pass `coalesce: true`; adding it suppresses the broadcast storm within the 30 s
  `COALESCE_WINDOW_MS` while still upserting the row.
- Out of scope but adjacent: `store.append()` (delivery, draft save) also awaits
  `syncMailbox`; leave it — delivery is not a user-facing request path bottleneck.

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

## Appendix — implementer's reference (for a clean-context session)

Everything below is verified against the code on 2026-07-09. Read AGENTS.md +
`docs/CODE-STANDARDS.md` first; skim `docs/TESTING.md` and `docs/VERIFICATION.md` before
the test/verify phases. Branch per step, no push without explicit go, `bun run check`
before declaring done.

### A. File map

| Area | File |
|---|---|
| FE hooks + key factory + invalidation helpers | `packages/lib/src/core/mail/hooks/use-emails.ts` |
| FE SSE handlers (incl. `normalizeMailbox`) | `packages/lib/src/core/mail/sse-handlers.ts` |
| FE list derivation (filter/sort/cursor/selection) | `apps/mail/src/components/mail/hooks/use-mail-list.ts` |
| FE batch actions (N mutations via `Promise.allSettled`) | `apps/mail/src/components/mail/hooks/use-mail-actions.ts` |
| FE keyboard shortcuts (j/k, `[`/`]`, `*` chords) | `apps/mail/src/components/mail/hooks/use-mail-shortcuts.ts` |
| FE list component (`useVirtualizer` from `@tanstack/react-virtual`) | `apps/mail/src/components/mail/email-list.tsx` |
| FE route (auto-advance, `displayEmails` overlay) | `apps/mail/src/routes/_auth.$filterType.$filterId.tsx` |
| FE mailbox sidebar counts | `packages/lib/src/core/mail/hooks/use-mailboxes.ts` |
| FE infinite-query template | `packages/lib/src/core/chat/hooks/use-chat.ts` (`useMessages`) |
| FE optimistic-update template | `packages/lib/src/core/drive/hooks/use-drive-view-preferences.ts` |
| FE search hook (FTS5-backed) | `packages/lib/src/core/search/hooks/use-search.ts` |
| BE routes | `apps/api/src/routes/mail.ts` |
| BE domain (canonicalMailbox, SSE emit, notifications) | `apps/api/src/lib/mail/mail-domain.ts` |
| BE store (sync, storeLock, mutations) | `apps/api/src/lib/mail/maildir-store.ts` |
| BE store interface (`MailStoreEvents`) | `apps/api/src/lib/mail/mail-store.ts` |
| BE DB layer (`addEmail`, `getAllEmails`, counts, `searchMail`) | `apps/api/src/lib/mail/maildb.ts` |
| BE schema + versioned migrations (currently v3) | `apps/api/src/lib/mail/schema.ts`, `apps/api/src/lib/mail/db-config.ts` |
| BE eml parser (DOMPurify, `textShort`) | `apps/api/src/lib/mail/mail-parse.ts` |
| Shared types (`EmailSummary`, `Email`, `MaildirMailbox`) | `packages/lib/src/types/mail.ts` |
| SSE event types | `packages/lib/src/types/sse.ts` |
| Tests | `apps/api/src/test/mail*.test.ts` (integration, helpers in `setup.ts`) |

### B. Load-bearing contracts (as of today)

Query-key factory (`use-emails.ts`) — note the lowercasing and the object param:

```ts
export const emailKeys = {
    all: ['emails'] as const,
    owner: (ownerId) => [...emailKeys.all, ownerId],
    lists: (ownerId) => [...emailKeys.owner(ownerId), 'list'],
    list: (ownerId, mailbox) => [...emailKeys.lists(ownerId), { mailbox: mailbox.toLowerCase() }],
    details: (ownerId) => [...emailKeys.owner(ownerId), 'detail'],
    detail: (ownerId, id) => [...emailKeys.details(ownerId), id],
};
```

`useEmails` today: plain `useQuery`, queryFn
`mailApi({ ownerId }).mailbox({ mailboxPath: mailboxPath.toLowerCase() }).get()` →
`EmailSummary[]`, `staleTime: 60_000`. Mutations take the full `Email` object
(`Email = ParsedMail & EmailSummary`) and return it unchanged from `mutationFn`;
`onSuccess` calls the `invalidate*` helpers. TanStack Query is **v5** (`^5.90.21` in root
`package.json`) — `maxPages`, `setQueriesData`, `InfiniteData` all available.

SSE payload (all 7 mail events share it): `{ messageId: string; mailbox: string;
toMailbox?: string }` — `toMailbox` only on `mail:moved`. No flag values, no summary row.
FE dispatch is raw `EventSource` → handler, no debounce anywhere.

`EmailSummary` fields (also the exact `emails` table shape — the DB row IS the DTO, no
mapping at read time): `id, filename, subject, fromShort, fromAddress, toShort, toAddress,
recipientsAll, textShort, date (Date), isRead, isFlagged, isDraft, isReplied,
hasAttachments, mailbox, size`.

`MailStoreEvents` (BE, `mail-store.ts`): `received(email, isNewMessage)`,
`flagsChanged(messageId, mailbox)`, `deleted(messageId, mailbox)` — implemented in
`Mail.init` (`mail-domain.ts`), which emits the SSE events and persists notifications.

### C. Mailbox naming — the #1 subtle-bug source

Three representations coexist; never compare mailbox strings without knowing which layer
you're in:

| Layer | Inbox is | Others |
|---|---|---|
| BE canonical (`canonicalMailbox`, DB `mailbox` column, SSE payloads) | `''` (empty string) | `STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']` (canonical case) |
| FE query keys | `'inbox'` (lowercased) | lowercased (`'sent'`, …) |
| FE SSE handler | `normalizeMailbox: '' → 'inbox'`, then lowercased via `emailKeys.list` | same |
| URL segment | `/box/inbox` | lowercase |

The route lowercases `mailboxPath` and `canonicalMailbox` re-canonicalizes it, so the BE
accepts any case. The mutation `onSuccess` path is the one place with NO normalization
today (the Step-1 bug). Step 1's `setQueriesData`-by-id sidesteps all of this; any code
that still needs key equality must normalize `'' → 'inbox'` first.

### D. Chosen defaults (implementers: use these unless re-decided)

- Step 2 page size: **default 200, max 500**, enforced in the route's `t.Object` query
  schema (`t.Optional(t.Number({ minimum: 1, maximum: 500 }))` — repo precedent in
  `routes/search.ts`).
- Step 2 `textShort` cap in list responses: **200 chars** (matches the draft-path
  precedent in `MailDB.updateDraftContent`).
- Step 2 new migration: **v4** in `MAIL_DB_CONFIG` (`db-config.ts`), bump
  `currentVersion`, follow the v3 up-function pattern:
  `CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox, date DESC, id DESC);`
- Step 3 parse/insert chunk size: **250**.
- Step 3 first-open blocking sync: block only when `db.getEmailsCount(mailbox) === 0`.
- Step 1 SSE echo: **ship option (a)** (leave the echo alone); option (b)'s registry is a
  follow-up only if measurements demand it.

### E. Testing expectations per step

All BE tests are integration tests in `apps/api/src/test/` (see `TESTING.md`; helpers
`getTestContext()`, `authedRequest()` in `setup.ts`; existing mail coverage in
`mail.test.ts`, `mail-arrival-dedup.test.ts`, etc.). Seed messages through the mail
domain/store APIs (drafts, deliver) as existing mail tests do — don't hand-write maildir
files. TDD: red first. Scoped runs: `bun test apps/api/src/test/mail.test.ts`; full gate:
`bun run check` (main agent only).

- **Step 1 (FE-only)**: there is no FE unit-test infra — the regression net is
  behavioral. Verify per `VERIFICATION.md` (headless browser, throwaway user): archive a
  mail with DevTools network open → the list request must NOT refire from the mutation
  path (one SSE-echo background refetch is accepted); unread dot flips instantly in the
  Inbox (regression for the `''` bug); error path: kill the API mid-mutation → row
  restores (rollback).
- **Step 2 (BE)**: route tests — page 1 returns newest-first; walking `before` cursors
  yields no duplicates/gaps across a seeded mailbox with duplicate `date` values
  (explicitly seed ≥3 mails with the same timestamp to pin the `(date, id)` tiebreak);
  `limit` respected + capped; no params → documented default behavior; `textShort`
  capped at 200 in the response while FTS5 body search still matches beyond 200 chars.
- **Step 2 (FE)**: behavioral — scroll loads pages; j/k at the window edge fetches more;
  archive of a mid-page row doesn't corrupt page boundaries (patch helper on
  `InfiniteData`); search box results come from the search endpoint, not local filter.
- **Step 3 (BE)**: list request returns while a slow sync is running (seed N new files,
  assert `listMessages` latency ≪ sync duration and that rows arrive via subsequent SSE
  events); cold-index correctness — seed a mailbox with K files on disk, first
  `listMessages` (blocking, empty-DB path) indexes exactly K rows (transaction batching
  must not change counts, flags, or FTS matches); one bad `.eml` in a chunk doesn't abort
  the chunk's other inserts (mirror of the existing per-message try/catch semantics —
  parse failures skip; a mid-transaction insert failure may roll back its chunk, then
  the next sync retries since the diff map still sees the files as new); notification
  coalescing — burst of new mail within 30 s upserts the `mail:new` row but broadcasts
  once.

### F. Measurement / verification harness

- Bench scripts live in-repo: `INBOX=50000 ARCHIVE=50000 bun apps/api/scripts/mail-bench.ts`
  (end-to-end store benchmark) and `N=10000 bun apps/api/scripts/mail-profile.ts` (cold-sync
  phase attribution). They build an isolated maildir + fresh `mail.db` in the OS tempdir at
  50k/100k scale and produced the table above. Re-run after Step 3 to confirm the cold-sync
  and warm-sync deltas.
- Browser verification per `docs/VERIFICATION.md` (test-user conventions, auth cookie
  injection, seeded mailboxes). The end-to-end numbers above used a throwaway user with
  20k mails; comparable seeding is required to reproduce the refetch-amplification
  measurements (DevTools network tab, filter on `/mailbox/`).
- Acceptance targets: Step 1 — archive causes ≤1 list refetch (the SSE echo) and 0 on the
  mutation path; Step 3 — warm `listMessages` route time ~independent of pending-sync
  size, 50k cold index well under half of the 92 s baseline; Step 2 — first paint of a
  50k mailbox transfers ~100–300 KB, not tens of MB.

### G. Known adjacent work (do NOT fold into these steps)

- Batch endpoints for multi-select actions (N mutations is fine post-Step-1).
- Cross-client SSE origin exclusion in `home.broadcast`.
- Worker offload for `parseEml` (Step 4, only after re-measuring post-Step-3).
- `store.append()` awaiting sync on the delivery path.
- The per-request `parseEml` (incl. DOMPurify) on message detail reads — bodies are not
  stored in the DB; acceptable today, separate proposal if it ever shows up in profiles.
