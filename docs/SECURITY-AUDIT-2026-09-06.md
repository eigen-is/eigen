# Security Audit (2026-09-06): standing decisions

> **TLDR**: Small audit of the API, frontends, document transforms and Docker deployment. Every sink-level finding is fixed on main with one-line to small fixes (open sign-up route, comment-card XSS, sheet-paste XSS, iMIP sender verification, editor save gate, preview sanitizers, awareness bounds, WebDAV headers, request-access bounds, ffmpeg whitelist, dependency bump, `TRUSTED_NETWORKS` derived from `EIGEN_SUBNET`). What is left below is not code work: one parked item, one accepted item, and the dependency-advisory recipe to re-run before each release.

Scope follows [SECURITY.md](../SECURITY.md). Severity: **Medium** = a missing second layer under a sanitizer that is currently correct; **Low** = hygiene.

| # | Sev | Item | Minimal fix | Where |
|---|-----|------|-------------|-------|
| 11 | Low | HTML mail auto-loads remote images | Parked: every fix is a feature (opt-in toggle or image proxy). | `apps/api/src/lib/mail/mail-parse.ts` |
| 12 | Low | Awareness display name is client-set | Accepted: the server binds `user.userId` to the session and owns client-id slots per connection, so a peer cannot evict or overwrite another cursor; a user may still label their own cursor with any name. | `apps/api/src/lib/collab/collabDocument.ts` |
| 9 | Low | `bun audit` reports advisories in runtime dependency trees | 55 advisories in 14 packages (0 critical, 28 high, 24 moderate, 3 low), none with an in-range fix. Every one is a transitive tree pinned by its parent (@babel/core, axios, baseline-browser-mapping, brace-expansion, browserslist, defu, esbuild, file-type, form-data, js-yaml, lodash, tmp, uuid, nanoid v3 copies under postcss/html-to-docx); no direct dependency of ours carries one. Re-run before each release. Recipe: `bun update` inside every workspace (the root run only touches root deps), then `bun run check` and a browser pass; better-auth verifies `auth-schema.ts` against its plugin models at startup (`SCHEMA_MISMATCH`), so a minor that adds columns needs `auth-schema.ts`, the `setup.ts` DDL and `ensureAuthSchemaColumns` in `auth.ts` together. | `bun.lock` |

Not findings, recorded so the next audit does not repeat them: document containers hold embedded `.eigenchat` comment threads and `media/` folders by design, and chats inside documents have their own `media/` ([ACL.md](ACL.md), [COMMENTS.md](COMMENTS.md)); a create or copy guard on container parents breaks that. Uploaded SVGs are rasterized for list thumbnails and avatars through sharp; the bundled librsvg ignores external references, verified.

No roadmap row tracks this file any more: the code work is done, and what remains above is a decision record plus the release-time `bun audit` recipe.
