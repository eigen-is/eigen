# Security Audit (2026-09-06): open items

> **TLDR**: Small audit of the API, frontends, document transforms and Docker deployment. Twelve findings shipped on main with one-line to small fixes (open sign-up route, comment-card XSS, sheet-paste XSS, iMIP sender verification, editor save gate, preview sanitizers, awareness bounds, WebDAV headers, request-access bounds, ffmpeg whitelist, dependency bump). What is left below is hardening, each with the minimal fix. Two items are ready on unmerged branches. Nothing here needs new UI or settings.

Scope follows [SECURITY.md](../SECURITY.md). Severity: **Medium** = a missing second layer under a sanitizer that is currently correct; **Low** = hygiene.

| # | Sev | Item | Minimal fix | Where |
|---|-----|------|-------------|-------|
| 21 | Low | API `TRUSTED_NETWORKS` also trusts `172.16/12`, and the setup fallback subnet `10.20.0.0/24` falls outside it | Derive from `EIGEN_SUBNET` in `docker-compose.yml`, `scripts/setup.ts`, `scripts/generate-env.sh`. | `apps/api/src/lib/core/access.ts` |
| 11 | Low | HTML mail auto-loads remote images | Parked: every fix is a feature (opt-in toggle or image proxy). | `apps/api/src/lib/mail/mail-parse.ts` |
| 12 | Low | Awareness display name is client-set | Accepted: the server binds `user.userId` to the session and owns client-id slots per connection, so a peer cannot evict or overwrite another cursor; a user may still label their own cursor with any name. | `apps/api/src/lib/collab/collabDocument.ts` |
| 9 | Low | `bun audit` reports advisories in runtime dependency trees | After the 2026-09-08 compatible-range round: 62 advisories in 15 packages (0 critical, 30 high, 28 moderate, 4 low), none with an in-range fix. Open because they need a major: nodemailer 6→10 and sharp 0.34→0.35 (libvips CVEs; sharp only reads uploads inside a one-shot Worker, nodemailer only sends through local sendmail). The rest are transitive trees pinned by their parents (axios, brace-expansion, browserslist, defu, esbuild, file-type, form-data, js-yaml, lodash, tmp, uuid, nanoid v3 copies under postcss/html-to-docx). Re-run before each release. Recipe: `bun update` inside every workspace (the root run only touches root deps), then `bun run check` and a browser pass; better-auth verifies `auth-schema.ts` against its plugin models at startup (`SCHEMA_MISMATCH`), so a minor that adds columns needs `auth-schema.ts`, the `setup.ts` DDL and `ensureAuthSchemaColumns` in `auth.ts` together. | `bun.lock` |

Not findings, recorded so the next audit does not repeat them: document containers hold embedded `.eigenchat` comment threads and `media/` folders by design, and chats inside documents have their own `media/` ([ACL.md](ACL.md), [COMMENTS.md](COMMENTS.md)); a create or copy guard on container parents breaks that. Uploaded SVGs are rasterised for list thumbnails and avatars through sharp; the bundled librsvg ignores external references, verified.

Tracked as one row in [ROADMAP.md](ROADMAP.md). Prune this file when the rows above have shipped.
