# Proposal: E2E multi-user collab test suite

> **Status — Proposal, written 2026-07-05, not started.** Design for the P0 roadmap row
> "E2E multi-user collab test suite" ([ROADMAP.md](ROADMAP.md)): *"Playwright, multiple concurrent
> clients, CI. Must be reliable from the start — flaky suites get abandoned."*
> **TLDR**: industrialize the ad-hoc browser-verification recipe in [VERIFICATION.md](VERIFICATION.md)
> into a committed Playwright suite that boots a throwaway Eigen instance, signs in two users as two
> isolated browser contexts in one test, and asserts real-time convergence through the DOM. One shared
> convergence primitive, API-level arrange steps, zero tolerated flakes, retries=0. Phase 1 is four
> scenarios on one doc type (docs/Tiptap), proving the harness before the matrix widens.

## Problem

Eigen's core promise is multi-user real-time collaboration on Yjs documents, and it is the one thing
no committed test exercises end-to-end. The API integration tests (`apps/api/src/test/`) drive
`app.handle()` in-process (serially: `bun test --preload ./src/test/preload.ts`) — no
real WebSocket, no browser, no second concurrent client. `collab.test.ts` covers storage operations and
read-revocation enforcement via in-process spy connections — its own header notes the HTTP→WS upgrade
never completes under `app.handle()` — never two real editors converging. The collab data-loss incidents (the
2026-05-30 chat wipe, the "doc went empty" forensics work) were all failures of exactly this seam:
client ↔ WS ↔ `CollabDocument` ↔ persistence, under concurrency, reconnects, and restores.

Browser verification exists but is disposable: [VERIFICATION.md](VERIFICATION.md) documents how an
agent drives the dev app headless (test users, cookie injection, upload/convert API), and it has
caught real bugs — but every run is hand-built in `/tmp`, single-user, and thrown away. Nothing
regresses-tests the multi-client behavior that is the product.

The roadmap's own warning is the design constraint: **flaky suites get abandoned**. A collab E2E
suite that sleeps and retries would be worse than none — it would burn trust and then be ignored.
Reliability is the first-class requirement, not a follow-up.

## Goals / Non-goals

**Goals**

- A committed, repeatable Playwright suite where one test drives **two signed-in users
  concurrently** and asserts convergence through what the user sees (the DOM), not through storage.
- **Deterministic by construction**: event/predicate waits only, one shared convergence primitive,
  fresh state per test, `retries: 0`, traces on failure. A flake is a bug: fix it or delete the test.
- Runs in the existing GitHub Actions CI on every PR within a hard time budget.
- Covers, over phases: concurrent-edit convergence, same-position conflicts, offline/reconnect,
  refresh-persistence, and version-restore convergence, across the four Yjs doc types plus chat.
- Reuses the conventions that already work: `setup.ts`'s seeding flow, VERIFICATION.md's cookie
  injection and fixture APIs, the existing test-user naming.

**Non-goals**

- **Degraded-storage / slow-S3 E2E.** That failure class (2026-07-03 nbg1 incident) is the subject
  of the concurrent create-resilience proposal (`PROPOSAL_CREATE_RESILIENCE.md`); this suite runs on
  local storage only and never depends on S3.
- Cross-browser matrix. Chromium only in v1; Firefox/WebKit add runtime and flake surface for little
  collab-specific signal.
- Visual regression / pixel comparison. VERIFICATION.md's screenshot-reading stays the tool for
  design verification; this suite asserts content, not pixels.
- Presence/awareness cursors, load testing, mail/calendar/contacts UI flows (their logic is covered
  by the API integration tests).
- Replacing `apps/api/src/test/` — API-level behavior stays tested at the API level. This suite only
  tests what *needs* a browser: real WS, real editors, real concurrency.

## Current state (grounded)

- **CI exists**: `.github/workflows/check.yml` runs on push/PR to `main` (`ubuntu-latest`,
  15-minute timeout): `bun install --frozen-lockfile`, lint, typecheck, `primitives:check`,
  `bun --filter '*' test`. No E2E job, no browser step.
- **Playwright is not a dependency anywhere.** No `playwright` in the root or any workspace
  `package.json`, no `playwright.config.*` in the repo. VERIFICATION.md's recipe installs it ad-hoc
  (`bun add playwright` in a `/tmp` work dir, `chromium.launch({ channel: 'chrome' })`).
