# Security Audit (2026-09-06): open items

> **TLDR**: Small audit of the API, frontends, document transforms and Docker deployment. Twelve findings shipped on main with one-line to small fixes (open sign-up route, comment-card XSS, sheet-paste XSS, iMIP sender verification, editor save gate, preview sanitizers, awareness bounds, WebDAV headers, request-access bounds, ffmpeg whitelist, dependency bump). What is left below is hardening, each with the minimal fix. Two items are ready on unmerged branches. Nothing here needs new UI or settings.

Scope follows [SECURITY.md](../SECURITY.md). Severity: **Medium** = a missing second layer under a sanitizer that is currently correct; **Low** = hygiene.

| # | Sev | Item | Minimal fix | Where |
|---|-----|------|-------------|-------|
| 8 | Medium | No Content-Security-Policy on any deployment shape | A `<meta http-equiv="Content-Security-Policy">` injected by the shared Vite plugin covers every shape (edge, static, host proxies). The API cannot set it: Caddy's file server serves the HTML. Needs a browser pass over all apps before merge. | branch `worktree-agent-ace5dc7677d82b1ed` (unmerged, tests green, not browser-verified) |
| 18 | Low | `static` shape and generated host-proxy snippets ship no security headers | Copy the three `header` lines from `/Caddyfile` into `docker/static/Caddyfile` and the nginx/Caddy/Apache snippets in `scripts/setup.ts`, plus `Referrer-Policy: strict-origin-when-cross-origin` in all of them. | same branch as #8 |
| 19 | Low | Postfix `mynetworks` and OpenDKIM `InternalHosts` trust all of `172.16/12` | Derive both from `EIGEN_SUBNET` with loopback-only fallback. Hygiene: Docker DNAT keeps the real client IP, so this is not a relay hole today. | branch `worktree-agent-aa7a826a460a00306` (unmerged, reviewed) |
| 20 | Low | `build.log` tracked; check workflow has no `permissions:` block | `git rm --cached build.log` + `.gitignore`; `permissions: contents: read`. | same branch as #19 |
| 21 | Low | API `TRUSTED_NETWORKS` also trusts `172.16/12`, and the setup fallback subnet `10.20.0.0/24` falls outside it | Derive from `EIGEN_SUBNET` in `docker-compose.yml`, `scripts/setup.ts`, `scripts/generate-env.sh`. | `apps/api/src/lib/core/access.ts` |
| 10 | Low | HTML mail keeps `<form>` and positioned CSS inside the closed shadow root | `FORBID_TAGS: ['form']` in `mail-parse.ts`. The body is server-purified and stays in the shadow root by decision; no iframe. | `apps/api/src/lib/mail/mail-parse.ts` |
| 11 | Low | HTML mail auto-loads remote images | Parked: every fix is a feature (opt-in toggle or image proxy). | `apps/api/src/lib/mail/mail-parse.ts` |
| 12 | Low | Awareness display name is client-set | Accepted: the server binds `user.userId` to the session and owns client-id slots per connection, so a peer cannot evict or overwrite another cursor; a user may still label their own cursor with any name. | `apps/api/src/lib/collab/collabDocument.ts` |
| 9 | Low | `bun audit` still reports advisories after the patched sanitizer bump | Remaining entries sit in unrelated dependency trees (better-auth OIDC/MCP plugins not configured, build-time chains). Re-run `bun audit` before each release. | `bun.lock` |

Not findings, recorded so the next audit does not repeat them: document containers hold embedded `.eigenchat` comment threads and `media/` folders by design, and chats inside documents have their own `media/` ([ACL.md](ACL.md), [COMMENTS.md](COMMENTS.md)); a create or copy guard on container parents breaks that. Uploaded SVGs are rasterised for list thumbnails and avatars through sharp; the bundled librsvg ignores external references, verified.

Tracked as one row in [ROADMAP.md](ROADMAP.md). Prune this file when the rows above have shipped.
