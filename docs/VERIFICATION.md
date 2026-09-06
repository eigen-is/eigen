# Verifying changes in the running app

How to prove a change works in the real product, not just in tests. This recipe was developed
over the sheets xlsx-fidelity program and is the standard for browser verification. It is written for an agent
driving the app headless, but the conventions (test users, upload/convert API) apply to manual
verification too.

## Test users

- **Dev signup**: self-registration is off by default (`onboarding.openSignup`); enable it in the admin onboarding settings (or `await updateServerSettings({ onboarding: { openSignup: true } })`) before `POST localhost:8000/auth/sign-up/email` with `{email, password, name}` creates a user and returns a `better-auth.session_token` cookie. Sign in to an existing account via `POST /auth/sign-in/email`.
- **Convention**: one throwaway account per task, named `<task>-verify@eigen.test`, password
  `<account>-password-123` (e.g. `cycle8-verify@eigen.test` / `cycle8-verify@eigen.test-password-123`).
  Never verify in a real user's drive. Leave the account's documents in place when they are
  useful reproducers; otherwise trash them (`DELETE /drive/:owner/:mount/path/:pathId`, soft
  delete).
- **Cookie injection**: cookies are host-scoped, not port-scoped — a cookie obtained from
  `:8000` authenticates every app port. In Playwright:
  `context.addCookies([{ name: 'better-auth.session_token', value, domain: 'localhost', path: '/' }])`.

## Driving the dev apps headless

- **Playwright setup**: `bun add playwright` in a `/tmp` work dir;
  `chromium.launch({ channel: 'chrome' })` uses the installed system Chrome (no browser download).
- **Ports and base paths**: per-app dev ports live in `vite.shared.config.ts` (API 8000,
  drive 3002, sheets 3013, …). Apps serve under their name as base path — sheets editor URL:
  `localhost:3013/sheets/sheet/<ownerId>/<mountId>/<pathId>`.
- **Never start, restart, or kill the user's dev server.** Check what's running first (`lsof`).
  If the running server serves a different branch than the code under verification, run an
  isolated vite from a git worktree on a free port (`cd <worktree>/apps/<app> && bunx vite
  --port 3999`). Caveat: the API's CORS allow-list doesn't include extra ports — launch the
  test browser with CORS off instead:
  `chromium.launchPersistentContext('/tmp/<name>-profile', { channel: 'chrome', headless: true, args: ['--disable-web-security'] })`.
  Don't shim `Access-Control-Allow-Origin` via Playwright route interception — intercepting
  requests reproducibly stalls vite's module graph mid-load (blank page, no error), and the
  no-CORS browser also leaves SSE and the collab WebSocket untouched.
- **The API must run unsandboxed.** An agent-launched server under the macOS command sandbox
  fails SQLite WAL locking with `SQLITE_IOERR_VNODE` ("disk I/O error") — sometimes only on
  cold reopens minutes later, after files got stamped with `com.apple.provenance`. Symptoms:
  boards/docs stuck on the loading spinner, `Failed to init mount` in the API log. Launch the
  server from an unsandboxed shell, detached (`nohup … & disown`); background-task runners may
  silently re-apply the sandbox even when asked not to.
- **Stale-HMR crash** (long-running dev servers): the vite client may re-import
  `main.tsx?t=<ts>`, double-evaluating the entry → double `createRoot` → fatal `removeChild`
  NotFoundError that blanks the app. Workaround:
  `page.route(/src\/main\.tsx\?t=/, r => r.fulfill({ body: 'export {};', contentType: 'application/javascript' }))`
  and reload.
  That workaround assumes the crash is a one-off. While another process keeps writing repo files — a parallel agent, the lint hook — every write pushes a fresh update, so the app (the drive one especially) blanks again on the next one and a restart of the dev servers does not help. Cut the channel instead of patching each update: in `page.addInitScript`, replace `window.WebSocket` with a wrapper that hands back an inert already-closed stub when the requested subprotocols include `vite-hmr` and defers to the native constructor otherwise, which leaves the collab socket and SSE on `:8000` untouched and makes the run deterministic.
- **Patience**: a first heavy render (sheets Workbook) can take 20–60 s cold — poll for the
  element (`canvas`), then settle a few seconds. The TanStack Router devtools button can
  overlay UI and intercept clicks — remove it from the DOM before clicking near it.

## Uploading and converting real documents

- `GET /drive/:owner/default/root` → root pathId.
- `POST /drive/:owner/:mount/file/:parentId` (multipart, field `file`) → upload.
- `POST /drive/:owner/:mount/file/:pathId/convert/eigensheets` (and peers) → convert.
- Real benchmark files must never enter git — stage them under `/tmp`.

## Verdicts come from pixels

- **Screenshot every relevant state and READ the screenshots.** Data-shape assertions alone
  miss rendering bugs — the freeze-pane filter-button drift and the merged-border export loss
  were only visible in pixels.
- **Behavioral probes beat static shots**: scroll (frozen panes), click (menus, dropdowns,
  buttons), type + reload (persistence).
- **Compare against a baseline**: the previous cycle's screenshots, or for round-trips the
  original document rendered side by side. Use pixelmatch for objectivity, eyes for judgment;
  read flagged regions at zoom.
- **Pure refactors are pixel-gated**: capture baseline screenshots before, re-capture after —
  byte-identical or it doesn't merge. Prove baseline determinism with a double pre-capture.
- **Output consumed by external software** (xlsx, ics, eml, …) must be spot-opened in the real
  consumer (Excel, Google Sheets, a mail client, …). A library can write technically-valid
  files that real consumers still mishandle — exceljs wrote internal hyperlinks that opened
  fine in our own importer and showed "Invalid link" in Google Sheets.

## Sheet-editor specifics

- Tab bar: `div.h-8.select-none`, items `div[tabindex="0"]:not(.hidden)`; click to switch
  (~5 s render for big sheets).
- Canvas cell clicks need the header offsets (+46 px x, +20 px y); the name box is a reliable
  closed loop to confirm which cell was actually hit.
- The hyperlink preview card triggers on hover (`onMouseMove`), not mousedown. For non-http
  navigation (mailto:), assert via an injected `window.open` spy — headless popups are
  unreliable there.
