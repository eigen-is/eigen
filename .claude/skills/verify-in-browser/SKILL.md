---
name: verify-in-browser
description: Use when a change must be proven in the running Eigen dev app rather than only in tests: driving it headless with Playwright or Chrome, taking and reading screenshots, pixel-gating a refactor, creating a throwaway test user or injecting an auth cookie, uploading and converting real documents, verifying on mobile viewports or touch, or whenever you start, check or stop the dev stack (API on :8000, vite apps). Also use when the dev app shows a blank page, a spinner that never ends, a `SQLITE_IOERR_VNODE` or `useContext` of null crash during verification.
---

# Verify in the browser

How an agent driving the app headless proves a change works in the real product; the test-user and upload conventions apply to manual verification too. Where it sits in a program: the [orchestrate skill](../orchestrate/SKILL.md), step 7.

## The dev stack

- **Check what runs first**, so you can restore it afterwards: `lsof -nP -iTCP:8000 -sTCP:LISTEN`, `lsof -nP -iTCP:<app port>` (it shows both address families) and `pgrep -f "bun --filter"`. Run them unsandboxed: inside the sandbox `lsof` and `curl` don't see `:8000`, and a running API looks down.
- **Check the load** before a headless run and at the first unexplained timeout: `uptime` and `ps -Ao pid,ppid,pcpu,rss,etime,command -r | head`. Kill an eigen vite with ppid 1 (an orphan from an earlier `bun run serve`) and your own leftovers, and name any non-eigen process using a lot of CPU to the user. A page that hangs only headless on a busy machine is not an app bug: ask the user to look in their own browser before you debug it.
- **One visible stack.** You may stop and restart the local eigen dev servers, but never leave a detached stack running beside the user's or without saying so; if you start one, say so and give the stop command. A second API on the same data dir exits on the instance lock (`Another Eigen API process is already using the data dir`), but vite still double-binds, and the lock stops at one kernel: never run a Docker container on the same `data/` as a host API, as both would write and corrupt the databases.
- **Prefer an isolated vite to touching the user's stack** when the running server serves another branch, or a pixel-gate baseline must run while implementation continues: `cd <worktree>/apps/<app> && bunx vite --port 3999` from a git worktree. The API's CORS allow-list lacks extra ports, so launch the browser with CORS off, which leaves SSE and the collab WebSocket untouched: `chromium.launchPersistentContext('/tmp/<name>-profile', { channel: 'chrome', headless: true, args: ['--disable-web-security'] })`. Don't shim `Access-Control-Allow-Origin` through Playwright route interception: it reproducibly stalls vite's module graph mid-load (blank page, no error).
- **The API runs unsandboxed.** Under the macOS sandbox SQLite WAL locking fails with `SQLITE_IOERR_VNODE` ("disk I/O error"), sometimes only on cold reopens minutes later, once files carry `com.apple.provenance`. Symptoms: boards and docs stuck on the spinner, `[Drive] Failed to init mount` in the API log, 500s on drive routes, sessions that vanish after a restart. `run_in_background` keeps the sandbox even with `dangerouslyDisableSandbox: true`, so launch detached from a foreground Bash call with `dangerouslyDisableSandbox: true`: `nohup bun --filter '@apps/api' --filter './apps/<app>' dev > <scratch>/devserver.log 2>&1 & disown` (the pair the root `serve:<app>` scripts run).
- **Stopping**: by port or pid, not TaskStop, and eigen paths only (a broad `pkill -f node_modules/.bin/vite` kills other projects' vites). In zsh `kill $PIDS` silently does nothing; pipe through `xargs kill`.
- **Two fleets on one port.** A second `bun run serve` doesn't fail with EADDRINUSE: one vite binds `127.0.0.1:3000`, the other `[::1]:3000`, and `localhost` lands on either per connection. Both write `apps/<app>/node_modules/.vite/deps`, so a page mixes two optimizer generations and two React instances, and the lazy TanStack Router devtools crash with `Cannot read properties of null (reading 'useContext')`. Signature: a stack trace mixing hashed chunk names without `?v=` and dep URLs with `?v=`, or one page's optimized deps carrying different `?v=` hashes. Fix: stop every fleet (both address families, stale worktree vites on spare ports, orphaned APIs on 8000), `rm -rf apps/*/node_modules/.vite`, start one.
- **Ports and base paths**: the dev ports are `APP_PORTS` in `vite.shared.config.ts` (index 3000, mail 3001, drive 3002, …, sheets 3013, vector 3014; API 8000). An app serves under its name, so the sheets editor is `localhost:3013/sheets/sheet/<ownerId>/<mountId>/<pathId>`.
- **A stack on agent ports** (such as vites on 36xx and an API on 86xx beside the user's stack):
  - The API needs `EIGEN_API_PORT` and its own `EIGEN_DATA_ROOT`; each vite needs `--port N --strictPort`, `VITE_API_HOST` and the `VITE_APP_*_URL` values set to the 86xx and 36xx addresses.
  - The API trusts only origins `localhost:3000` to `localhost:3014` (`getTrustedOrigins`) and refuses a sign-in from a 36xx page: sign in with curl and `Origin: http://localhost:3014`, inject the cookie as in Cookie injection, and run Chrome with `--disable-web-security`.
  - Dark mode is `localStorage['eigen-theme'] = 'dark'`, set before the page loads; `prefers-color-scheme` applies only while the theme is `system`, and a theme saved in the Space app's settings comes from the server and overrides it.

## Test users and auth

- **Creating users**: the public `POST /auth/sign-up/email` returns 403 (self-registration is off). Create test users server-side with `auth.api.signUpEmail` (see `apps/api/src/test/setup.ts`) or the admin Users page, then `POST /auth/sign-in/email` for the `better-auth.session_token` cookie.
- **Convention**: one throwaway account per task, `<task>-verify@eigen.test` with password `<account>-password-123` (`cycle8-verify@eigen.test` / `cycle8-verify@eigen.test-password-123`). Never verify in a real user's drive. Leave documents that are useful reproducers; trash the rest (`DELETE /drive/:owner/:mount/path/:pathId`, a soft delete).
- **Cookie injection**: cookies are host-scoped, not port-scoped, so a cookie from `:8000` authenticates every app port: `context.addCookies([{ name: 'better-auth.session_token', value, domain: 'localhost', path: '/' }])`. A release Docker install, such as a harness install, names it `__Secure-better-auth.session_token`, even over http.

## Driving the apps headless

- **Setup**: `bun add playwright` in a `/tmp` work dir; `chromium.launch({ channel: 'chrome' })` uses the system Chrome, no browser download.
- **Launch native on Apple silicon**: an agent's shell may run under Rosetta (`sysctl -n sysctl.proc_translated` prints 1), and the universal Chrome it launches then runs as translated x86_64, about ten times slower. Run the script as `arch -arm64 /bin/zsh -c 'bun run.ts'`.
- **Patience**: a cold first load takes 15–20 s with one vite auto-reload (code-split routes discover deps late), a first heavy render (a sheets workbook) 20–60 s. Poll for the element (`canvas`), then settle a few seconds. Remove the TanStack Router devtools button from the DOM before clicking near it, as it can intercept clicks.
- **Stale-HMR crash** on long-running dev servers: the vite client may re-import `main.tsx?t=<ts>`, and the second `createRoot` and a fatal `removeChild` NotFoundError blank the app. For a one-off, `page.route(/src\/main\.tsx\?t=/, r => r.fulfill({ body: 'export {};', contentType: 'application/javascript' }))` and reload. While another process keeps writing repo files (a parallel agent, the lint hook), every write blanks the app again (drive especially) and a restart doesn't help: in `page.addInitScript`, replace `window.WebSocket` with a wrapper that returns an inert, already-closed stub when the subprotocols include `vite-hmr` and defers to the native constructor otherwise. The collab socket and SSE on `:8000` stay untouched and the run is deterministic.
- **Headless traps**: Radix animations hang, so inject `*{animation-duration:0s}`. An empty `<svg><g>` counts as hidden, so wait with `state: 'attached'`. `setPointerCapture` throws on a synthetic pointerId, so shim it in the page.
- **A harness install over HTTPS** refuses sign-in from `https://localhost:<harness port>` (403), since the Origin must be exactly `https://localhost`: launch Chrome with `--host-resolver-rules="MAP localhost:443 127.0.0.1:<port>"` and open `https://localhost`.
- **A harness scratch install to drive**: the helpers in `docker/probe-lib.sh` (`scratch_init`, `new_install`, `run_setup`, `stack_up`) with `HARNESS_KEEP=1`, which leaves it running when the script exits.

## Uploading and converting real documents

- `GET /drive/:owner/default/root` returns the root pathId.
- `POST /drive/:owner/:mount/file/:parentId` (multipart, field `file`) uploads.
- `POST /drive/:owner/:mount/file/:pathId/convert/eigensheets` (and peers) converts.
- Real benchmark files never enter git; stage them under `/tmp`.

## Verdicts come from pixels

- **Screenshot every relevant state and READ the screenshots**: data-shape assertions alone miss rendering bugs.
- **Behavioral probes beat static shots**: scroll (frozen panes), click (menus, dropdowns, buttons), type and reload (persistence).
- **Compare against a baseline**: the previous cycle's screenshots, or for round-trips the original document side by side. Pixelmatch for objectivity, eyes for judgment; read flagged regions at zoom.
- **Pixel gates are for render paths.** A refactor of a render path (sheet canvas, export and preview renderers, layout CSS), where a wrong pixel is the failure and no test asserts it, is gated: baseline screenshots before, re-capture after, byte-identical or it doesn't merge, with baseline determinism proven by a double pre-capture. Each capture serializes the session (nothing may edit the tree meanwhile) and costs minutes, so a type-only or string-only refactor gets tests, typecheck and one behavioral probe with its screenshots read instead.
- **Output for external software** (xlsx, ics, eml, …) is spot-opened in the real consumer (Excel, Google Sheets, a mail client, …): a valid file can still be mishandled there.

## Mobile and touch

Screenshot at 390×844 and 360×800, with behavioral probes (tap, long-press, scroll, reload). Page-level overflow probes report 0 on portalled layers and `overflow:hidden` clips, so pixel review is mandatory. Long-press needs real CDP touch synthesis. The seeded `mobile-audit@eigen.is` account follows the password Convention and goes in by Cookie injection. The real-device checks still owed are in the Mobile row of [ROADMAP.md](../../../docs/ROADMAP.md).

## Sheet editor

- Tab bar: `div.h-8.select-none`, items `div[tabindex="0"]:not(.hidden)`; click to switch (about 5 s render for big sheets).
- Canvas cell clicks need the header offsets (+46 px x, +20 px y); the name box confirms which cell was hit.
- The hyperlink preview card opens on hover (`onMouseMove`), not mousedown. For non-http navigation (`mailto:`), assert with an injected `window.open` spy, as headless popups are unreliable there.
