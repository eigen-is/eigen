# Roadmap

Prioritised backlog of open work. Each item was checked against the codebase on **2026-06-25**;
the P0/P1 proposals were deep-reviewed and re-verified against code on **2026-07-06**. Done items
are pruned on completion (last prune 2026-07-16 — git history keeps them). Status is
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
| **CRDT format migration** ([proposal](PROPOSAL_CRDT_MIGRATION.md)) | Primitive **already exists** — `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`) does single-transaction live-state replacement, with snapshot-before-restore in `apps/api/src/lib/versioning/`. The system on top is net-new. Proposal written + reviewed 2026-07-05. | L+ | **Yes** — touches the document container format; design migration + snapshot rollback up front | Flagship. Net-new: version stamps per container (`doc_format` row in the container's `data.db`), a per-type migration registry, lazy-migrate-on-open + dormant-doc sweep, and a `?fmt=` sync handshake so stale clients can't write old-format data. |
| **Data integrity + verified backups** ([proposal](PROPOSAL_DATA_INTEGRITY.md)) | Not started. Proposal written + reviewed 2026-07-05. | M | Yes, low — additive `paths.integrityCheckedAt` column (sweep cursor) | Cost-tiered checks at every write seam, scheduled corruption sweep (incl. the permanent orphaned-container scan), semantic backup verification (`verifySnapshotDb`), and a made-safe `scripts/backup.sh` (today it tars live WAL DBs — torn captures). |
| **E2E multi-user collab test suite** ([proposal](PROPOSAL_E2E_COLLAB_TESTING.md)) | Not started. Proposal written + reviewed 2026-07-05. | M | No | Playwright, multiple concurrent clients, CI. Must be reliable from the start — flaky suites get abandoned. Phase 1: four docs/Tiptap tests on one shared convergence primitive; retries=0. |

## P1 — High value-per-effort, start next

| Item | Status in code | Effort | Frozen-format | Notes |
|---|---|---|---|---|
| **S3 Versioning UX** ([proposal](PROPOSAL_S3_VERSIONING_UX.md)) | Detection done (`checkS3Versioning` in `s3-storage.ts`); the one-click fix is 0%. | S–M | No (mutates the external bucket, re-reads it) | **Best value-per-effort.** The SigV4 signing already ships — add two PUTs (`PutBucketVersioning` + lifecycle), a `/settings/s3/harden` route, and an "Enable safe defaults" button. Closes the data-loss incident class. |
| **Calendar import + subscriptions** ([proposal](PROPOSAL_CALENDAR_IMPORT.md)) | 0%, on a complete `parseIcs` foundation. Proposal rewritten 2026-07-06: feed refresh must NOT reuse the public event mutations (they propagate cancellations to attendees) — one bulk `applyFeedSnapshot` transaction with `(uid, recurrenceDate)` identity; refresh on access (web range GET + CalDAV reads), no timers. | M | Yes, **low** — additive nullable `subscription` column on `calendars` | Best *new* feature: `.ics` import + read-only feed subscriptions. Workspace parity. SSRF decided: private feed URLs allowed by default (`calendar.allowPrivateFeedUrls`, MinIO-on-LAN precedent) behind always-on guards (scheme, userinfo, link-local/metadata block, per-redirect revalidation, size cap); hosted multi-tenant sets it false. |
| **SSO / enterprise login** ([proposal](PROPOSAL_SSO.md)) | 0%. Foundation stronger than assumed — the `user.create.after` hook auto-provisions org + reconciles shares, and Home/maildir/quota bootstrap is already lazy + idempotent on first `getHome()` (no waitlist coupling — no provisioning work needed); app-password protocol-auth already works for passwordless users. `@better-auth/sso` not yet installed. Proposal rewritten 2026-07-06: v1 OIDC-only, SAML deferred. | M | Yes — additive `@better-auth/sso` provider tables in `users3.db` (auth-schema migration) | OIDC via better-auth's `sso` plugin (SAML + setup-wizard step deferred to phase 2), providers registered at runtime → admin page. **Demand-gated:** pull forward when a concrete org needs it. Key work: disable the plugin's own org-provisioning (double-`addMember` hazard against the existing hook), gate its built-in `/sso/register` endpoint, account-linking policy; SSO users use app passwords for IMAP/CalDAV/WebDAV. |
| **Create/open resilience under degraded storage** ([proposal](PROPOSAL_CREATE_RESILIENCE.md)) | Not started — surfaced live in the 2026-07-03 nbg1 slowdown: slow creates → 500 shown → doc appears only on refresh → user re-clicks → **duplicate docs**. Read-only scan confirmed **no data lost** (0 orphaned containers). Proposal written + reviewed 2026-07-05; it corrects the incident mechanics (the 500s were real API responses from the `S3Storage.exists` throw — no client/proxy timeout exists). | S–M | No | Frontend: pending state on create + reconcile against the listing / `DRIVE_FILE_CREATED` SSE before declaring failure (reconcile-only; no idempotency key). Backend: make `Drive.create` atomic (roll back the container folder on provisioning failure). Plus open-path honesty + optional dangling card-chat cleanup. |
| **Durable home-relay outbox (queue for cross-home delivery)** ([proposal](PROPOSAL_HOME_RELAY_OUTBOX.md)) | ACL fan-out is async since 2026-07-04 (bounded-concurrent, per-path FIFO, drain-on-shutdown — `acl-propagation.ts`) and the ACL route takes deltas merged server-side. Remaining: the durable outbox itself. Proposal written + reviewed 2026-07-05 (server-level `outbox.db`, per-lane FIFO + coalescing with conditional ack, global K=8 delivery budget). | M | Yes, low — new server-level `outbox.db` (additive) | Persisted delivery rows + per-recipient FIFO + retry/backoff + replay-on-boot, following the existing `UploadQueue`/`ContentReindexQueue` pattern (third instance of "durable rows + self-scheduled drain"). Closes the crash-loses-in-flight-deliveries window and replaces silent per-recipient skips with retry. Also the stated sharding trajectory — in a multi-server deployment the outbox *is* the message transport (see SCALABILITY.md). **Build it in the relay, not per seam** — the 2026-07-04 seam audit found the same sync-fan-out pattern in: (1) `propagateCalendarShare` (`calendar/share-propagation.ts`, awaited on the share PUT — direct sibling of the fixed ACL bug, N sequential cold home opens); (2) chat/comment notifications (`chat.ts` mention + activity loops, awaited inside `postMessage` — cold opens for every previous participant add latency to every message send; coalesce-by-tag makes ordering a non-issue); (3) `FileHistory.notifyWatchers` (`drive/history.ts`, concurrent but **unbounded** `Promise.all` awaited on every drive mutation — the fd-burst class); (4) signup reconciliation (`share/reconciliation.ts`, sequential in the `user.create` hook — rare, note only). Calendar invitations (`invite-propagation.ts`) are already fire-and-forget but sequential and carry a real create-vs-update ordering hazard (`sequence` can apply out of order) — they need the outbox's per-target FIFO, not just parallelism. One global concurrency budget in the relay/outbox subsumes all per-seam semaphores and closes the fd-burst class everywhere at once. |
| **File-descriptor budget: graceful exhaustion** ([proposal](PROPOSAL_FD_BUDGET.md)) | Compose pins `ulimits: nofile` since 2026-07-04. Discovered during the slow-share investigation: a 26-home fan-out **crashed with `SQLITE_IOERR_VNODE` under macOS's default `ulimit -n 256`**, silently skipping recipients. Measured warm ceiling ≈ 30 fds per open Home (6 eager WAL databases × 3 files + 12 maildir `fs.watch` handles; more per extra mount / open doc container). Proposal written + reviewed 2026-07-05. | S | No | Phase 1: document the `LimitNOFILE` requirement for bare-metal deploys + startup check — read the soft limit via `process.report` userLimits, log a loud warning below a derived threshold. Phase 2 (optional, gated on need): LRU cap on resident Homes via the existing `homeFactories`/`touch()` seam (eviction predicate incl. open collab connections) + `ManagedDatabase.open` retry-once-after-eviction. |
| **iMIP occurrence-notification product call** | The audit deep-dive remainders shipped 2026-07-13 (upload-queue orphaned-PUT repair; CalDAV #C–#G; outbound occurrence-REPLY scoping); the deep-dive docs are removed — see git history. What's left here is a decision, not code. | XS | No | Occurrence-level inbound iMIP changes broadcast SSE but persist no tray notification, while master-level changes do — awaiting Reinder's call on whether instance-level changes deserve a persisted notification. |

## P2 — Finish what's already started

| Item | Status in code | Effort | Frozen-format | Notes |
|---|---|---|---|---|
| **Search: calendar events** ([proposal](PROPOSAL_SEARCH.md)) | Mail + drive search (names and body content) shipped; calendar is the last unsearchable domain. | S | Yes, low — additive FTS table, following the inline-FTS pattern mail.db uses | Last phase of the search proposal. |
| **File History: email digests + in-doc panel** ([proposal](PROPOSAL_FILE_HISTORY.md)) | Phase 1 live (~65%): `FileHistory`, Recent Activity, Watch, Watched view. | M | Yes — email channel needs `notifications.db` v2 migration | Remaining: email/digest channel, in-doc history panel unified with version history, `history:changed` live SSE, and the deferred slide semantic events (S). |
| **Copy-Paste Phase 0** ([proposal](PROPOSAL_COPY_PASTE.md)) | v1 clipboard live; the async path (`writeEigenClipboardAsync`) omits the custom MIME. | S | No (clipboard is transient) | Tiny fix to make Slides button-copy lossless. Full ECP v2 protocol is P3. |
| **Help Center rework finish** | Partial — AppShell swap + sections landed; spec's `SupportSidebar` / search-removal didn't fully land (Pagefind was deliberately kept). Plan doc pruned in the 2026-07-11 superpowers cleanup. | S | No | Article-content campaign runs separately per [SUPPORT-CONTENT-PLAN.md](SUPPORT-CONTENT-PLAN.md). |
| **Frontend unit-test harness** | Nothing exists — `bun run test` is the API integration suite only. The FE's hooks and state machines (`useLongPress`, the drill-in menu, `useDocumentPanels`) are covered by browser rounds and review, not by tests. Raised as P2 by an external reviewer of the mobile pass; roadmapped 2026-08-03. | S–M | No | `bun test` + happy-dom + `@testing-library/react`, scoped to `packages/ui` hooks and state machines first. Pin behaviour (timer thresholds, page stacks, one-panel-at-a-time), not rendering details. |
| **Team-removal collab read-revocation** | Not started — the top recorded follow-up of the 2026-07-03 audit-fix branch (ledger: `docs/superpowers/audit-fixes/progress.md`, local-only). The branch made read-revocation coherent for `updateACL` + `movePath`; removing a member from a *team* still doesn't revoke their live collab read access on docs in other homes. | S–M | No | Cross-home, so it needs the relay — bundle with the P1 durable home-relay outbox rather than building a bespoke fan-out. |

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
| Chat/comment `authorId` → email-only (verify) | S | Frozen-format (per-container `data.db` migration if pursued). Chat `messages` rows store both `authorId` (user id, NOT NULL) and `authorEmail`; display resolves from **email** (`chat-message-list.tsx:453-455`), and `authorId` is used only for the self-message check (`:223`). Comments are already email-keyed. **Verify** whether `authorId` can be dropped in favour of `authorEmail` (self-check compares current-user email instead) — it is the last user-id embedded in container bytes, and dropping it makes chat/comment fixtures fully id-free. Surfaced by the 2026-07-14 demo-mode ID audit. |
| rspamd sidecar + spam learn-loop ([proposal](PROPOSAL_RSPAMD.md)) | 1–2 d | The real fix for the spam/DMARC pain that the Stalwart proposal exists to solve. rspamd+Redis as a Postfix milter (edge scoring, SPF/DKIM/DMARC); `mailboxDeliver` routes flagged mail to Junk; the existing "Report Spam" button trains Bayes via `/learnspam`·`/learnham` in `messageMove`. Fail-open, no frozen-format impact. |
| Audit-branch deferred minors (2026-07-03 ledger) | S | Recorded, not fixed, all verified still present 2026-07-11: (1) `TeamHome.updateMount` persists-before-push — a mid-push `addMount` init failure on a storage re-point leaves settings enabled with no live mount until eviction (rare, self-heals on reload; add catch-and-revert). (2) HTML (non-PDF) export keeps remote `url()` in inline CSS — client-side beacon; needs a CSS `url()` stripper. (3) O(N·depth) descendant re-walk on permanent delete of large trees (s3/local-key perf). (4) Large-numeric `@page` values in PDF export — weasyprint cost blow-up. |
| Audit P3 duplication folding | S–M | Still open from the audit P3 list (verified 2026-07-11): the `use-drive.ts` copy-mutation quartet (4 near-identical call-sites), drive's 4 list handlers, and the per-app `_auth.tsx` variants (10+ copies). Mechanical, subagent-friendly sweep. |
| Docs print takes the page transform with it | S | Pre-existing, and reachable more often since phase 5 of the mobile pass: below ~1000px with a panel open the docs page is shifted and scaled, and print puts that transform on paper. Reset the transform in the print path. |
| Command palette console noise | XS | Radix `DialogTitle` a11y warning plus a `pagefind.js` 404 in the dev console. Pre-existing, in code no recent branch touched. Surfaced by the 2026-08-03 mobile round. |
| Sheets: formula bar stale after undo | S | Undo while the same cell stays selected leaves the old formula in the bar. Display lag only, the cell itself is correct. |
| Sheets: `key={snapshotVersion}` remounts the whole Workbook | S–M | Every remote snapshot throws away the mounted grid and rebuilds it. Waste class, not a bug today; revisit together with sheets collab work. |
| Bun-native micro-touches (last open bits of the removed apps/api audit) | S | `createHash('md5')` → `Bun.CryptoHasher` at `calendar/mappers.ts` + the `s3-storage.ts` SigV4 probe; `Bun.spawn({ timeout, killSignal })` over the hand-rolled `setTimeout → kill` in `preview/weasyprint.ts` + `preview/video-thumbnail.ts` (native reaping, matching the exiftool timeout fix). Marginal — do on next touch of those files. |

## Focused audits (future-proofing reviews)

Deep single-subsystem reviews in the style of AUDIT_STORAGE.md (2026-07-05:
storage/mount/drive — base judged solid; its 11 fixes shipped 2026-07-06; doc removed
after everything shipped, see git history). The 2026-07-01
god-file audits (mount, drive, mail, calendar) are closed and pruned. Sequencing principle:
**audit a layer right before a proposal builds on it** — findings are cheapest to fix then, and
the auditor's context transfers straight into the implementation.

| Area | Scope | Trigger / when | Effort |
|---|---|---|---|
| **Collab + chat containers** | `lib/collab/` — CollabDocument lifecycle, DbProvider update/snapshot persistence (SNAPSHOT_INTERVAL consolidation), `blob-codec` zstd seam, `enforceReadAccess`; chat's registry-less db lifecycle (AUDIT_STORAGE item 4 is its boundary) | **First act of the CRDT format migration (P0)** — audit the current lifecycle before rewriting its persisted format; the historical data-loss incidents surfaced in this layer | M |
| **Home lifecycle + relay** | `lib/home/` idle-destruct/touch races, async-singleton patterns, eviction predicates; `home-relay.ts` as the sharding seam | Before the relay outbox + fd-budget Phase 2 land (both modify it); prerequisite for any multi-server work | M |
| **Auth + guests + share registry** | better-auth wrapper, `verifyProtocolAuth` (one bug = IMAP + CalDAV + WebDAV), guest lifecycle/cleanup, `addRegistryEntry` | Before SSO adds a second identity path | M |
| **Ops path** | `backup.sh`, `update.sh`, `docker/`, first-run setup — restore drills and upgrade rehearsals, not just code reading | With DATA_INTEGRITY Phase 5 (backup.sh); the VITE-env-var update breakage shows this class recurs | S–M |
| **SSE ↔ query-key invalidation contract** | Every `sse-events.ts` emitter vs `sse-handlers.ts` + `*Keys` in `packages/lib`: does every mutation emit, does every event invalidate the right owner-scoped keys | Any time — mechanical, subagent-friendly sweep; kills the "randomly stale UI" bug class | S |
| **WebDAV/CalDAV protocol conformance** | RFC edges (locks, If-Match, MOVE overwrite) against real clients (Finder, DAVx5, Thunderbird) | Low urgency — the drive side was verified clean 2026-07-05; run as a verification exercise when protocol bugs surface | S–M |

Not worth re-auditing now: mount/drive/storage (just done), mail + calendar (2026-07-01, findings
closed), the sheets engine (dev-frozen format, own fidelity program), versioning (covered 2026-07-05).

**Kick-off prompt** (swap the scope line; this shape produced AUDIT_STORAGE.md):

> Read AGENTS.md and docs/CODE-STANDARDS.md. We are 1+ year and 4000+ commits into Eigen; I want
> the base to stay solid — clean, easy to read, robust, simple, performant, no over-engineering.
> Be as unopinionated as you can and do a deep dive into **\<AREA\>**. Do research: read everything
> in scope, follow paths, run the tests, and probe the real code (dev server + throwaway accounts
> allowed; `scripts/s3-local` has MinIO). Cross-check `docs/PROPOSAL_*.md` and past audits so you
> don't re-report known work. Signal over volume — "clean" is a valid verdict. Write findings and
> recommendations to `docs/AUDIT_<AREA>.md`.
