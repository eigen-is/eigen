# Security Audit (2026-09-06): open items

> **TLDR**: Small audit of the API, frontends, document transforms and Docker deployment. Twelve findings shipped on main with one-line to small fixes (open sign-up route, comment-card XSS, sheet-paste XSS, iMIP sender verification, editor save gate, preview sanitizers, awareness bounds, WebDAV headers, request-access bounds, ffmpeg whitelist, dependency bump). What is left below is hardening, each with the minimal fix. Two items are ready on unmerged branches. Nothing here needs new UI or settings.

Scope follows [SECURITY.md](../SECURITY.md). Severity: **Medium** = a missing second layer under a sanitizer that is currently correct; **Low** = hygiene.

| # | Sev | Item | Minimal fix | Where |
|---|-----|------|-------------|-------|
| 21 | Low | API `TRUSTED_NETWORKS` also trusts `172.16/12`, and the setup fallback subnet `10.20.0.0/24` falls outside it | Derive from `EIGEN_SUBNET` in `docker-compose.yml`, `scripts/setup.ts`, `scripts/generate-env.sh`. | `apps/api/src/lib/core/access.ts` |
| 11 | Low | HTML mail auto-loads remote images | Parked: every fix is a feature (opt-in toggle or image proxy). | `apps/api/src/lib/mail/mail-parse.ts` |
| 12 | Low | Awareness display name is client-set | Accepted: the server binds `user.userId` to the session and owns client-id slots per connection, so a peer cannot evict or overwrite another cursor; a user may still label their own cursor with any name. | `apps/api/src/lib/collab/collabDocument.ts` |
| 9 | Low | `bun audit` reports advisories in runtime dependency trees | Run on 2026-09-08 after the sanitizer bump: 108 advisories in 28 packages (2 critical, 56 high). Not only unrelated trees: direct API dependencies carry critical/high entries with **compatible** fixes available — better-auth 1.5.6→1.7.3 (critical: OAuth callback accepts a mismatched `state`; SSO is not configured, so the reachable surface today is nil), drizzle-orm 0.45.1→0.45.2 (SQL injection via unescaped identifiers), exiftool-vendored 35.14→35.21 (argument injection via newline), @tanstack/react-router 1.168→1.170 (seroval, critical, build-side), @tiptap/core 3.21→3.31, nanoid patch. Without a compatible fix: nodemailer 6→10 and sharp 0.34→0.35 (libvips CVEs), both majors. A `bun update` round plus `bun run check` and a browser pass clears the compatible set; better-auth minors can carry auth-schema changes, so diff `auth-schema.ts` after the bump. Re-run before each release. | `bun.lock` |

Not findings, recorded so the next audit does not repeat them: document containers hold embedded `.eigenchat` comment threads and `media/` folders by design, and chats inside documents have their own `media/` ([ACL.md](ACL.md), [COMMENTS.md](COMMENTS.md)); a create or copy guard on container parents breaks that. Uploaded SVGs are rasterised for list thumbnails and avatars through sharp; the bundled librsvg ignores external references, verified.

Tracked as one row in [ROADMAP.md](ROADMAP.md). Prune this file when the rows above have shipped.