- **Dev stack**: `bun run serve` = `bun --filter '*' dev` — every app's vite server plus the API.
  Ports in `vite.shared.config.ts` (`APP_PORTS`: index 3000 … sheets 3013); each app serves under
  its name as base path and builds to `dist/<app>`. The API listens on a **hardcoded port 8000**
  (`apps/api/src/index.ts`).
- **API host resolution**: `resolveApiHost()` in `packages/lib/src/core/api.ts` — `VITE_API_HOST`
  absolute in dev (`http://localhost:8000`), relative in prod (`/eigen`, spliced onto
  `window.location.origin`). In production Caddy serves `./dist` statically and proxies the API
  (`docker-compose.yml`). CORS/auth origins are the hardcoded `trustedOrigins` list in
  `apps/api/src/lib/auth/auth.ts` (localhost:3000…3013).
- **First-run state**: `server-config.ts` persists `setupCompleted`; `POST /setup/complete`
  (`routes/setup.ts`) completes the wizard. `EIGEN_DATA_ROOT` relocates all data.
  `apps/api/src/test/setup.ts` already does the full throwaway boot: fresh
  `data-test/test-<timestamp>` dir, `POST /setup/complete` with `storageType: 'local-id'`, then
  creates alice/bob/charlie via `auth.api.signUpEmail` and extracts `better-auth.session_token`.
- **Collab WS**: `.ws('/ws/collab/:ownerId/:mountId/:pathId', { auth: true })` in
  `apps/api/src/routes/collab.ts`. Auth is the better-auth session cookie on the upgrade request;
  read access gates `open()` (`getSharedDrive` → `canRead`), write permission is re-checked per
  message; `keepWebSocketAlive` pings. Clients use `y-websocket`'s `WebsocketProvider`
  (`resyncInterval: 5000`) — created in `apps/docs/.../editor.tsx`, `apps/sheets/.../use-sheet.ts`,
  `apps/stickies/.../use-board.ts`, `apps/slides/.../use-deck.ts`, URL from
  `getCollabWebSocketUrl` in `api.ts`. The provider auto-reconnects with backoff; pending local
  edits live in the client `Y.Doc` and merge on the reconnect sync handshake.
- **Chat is not Yjs** — messages go over REST + SSE (versioning treats chat `data.db` as byte-overwrite,
  not Yjs surgery). One chat scenario still belongs in the matrix; it just asserts SSE delivery.
- **Version restore is live**: `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`) does
  single-transaction root replacement via `CollabDocument.applySnapshotState` — connected editors
  are supposed to converge on a restore **without reload**. Routes:
  `/drive/:o/:m/file/:p/versions[/save | /:name/restore]`. Nothing tests that promise today.
- **Fixture APIs** (all used by VERIFICATION.md and/or `drive.test.ts`): `GET /drive/:o/default/root`,
  `POST /drive/:o/:m/folder/:pathId/create/:type`, multipart upload, `convert/eigensheets` and peers.
- **Flaky precedent**: `settings.test.ts` ("disabling one mount does not affect the other") is a
  known intermittent failure in the API suite. The E2E suite must not import that culture — see
  § Reliability engineering.

## Design

### Harness shape

**Playwright Test** (`@playwright/test`), not the bare `playwright` library on `bun test`. The
runner is the reason: `expect.poll`/`expect(locator)` auto-retrying assertions, per-test traces,
worker isolation, and `--repeat-each` burn-in are exactly the reliability machinery this suite
needs, and rebuilding them on `bun test` would be framework-on-framework in reverse. It runs on
Node as a dev tool; nothing in the product touches it.

**One browser, multiple `browserContext`s = multiple users.** Contexts have isolated cookies and
storage, so alice and bob are two fully independent signed-in clients inside one test — cheap
(one Chromium process) and deterministic. Separate browser *instances* are justified only when the
browser process itself is the subject (crash recovery) — no v1 scenario needs that.

```
e2e/
  playwright.config.ts     # workers, retries: 0, trace: 'retain-on-failure'
  global-setup.ts          # boot API + static server, setup wizard, create users, save cookies
  lib/
    server.ts              # spawn/kill the API subprocess + static file server
    users.ts               # alice/bob: sign-up via API, session-cookie storageState
    fixtures.ts            # createDoc(type, name) via drive API; per-test unique names
    converge.ts            # THE convergence primitive + per-type DOM probes
  tests/
    docs.spec.ts           # phase 1
    stickies.spec.ts …     # later phases
```

