# Roadmap

Prioritised backlog of open work. Each item was checked against the codebase on **2026-06-25**;
done items are pruned on completion (last prune 2026-07-03 — git history keeps them). Status is
what exists today, not what the proposal hoped for. The detailed designs live in the
`docs/PROPOSAL_*.md` files referenced per row.

The organising theme is **the road to a trustworthy 1.0**: Eigen runs in production but is honest
about being pre-1.0, so the data-integrity work comes first. A grant application (NGI Zero,
deadline 2026-08-01) funds that push; the funding and launch tactics themselves are tracked
separately in `docs/superpowers/strategy/` (local-only) and are not duplicated here.

**Legend** — Effort: S / M / L / XL (rough T-shirt size). Frozen-format: Eigen is live, so any
change to a persisted format (Yjs roots, DB schema, drive MIME values) needs a migration and a
deliberate decision — flagged per row.

---

## P0 — Data-trust foundation for 1.0

The product's stated core weakness ("I would not yet trust it with data you cannot afford to
lose") and the work the grant funds. Highest strategic value.

| Item | Status in code | Effort | Frozen-format | Notes |
|---|---|---|---|---|
| **CRDT format migration** | Primitive **already exists** — `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`) does single-transaction live-state replacement, with snapshot-before-restore in `apps/api/src/lib/versioning/`. The system on top is net-new. | L+ | **Yes** — touches the document container format; design migration + snapshot rollback up front | Flagship. Net-new: version stamps per container, a per-type migration registry, lazy-migrate-on-open + dormant-doc sweep, and a sync handshake so stale clients can't write old-format data. **No `PROPOSAL_*.md` yet — write one.** |
| **Data integrity + verified backups** | Not started | M | No (new tests/checks) | Semantic restore tests (CRDT bytes aren't comparable), integrity checks at every write path, scheduled corruption detection with alerts. |
| **E2E multi-user collab test suite** | Not started | M | No | Playwright, multiple concurrent clients, CI. Must be reliable from the start — flaky suites get abandoned. |

## P1 — High value-per-effort, start next

| Item | Status in code | Effort | Frozen-format | Notes |
|---|---|---|---|---|
| **S3 Versioning UX** ([proposal](PROPOSAL_S3_VERSIONING_UX.md)) | Detection done (`checkS3Versioning` in `s3-storage.ts`); the one-click fix is 0%. | S–M | No (mutates the external bucket, re-reads it) | **Best value-per-effort.** The SigV4 signing already ships — add two PUTs (`PutBucketVersioning` + lifecycle), a `/settings/s3/harden` route, and an "Enable safe defaults" button. Closes the data-loss incident class. |
| **Calendar import + subscriptions** ([proposal](PROPOSAL_CALENDAR_IMPORT.md)) | 0%, on a complete `parseIcs` + event-pipeline foundation. | M | Yes, **low** — additive nullable `subscription` column on `calendars` | Best *new* feature: `.ics` import + read-only feed subscriptions. Workspace parity. Open decision: SSRF on server-side feed fetch (see prior MinIO-on-LAN incident). |
| **SSO / enterprise login** ([proposal](PROPOSAL_SSO.md)) | 0%. Auth foundation ready — `user.create` hook auto-provisions org; app-password protocol-auth already works for passwordless users. | M | Yes — additive `@better-auth/sso` provider tables in `users3.db` (auth-schema migration) | OIDC + SAML via better-auth's `sso` plugin, providers registered at runtime → admin page + optional setup-wizard step. **Demand-gated:** pull forward when a concrete org needs it. Key work: Home/maildir provisioning for SSO users (they bypass the waitlist); SSO users use app passwords for IMAP/CalDAV/WebDAV. |
| **Create/open resilience under degraded storage** | Not started — surfaced live in the 2026-07-03 nbg1 slowdown. Slow-but-successful `create` → client/proxy timeout → 500 shown → doc appears only on refresh → user re-clicks → **duplicate docs**. Read-only scan of the affected home confirmed **no data lost** (0 orphaned containers). | S–M | No | Frontend: loading state on create + reconcile against the drive listing / `DRIVE_FILE_CREATED` SSE on timeout, so the doc appears once and retries cannot dupe. Backend: make `Drive.create` (`drive.ts:257`) atomic. Full detail in the dated section at the end. |

## P2 — Finish what's already started

| Item | Status in code | Effort | Frozen-format | Notes |
|---|---|---|---|---|
| **Search: calendar events** ([proposal](PROPOSAL_SEARCH.md)) | Mail + drive search (names and body content) shipped; calendar is the last unsearchable domain. | S | Yes, low — additive FTS table, following the inline-FTS pattern mail.db uses | Last phase of the search proposal. |
| **File History: email digests + in-doc panel** ([proposal](PROPOSAL_FILE_HISTORY.md)) | Phase 1 live (~65%): `FileHistory`, Recent Activity, Watch, Watched view. | M | Yes — email channel needs `notifications.db` v2 migration | Remaining: email/digest channel, in-doc history panel unified with version history, `history:changed` live SSE, and the deferred slide semantic events (S). |
| **Copy-Paste Phase 0** ([proposal](PROPOSAL_COPY_PASTE.md)) | v1 clipboard live; the async path (`writeEigenClipboardAsync`) omits the custom MIME. | S | No (clipboard is transient) | Tiny fix to make Slides button-copy lossless. Full ECP v2 protocol is P3. |
| **Help Center rework finish** | Partial — AppShell swap + sections landed; spec's `SupportSidebar` / search-removal didn't fully land. | S | No | The one genuinely-incomplete superpowers plan (`docs/superpowers/plans/2026-05-20-help-center-rework.md`). Article-content campaign runs separately per [SUPPORT-CONTENT-PLAN.md](SUPPORT-CONTENT-PLAN.md). |

## P3 — Defer

Large net-new builds or low value-per-effort today.

| Item | Status | Effort | Why defer |
|---|---|---|---|
| **Home Recents** ([proposal](PROPOSAL_HOME_RECENTS.md)) | 0% | M | Polish for autosuggest/palette; nothing is blocked on it. Depends on File-History actor threading; new `recents.db` migration. |
| **Copy-Paste ECP v2** ([proposal](PROPOSAL_COPY_PASTE.md)) | 0% | L | Cross-app converters + BroadcastChannel bus + cut coordination. Current text/image cases already work. |
| **Graphs / charts** ([proposal](PROPOSAL_GRAPHS.md)) | 0% | XL | Table-stakes eventually, but net-new across sheets/docs/slides with new frozen Yjs formats. Remove the dead fortune-sheet chart scaffolding first. |
| **Scripting platform** ([proposal](PROPOSAL_SCRIPTING_PLATFORM.md)) | 0% | L | Foundations exist (document layer, ACLs, SSE, CodeMirror), but "Deno isn't a true sandbox" caveat. Post-1.0. |
| **Vector drawing app** ([proposal](PROPOSAL_VECTOR.md)) | 0% | XL | Pure net-new build, paved by slides. Post-1.0. |
| **AI integration** ([proposal](PROPOSAL_AI.md)) | 0% | XL | Needs a GPU sidecar the host lacks; its flagship semantic search is superseded by the FTS5 plan. Keep as grant narrative, not a build. |
| **Stalwart mail backend** ([proposal](PROPOSAL_STALWART_MAIL.md)) | 0% | XL | The proposal's own decision section says **don't build it** until a user asks for JMAP. The `MailStore` seam it would plug into exists since 2026-07-03. |
| **Async `MailStore.search`/`size`** | Interface landed 2026-07-03 with sync signatures | S | Only needed once a second (remote) mail backend exists — widen the types together with that backend. |

## Cheap wins (broken-window fixes)

| Item | Effort | Notes |
|---|---|---|
| rspamd sidecar | ~1 day | The real fix for the spam/DMARC pain that the Stalwart proposal exists to solve. |
| Comment/card author name consistency | S | Card/comment UI shows the username (e.g. "hioberman") in some places and the display name (e.g. "Hanne") in others — one person reads as two. Render display-name consistently, fall back to username. See the 2026-07-03 detail section (§4). |

## On hold (decision needed)

- **Demo mode** — spec approved (`docs/superpowers/specs/2026-06-10-demo-mode-design.md`),
  implementation on hold. ~1.5–2 weeks. It is both the public launch's headline asset and the
  grant's "public demo instance" deliverable, so it moves up sharply once a launch or the grant
  push is the active goal. Start on explicit go.

---

## Create/open resilience under degraded storage — 2026-07-03 incident follow-up

**Context.** 2026-07-03 (~15:10–15:35 UTC) Hetzner **nbg1 Object Storage** degraded (slow→503,
`Service is unable to handle request` / `S3Error UnknownError`) — a provider incident that recovered
on its own. Two new testers hit it live: `Internal server error (500)` creating docs; a new doc that
appeared only after a page refresh (→ duplicate docs from re-clicking); a sticky card that only posted
on the 4th attempt; existing docs taking ~a minute to open. The `S3Storage.exists()` throw
(`s3-storage.ts:134`, no try/catch) propagating out of the create/open paths is the common trigger;
uploads themselves were safe (durable retry queue, `mount/upload-queue.ts`).

**Ruled out — no data lost, no cleanup needed.** A read-only scan of the affected tester's home
(`$EIGEN_DATA_ROOT/home/<uid>/mounts/*/metadata.db`, flagging `type IN ('doc','stickies','slides','sheets','chat')`
rows with no non-trashed `data.db` child) returned **0 orphans**; both her docs are structurally
intact. The 500s were *slow-but-successful* creates the client/proxy timed out on — not orphaning. So
this workstream is UX/resilience + latent hardening, not recovery.

### 1 — Frontend create UX (the real complaint). P1, effort S–M, no frozen-format.
`POST /drive/:owner/:mount/folder/:pathId/create/:type` (`apps/api/src/routes/drive.ts:91` →
`Drive.create`, `apps/api/src/lib/drive/drive.ts:257`) can be slow under S3 degradation; the
client/proxy times out and shows a 500 even though the server committed the doc and emitted
`DRIVE_FILE_CREATED` (`drive.ts:280`). No loading state, the doc is not shown until manual refresh, the
user re-clicks → duplicates. (Tester: "the doc was still created, but only appeared after refreshing…
I accidentally created two docs.")
- Show a pending/loading state on "new doc/board" until the create resolves.
- On timeout/error, reconcile against the drive listing (refetch, or trust the `DRIVE_FILE_CREATED`
  SSE) before declaring failure, so the doc appears and the user does not retry.
- Guard duplicate creates: disable the action while in-flight; consider an idempotency key so one user
  intent = one doc even if the request is retried.
- Entry points to read first: the client "new doc" mutation and how the drive list consumes
  `SSEventType.DRIVE_FILE_CREATED`.
- **Done when:** under throttled/failing storage, "new doc" shows a pending state and the doc appears
  exactly once even if the request is slow or errors.

### 2 — Backend: make `Drive.create` atomic. P1, effort S, no frozen-format. (Hardening — did NOT bite on 2026-07-03.)
`Drive.create` (`drive.ts:257`) commits the container folder at `createFolder` (line 269) **before**
provisioning (`ChatRoom.create` / `CollabDocument.create`, lines 271/276). If provisioning *hard*-fails
(S3 `exists()` throws, `apps/api/src/lib/storage/s3-storage.ts:134`, during a full outage) the folder
is **not** rolled back → an orphaned container with no `data.db` (later opens 503 via the `mustExist`
guard, `apps/api/src/lib/core/managed-database.ts:72`). `provisionManagedDbs` (`drive.ts:1005`) already
rolls back its *inner* rows; only the outer `createFolder` is unguarded. This is why the frontend fix
(§1) alone is not enough for a *full* outage — but note it did not orphan anything on 2026-07-03
(S3 was slow, not down, at create-moments; scan = 0).
- Wrap provisioning in try/catch; on failure `mount.deletePath(pathId)` the container before
  rethrowing (mirror the `provisionManagedDbs` rollback at `drive.ts:1019`).
- **Done when:** with provisioning forced to throw, `Drive.create` leaves no `paths` row behind and a
  retry starts clean.

### 3 — Dangling card-chats (optional tidiness). Low priority.
Adding a sticky card awaits an HTTP `create/chat` and writes the card to the board Yjs only after it
resolves (`packages/lib/src/core/comments/hooks/use-create-comment-card.ts:58` and `:70`). A
`create/chat` that succeeded-but-slow (client timed out) leaves a valid chat container (it *has* a
`data.db`, so the orphan scan cannot see it) that no card references. Cosmetic litter, no breakage. To
clean: cross-reference each board's Yjs `tasks`/`comments` card `chatName`s against the chat folders in
the board's `chat/` subfolder; trash the unreferenced ones via the app delete path.

### 4 — Comment/card author name consistency (cheap win). Effort S, no frozen-format.
The card/comment UI shows the username (e.g. "hioberman") in some places and the display name (e.g.
"Hanne") in others, so one person reads as two. Render the display name consistently (fall back to
username when absent). Unify where the stickies card author and the comment-thread reply author are
rendered.
