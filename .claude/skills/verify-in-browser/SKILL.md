---
name: verify-in-browser
description: Use when a change must be proven in the running Eigen dev app rather than only in tests — driving it headless with Playwright or Chrome, taking and reading screenshots, pixel-gating a refactor, creating a throwaway test user or injecting an auth cookie, uploading and converting real documents, verifying on mobile viewports or touch, or starting, checking or stopping the dev stack (API on :8000, vite apps) for that purpose. Also use when the dev app shows a blank page, a spinner that never ends, a `SQLITE_IOERR_VNODE` or `useContext` of null crash during verification.
---

# Verify in the browser

How to prove a change works in the real product, not just in tests. Written for an agent driving the app headless; the conventions (test users, upload and convert API) apply to manual verification too. Where verification sits in a program: [WORKING-METHOD.md](../../../docs/WORKING-METHOD.md).

## The dev stack

- **Check what's running first**: `lsof -nP -iTCP:8000 -sTCP:LISTEN`, `lsof -nP -iTCP:<app port>` (it shows both address families) and `pgrep -f "bun --filter"`. Know what runs so you can restore it afterwards.
- **One visible stack.** You may stop and restart the local eigen dev servers when needed, but never leave a detached stack running next to the user's own or without saying so: they can't see it and will start theirs. The API holds an instance lock and a second one on the same data dir exits (`Another Eigen API process is already using the data dir`), but vite still double-binds, and a Docker container on the same data is a stack the lock can't see. If you start one, say so and give the stop command.
- **Prefer an isolated vite over touching the user's stack.** When the running server serves a different branch, or a pixel-gate baseline must run while implementation continues, run vite from a git worktree on a free port (`cd <worktree>/apps/<app> && bunx vite --port 3999`). The API's CORS allow-list doesn't include extra ports, so launch the test browser with CORS off: `chromium.launchPersistentContext('/tmp/<name>-profile', { channel: 'chrome', headless: true, args: ['--disable-web-security'] })`. Don't shim `Access-Control-Allow-Origin` via Playwright route interception: intercepting requests reproducibly stalls vite's module graph mid-load (blank page, no error). The no-CORS browser leaves SSE and the collab WebSocket untouched.
- **The API must run unsandboxed.** Under the macOS command sandbox SQLite WAL locking fails with `SQLITE_IOERR_VNODE` ("disk I/O error"), sometimes only on cold reopens minutes later, after files got stamped with `com.apple.provenance`. Symptoms: boards and docs stuck on the loading spinner, `[Drive] Failed to init mount` in the API log, 500s on drive routes, sessions that seem to vanish after a restart. The Bash tool's `run_in_background` keeps the sandbox even with `dangerouslyDisableSandbox: true`, so launch detached from a foreground Bash call with `dangerouslyDisableSandbox: true`: `nohup bun --filter '@apps/api' --filter './apps/<app>' dev > <scratch>/devserver.log 2>&1 & disown` (the same pair the root `serve:<app>` scripts run).
- **Stopping**: kill by port or pid, not TaskStop, and target eigen paths only (a broad `pkill -f node_modules/.bin/vite` kills other projects' vites too). In zsh `kill $PIDS` silently does nothing (no word-splitting); pipe through `xargs kill`.
- **Two fleets on one port.** A second `bun run serve` doesn't fail with EADDRINUSE: one vite binds `127.0.0.1:3000`, the other `[::1]:3000`, and `localhost` lands on either per connection. Both write the same `apps/<app>/node_modules/.vite/deps`, so one page mixes two optimizer generations, loads two React instances, and the lazily imported TanStack Router devtools crash with `Cannot read properties of null (reading 'useContext')`. Signature: a stack trace mixing hashed chunk names without `?v=` and dep URLs with `?v=`, or one page's optimized deps carrying different `?v=` hashes. Fix: stop every fleet (both address families, stale worktree vites on spare ports, orphaned APIs on 8000), `rm -rf apps/*/node_modules/.vite`, start one.
- **Ports and base paths**: per-app dev ports are `APP_PORTS` in `vite.shared.config.ts` (index 3000, mail 3001, drive 3002, …, sheets 3013, vector 3014; API 8000). Apps serve under their name as base path, so the sheets editor is `localhost:3013/sheets/sheet/<ownerId>/<mountId>/<pathId>`.

## Test users and auth

- **Creating users**: the public `POST /auth/sign-up/email` is blocked (403, self-registration is off). Create test users server-side with `auth.api.signUpEmail` (see `apps/api/src/test/setup.ts`) or through the admin Users page, then sign in with `POST /auth/sign-in/email` to get the `better-auth.session_token` cookie.
- **Convention**: one throwaway account per task, `<task>-verify@eigen.test` with password `<account>-password-123` (e.g. `cycle8-verify@eigen.test` / `cycle8-verify@eigen.test-password-123`). Never verify in a real user's drive. Leave the account's documents in place when they are useful reproducers; otherwise trash them (`DELETE /drive/:owner/:mount/path/:pathId`, soft delete).
- **Cookie injection**: cookies are host-scoped, not port-scoped, so a cookie from `:8000` authenticates every app port. In Playwright: `context.addCookies([{ name: 'better-auth.session_token', value, domain: 'localhost', path: '/' }])`.

## Driving the apps headless

- **Setup**: `bun add playwright` in a `/tmp` work dir; `chromium.launch({ channel: 'chrome' })` uses the installed system Chrome, no browser download.
- **Patience**: the first cold load of an app takes 15–20 s with one vite auto-reload (deps inside code-split route files are discovered late); a first heavy render (a sheets workbook) can take 20–60 s. Poll for the element (`canvas`), then settle a few seconds. The TanStack Router devtools button can overlay UI and intercept clicks; remove it from the DOM before clicking near it.
- **Stale-HMR crash** (long-running dev servers): the vite client may re-import `main.tsx?t=<ts>`, evaluating the entry twice: a second `createRoot` and a fatal `removeChild` NotFoundError blank the app. For a one-off, `page.route(/src\/main\.tsx\?t=/, r => r.fulfill({ body: 'export {};', contentType: 'application/javascript' }))` and reload. While another process keeps writing repo files (a parallel agent, the lint hook) every write pushes a fresh update, the app (drive especially) blanks again, and restarting the dev servers doesn't help. Cut the channel instead: in `page.addInitScript`, replace `window.WebSocket` with a wrapper that returns an inert, already-closed stub when the requested subprotocols include `vite-hmr` and defers to the native constructor otherwise. The collab socket and SSE on `:8000` stay untouched and the run is deterministic.
- **A harness install over HTTPS**: a browser on `https://localhost:<harness port>` gets 403 on sign-in, because the Origin must be exactly `https://localhost`. Launch Chrome with `--host-resolver-rules="MAP localhost:443 127.0.0.1:<port>"` and open `https://localhost`.
- **A harness scratch install to drive**: make one with the helpers in `docker/probe-lib.sh` (`scratch_init`, `new_install`, `run_setup`, `stack_up`) and `HARNESS_KEEP=1`, which leaves it running when the script exits.

## Uploading and converting real documents

- `GET /drive/:owner/default/root` returns the root pathId.
- `POST /drive/:owner/:mount/file/:parentId` (multipart, field `file`) uploads.
- `POST /drive/:owner/:mount/file/:pathId/convert/eigensheets` (and peers) converts.
- Real benchmark files never enter git; stage them under `/tmp`.

## Verdicts come from pixels

- **Screenshot every relevant state and READ the screenshots.** Data-shape assertions alone miss rendering bugs: the freeze-pane filter-button drift and the merged-border export loss were only visible in pixels.
- **Behavioral probes beat static shots**: scroll (frozen panes), click (menus, dropdowns, buttons), type and reload (persistence).
- **Compare against a baseline**: the previous cycle's screenshots, or for round-trips the original document rendered side by side. Pixelmatch for objectivity, eyes for judgment; read flagged regions at zoom.
- **Pixel gates are for render paths.** A refactor touching a render path (sheet canvas, export and preview renderers, layout CSS), where a wrong pixel is the failure mode and no test asserts it, is gated: capture baseline screenshots before, re-capture after, byte-identical or it doesn't merge; prove baseline determinism with a double pre-capture. Each capture serializes the session (nothing may edit the tree while it runs) and costs minutes, so a type-only or string-only refactor gets tests, typecheck and one behavioral probe with its screenshots read instead.
- **Output consumed by external software** (xlsx, ics, eml, …) is spot-opened in the real consumer (Excel, Google Sheets, a mail client, …). A library can write technically valid files that real consumers still mishandle: exceljs wrote internal hyperlinks that opened fine in our own importer and showed "Invalid link" in Google Sheets.

## Mobile and touch

Screenshot at 390×844 and 360×800 and pair pixel verdicts with behavioral probes (tap, long-press, scroll, reload). Page-level overflow probes report 0 on portalled layers and `overflow:hidden` clips, so pixel review is mandatory. Long-press needs real CDP touch synthesis. Seeded account and per-phase checks: [MOBILE.md § Verification](../../../docs/MOBILE.md#verification-every-phase).

## Sheet editor

- Tab bar: `div.h-8.select-none`, items `div[tabindex="0"]:not(.hidden)`; click to switch (about 5 s render for big sheets).
- Canvas cell clicks need the header offsets (+46 px x, +20 px y); the name box is a reliable closed loop to confirm which cell was actually hit.
- The hyperlink preview card triggers on hover (`onMouseMove`), not mousedown. For non-http navigation (`mailto:`), assert via an injected `window.open` spy; headless popups are unreliable there.