`e2e` becomes a workspace (one line in the root `workspaces` array) so Playwright is
lockfile-pinned by the single `bun install` — but its package.json deliberately has **no `test`
script**, so `bun run test` / `bun --filter '*' test` (local and CI) never picks it up. Invocation
is explicit, following the `test:api`/`test:sheet` precedent:

```
"test:e2e": "bun --filter '@eigen/e2e' e2e"    // → playwright test
```

Weighed against a top-level non-workspace `e2e/` (separate install, unpinned deps) and an
`apps/e2e` entry (swept into `build:prod`'s `--filter './apps/*'` glob): the top-level workspace is
the only shape that gets one lockfile *and* stays out of every existing sweep. The sweeps go by
script presence — `serve` (`bun --filter '*' dev`), `test` (`bun --filter '*' test`), `build`
(`bun --workspaces build`) each skip workspaces lacking the script (`packages/ui` ships no
`test`/`build` today) — so the e2e workspace ships exactly two scripts: `typecheck` (deliberately
swept by `bun run typecheck`) and `e2e` (targeted only by the root `test:e2e`). No `test`, `dev`,
or `build` script, ever.

### Product touches

Everything else lives under `e2e/`; app/API code changes in exactly three places, each one or a few
guarded lines: (1) `apps/api/src/index.ts` reads `process.env.PORT ?? 8000`; (2) the static server's
origin (`http://localhost:8101`) joins `trustedOrigins` in `apps/api/src/lib/auth/auth.ts`;
(3) a `VITE_E2E`-gated `window` handle on the `WebsocketProvider` at the four creation sites
(§ Offline / reconnect). Nothing else in product code may know the suite exists.

### Server lifecycle

`global-setup.ts` owns the instance, mirroring `apps/api/src/test/setup.ts`'s flow over real HTTP:

1. **Throwaway data dir** — `EIGEN_DATA_ROOT=data-test/e2e-<timestamp>` (same gitignored root the
   API tests use, previous runs cleared the same way).
2. **Spawn the API** as a real subprocess (`bun apps/api/src/index.ts`) — a real listening server,
   because browsers and WebSockets need one; `app.handle()` can't serve an upgrade. Spawn with an
   explicit env, not `--env-file` (which would read the gitignored dev `.env`): `EIGEN_DATA_ROOT`,
   `PORT=8100`, `API_URL=http://localhost:8100` (better-auth `baseURL`), `COOKIE_DOMAIN=localhost`.
   The fixed dedicated port (8100) lets the suite run next to a dev stack on 8000, and needs product
   touch 1 of 3 (see § Product touches): `apps/api/src/index.ts` reads `process.env.PORT ?? 8000`.
3. **Complete the wizard via API** — `POST /setup/complete` with `storageType: 'local-id'`
   (LocalStorage; **no S3 anywhere in the suite**), same body the API tests use. No UI clicking
   through the setup wizard — that's a scenario for an admin-app test someday, not an arrange step.
4. **Create deterministic users** — `e2e-alice@test.eigen.is` / `e2e-bob@test.eigen.is` via the
   sign-up endpoint (dev signup is open, per VERIFICATION.md), extract `better-auth.session_token`,
   persist per-user Playwright `storageState` files. Tests get "a page as alice" from a fixture;
   cookie injection is the proven `{ name, value, domain: 'localhost', path: '/' }` from
   VERIFICATION.md — host-scoped, valid on every port.
5. **Frontends: built assets, not vite dev.** `vite build --mode e2e` the apps under test and
   serve `dist/` from a ~20-line Bun static file server with SPA fallback per app base path. The
   mode is load-bearing: a plain production build reads root `.env`/`.env.production` — both
   gitignored — so a naive CI build ships every `VITE_APP_*_URL` undefined and `joinAppUrl` throws
   wherever a cross-app URL renders (the known "new frontend env vars break updates" class). A
   **committed root `.env.e2e`** carries the full `VITE_APP_*` set (prod-style relative values
   work, since the static server hosts every app under its base path on one origin) plus
   `VITE_API_HOST=http://localhost:8100` and `VITE_E2E=1`. (The committed `.env.development` can't
   serve here: it pins per-app dev ports 3001…3013 and API 8000 — the wrong topology twice over.)
   Vite dev servers in CI would import the two documented
   dev-only failure classes — the stale-HMR double-`createRoot` crash and cold-transform latency
   (VERIFICATION.md) — into a suite whose whole point is determinism. Built assets are what
   production serves; direct-to-API absolute host is the same topology the dev apps use, so no
   WS-proxy machinery is needed. The static server runs on its own fixed port (8101 — reusing a
   3000-range dev port would collide with a running dev stack), so its origin gets one line in
   `trustedOrigins` (`apps/api/src/lib/auth/auth.ts`) — product touch 2 of 3.
6. **Teardown** — SIGTERM the API (its graceful shutdown drains queues), delete the data dir on
   success, keep it on failure next to the traces.

**Arrange via API, act/assert via UI.** Every test creates its own document through
`POST /drive/:o/:m/folder/:root/create/:type` (the same call `drive.test.ts` makes) and navigates
both clients straight to the editor URL. UI clicks are reserved for the behavior under test;
arranging through the UI would make every test transitively depend on drive-UI details and
multiply the flake surface.

### The convergence primitive

The entire suite is built on one helper: *client A acted; poll until every client's DOM shows the
expected state*. No sleeps, anywhere, ever.

```ts
// e2e/lib/converge.ts
type Probe = (page: Page) => Promise<string>;
type Expected = string | ((text: string) => boolean); // predicate form for conflict cells

export async function expectConverged(pages: Page[], probe: Probe, expected: Expected) {
    for (const page of pages) {
        if (typeof expected === 'string') {
            // poll the text itself, not a boolean — a failed run's trace shows the divergent content
            await expect.poll(() => probe(page), { timeout: 15_000 }).toBe(expected);
        } else {
            await expect.poll(async () => expected(await probe(page)), { timeout: 15_000 }).toBe(true);
        }
    }
    // a predicate doesn't imply identity — pin identical content across clients
    const texts = await Promise.all(pages.map(probe));
    expect(new Set(texts).size).toBe(1);
}
```

Semantics: "converged" means every client's probe satisfies `expected` **and** all probes read
byte-identical — called only after every act in the scenario has completed, so once each client has
applied all updates, CRDT determinism makes identity the correct final check. Probes must be
read-only on the document; the sheets probe's cell-click readback mutates selection (not content),
which is why it, too, only runs post-act.

The author's page proves nothing about the server: Tiptap applies the edit to the local `Y.Doc`
synchronously, and `CollabDocument`'s broadcast deliberately skips the origin connection — only
the *other* client's DOM proves the round-trip. That yields a hard sequencing rule: **every
disruptive act (reload, offline drop, version restore) is gated on the non-author client's probe
showing the edit first.** A reload straight after typing can close the WS before the update
reaches the server — honest client behavior, but nondeterministic in a test, exactly the flake
class this suite forbids. Per-type probes live next to it — `docText` (ProseMirror root text),
`stickyCardTitles`, `slideTexts` (DOM), `sheetCell` (the hard one: sheets render to canvas, so the
probe clicks the cell and reads the formula bar / name box, the closed loop VERIFICATION.md
documents — which is why sheets ship last). The 15 s ceiling is a failure budget, not a wait: a
converged doc resolves in tens of milliseconds locally; `resyncInterval: 5000` bounds the worst
honest case; anything slower is a bug worth failing on.

For conflict scenarios the assertion is convergence, not a specific merge: pass the predicate form
(`t => t.includes(x) && t.includes(y)`) so neither edit may be lost, and the primitive's final
identity check pins both clients on the same merged content (Yjs guarantees a deterministic order;
the test never pins which).

### Flakiness policy (design pillar)

- **`retries: 0` in CI.** Retries convert "flaky" into "slow and silently rotting" — precisely the
  abandonment path the roadmap warns about. A red run means a bug in product or suite; both get
  fixed. Playwright's `trace: 'retain-on-failure'` (+ screenshot/video on failure) makes a no-retry
  policy affordable: one failure is fully diagnosable offline.
- **No arbitrary timeouts**: `expect.poll`/locator assertions only. A CI grep gate fails the build
  if `waitForTimeout` or `setTimeout` appears under `e2e/tests/` — enforcement, not convention.
- **Burn-in before merge**: every new or modified test must pass `--repeat-each=20` locally (the
  suite's analog of VERIFICATION.md's double pre-capture for baseline determinism).
- **Quarantine protocol**: if a flake slips in, the same day it is `test.skip`-ed with an issue link
  — never "re-run until green". A quarantined test that isn't fixed within two weeks is deleted.
  This is the explicit non-import of the `settings.test.ts` precedent.

### Offline / reconnect simulation

Two candidate mechanisms:

- **`context.setOffline(true)`** — realistic, but Chromium's network emulation does not reliably
  sever an *established* WebSocket; the provider may keep a live socket while "offline".
- **Closing the socket directly** — deterministic, but needs a handle on the provider.

Recommended: **both, combined**. The e2e build (built with `VITE_E2E=1`) exposes the
`WebsocketProvider` on `window` at the four provider-creation sites (one guarded line each). The test then
does `setOffline(true)` (blocks reconnection and all HTTP) plus `page.evaluate` →
`provider.ws.close()` (severs the live socket now). y-websocket schedules reconnects that fail
while offline; the client keeps editing into its local `Y.Doc`; `setOffline(false)` lets the next
retry connect and the sync handshake merge. That is exactly the user's laptop-lid scenario, made
deterministic. Note `provider.disconnect()` is *not* used — it sets `shouldConnect = false`, which
models "user closed the doc", not "network died". (Both library behaviors — Chromium's offline
emulation vs established sockets, and y-websocket's reconnect fields — are design assumptions;
re-verify against the pinned y-websocket during phase 1.) The guarded `window` handle at the four
provider-creation sites is product touch 3 of 3 — inactive in production bundles.

### Scenario matrix

| Scenario | docs | stickies | slides | sheets | chat |
|---|---|---|---|---|---|
| Two-client concurrent edit converges | **P1** | P2 | P2 | P3 | P2 (SSE, not Yjs) |
| Conflicting edits, same position | **P1** | P3 | P3 | P3 | n/a |
| Offline → edit → reconnect syncs | **P1** | P3 | P3 | P3 | n/a |
| Edit → reload → content survived | **P1** | P2 | P2 | P3 | P2 |
| Version-restore converges live, no reload | P2 | P3 | P3 | P3 | n/a |

**Phase 1 ships exactly four tests, all on docs** (Tiptap text — the richest CRDT surface with the
easiest DOM probe). Version-restore lands in P2 once the harness is proven: it exercises
`restoreYjsDoc`'s live root-replacement with a second connected client — save a version via the
drive API, edit further, `POST …/versions/:name/restore`, assert both clients converge on the
restored content without a reload. Sheets is last purely because of the canvas probe. Chat's two
cells pin SSE delivery and persistence through the same harness. The matrix stays this small on
purpose; breadth is phased behind a proven-reliable core, and every cell reuses `expectConverged`
with a different probe — no per-type harness code.

One future row is reserved now: [PROPOSAL_CRDT_MIGRATION.md](PROPOSAL_CRDT_MIGRATION.md) delegates
its stale-client scenario here (an old-bundle tab keeps editing across a deploy + format
migration, then reconnects — must not write old-format data); that proposal's OQ2 depends on this
suite answering it.

### CI integration

A separate job in `.github/workflows/` (new `e2e.yml` or a second job in `check.yml` — separate
job either way, so lint/typecheck feedback speed is untouched), on the same triggers: push/PR to
`main`. With a phase-1 suite of four tests there is no PR-vs-nightly split yet — everything runs on
PR. The split gets introduced only when the full matrix pushes past the budget: PR keeps the docs
column plus one convergence test per other type; nightly runs the full matrix.

```yaml
e2e:
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install --frozen-lockfile
    - uses: actions/cache@v4
      with: { path: ~/.cache/ms-playwright, key: playwright-${{ hashFiles('bun.lock') }} }
    - run: bunx playwright install chromium --with-deps
    - run: bun run build:e2e     # vite build --mode e2e per app under test → committed root .env.e2e
    - run: bun run test:e2e
    - uses: actions/upload-artifact@v4
      if: failure()
      with: { name: e2e-traces, path: e2e/test-results/, retention-days: 14 }
```

**Budget: 10 minutes wall clock** for the whole job (install + build + run), enforced by
`timeout-minutes`. Past experience with slow suites is unambiguous — over budget, it gets skipped
locally and then ignored in CI. Runtime headroom comes from building only the apps under test and
from the arrange-via-API rule. **Workers: 1 in phase 1.** The server handles concurrent users by
design, and tests are isolated (own docs), so parallel workers should be safe — but a green
deterministic history comes first; raising to 2–4 is a later, evidence-backed change, and worker
parallelism against one shared API subprocess is itself a flake source to introduce deliberately,
not by default.

### Reliability engineering

- **Fresh state per test**: every test creates its own doc with a unique name
  (`<test-title>-<workerIndex>`); no test reads another's document; no shared mutable fixtures.
  Users are shared (created once in global setup) because they are immutable arrange-state; docs
  are not.
- **One instance per run, not per test**: the API boots once in global setup. Per-test server boots
  would be prohibitively slow and would mask cross-test server state bugs the suite *should* find
  (a leaked `CollabDocument` subscription is a product bug).
- **What's reused vs new**: from the existing infrastructure the suite reuses *conventions and
  endpoints* — the `setup.ts` boot sequence (data dir → `/setup/complete` → sign-up → cookie), the
  user naming, the drive fixture routes, VERIFICATION.md's cookie injection and probe techniques.
  It imports no code from `apps/api/src/test/` — that code is built around in-process
  `app.handle()` and Eden Treaty; E2E talks real HTTP/WS from a browser. The duplication is ~60
  lines of setup and is the honest cost of a real server boundary.

## Open questions

- **D1 — Where the suite lives.** Top-level `e2e/` workspace vs `apps/e2e` vs non-workspace dir.
  *Recommendation:* `e2e/` workspace with no `test` script (single lockfile, outside every existing
  `--filter` glob), root script `test:e2e`.
- **D2 — Frontend serving in CI.** Built assets + static server + absolute `VITE_API_HOST` vs
  built assets behind a Caddy-style same-origin proxy vs vite dev servers. *Recommendation:* built
  assets, direct-to-API (matches dev topology, no WS-proxy code, avoids the documented HMR failure
  class); the same-origin proxy variant is a later option if a prod-topology bug ever warrants it.
- **D3 — Offline simulation.** `context.setOffline` alone vs provider-handle socket close.
  *Recommendation:* both combined, with the `VITE_E2E`-gated `window` provider handle (product
  touch 3, § Product touches) as the only testability seam in app code.
- **D4 — CI retries.** Playwright's common `retries: 2` in CI vs zero. *Recommendation:*
  `retries: 0` with `trace: 'retain-on-failure'`. Retries are how suites rot; the roadmap's
  constraint is explicit.
- **D5 — Workers.** Parallel workers from day one vs serial. *Recommendation:* `workers: 1` until
  the suite has a multi-week green history, then raise deliberately and watch.
- **D6 — API port.** Hardcode 8100 in the e2e config with the `process.env.PORT ?? 8000` change to
  `apps/api/src/index.ts`, vs keeping 8000 and forbidding a concurrent dev stack.
  *Recommendation:* the env override — two lines, and the suite must never require killing a
  running dev server (standing rule).

## Phasing

1. **Harness + docs (the smallest reliable suite).** `e2e/` workspace, global setup (throwaway
   instance, users, storage states), static server, `expectConverged` + `docText` probe, the four
   phase-1 docs scenarios, CI job with budget + artifact upload + the no-sleep grep gate. Gate:
   `--repeat-each=20` green locally *and* 10 consecutive green CI runs before the job becomes
   required.
2. **Widen types + restore.** `stickyCardTitles`/`slideTexts` probes; convergence +
   refresh-persistence for stickies/slides; chat SSE cells; version-restore-converges-live for docs
   (the `restoreYjsDoc` promise). Introduce the PR/nightly split only if the budget forces it.
3. **The hard cells.** Sheets (canvas probe via formula-bar readback), conflict + offline scenarios
   for the remaining types, version-restore across types. Consider raising workers per D5.

## Testing

The suite *is* the tests; what needs verifying is its own determinism:

- Every new test: `--repeat-each=20` locally before merge (burn-in gate, § Flakiness policy).
- Harness self-checks in phase 1: a deliberately-failing probe produces a retained trace +
  screenshot artifact; teardown leaves no orphan `bun` process and no data dir on success.
- The grep gate (`waitForTimeout`/`setTimeout` under `e2e/tests/`) fails CI — verified by a dummy
  violation once, then removed.
- 10 consecutive green CI runs before the job is made a required check — reliability is proven,
  not declared.
