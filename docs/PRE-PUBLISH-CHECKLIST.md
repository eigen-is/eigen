# Pre-Publish Checklist

Things still to do before making the Eigen repo public.

---

## Must do

_Nothing remaining._

## Nice to fix

- [ ] **`.github/` setup** — only a CI workflow exists. Consider adding issue templates, a PR template, and `CODEOWNERS`.

- [ ] **`.claude/` skills tracked in git** — `settings.json` and the `skills/` directory are committed. This is fine, but may surprise contributors. Add a brief note in the README or `CONTRIBUTING.md` explaining what it is.

---

## Done

| Item | Notes |
|------|-------|
| Login page fallback domain | Falls back to `window.location.hostname`; submit disabled while config loads |
| `index.php` / `.htaccess` removed | Static HTML generated per blog route at build time; Caddyfile updated |
| LICENSE file | MIT license added |
| `.claude/settings.local.json` | Removed from tracking, gitignored |
| `.env` with dev config | Renamed to `.env.development`, `.env` gitignored |
| `.env.eigen` | Removed from tracking, gitignored |
| Hardcoded `reinder@infi.nl` in waitlist | Now reads from server settings |
| CalDAV/IMAP accepted any password | Real verification via `verifyProtocolAuth()` |
| Dutch comment + hardcoded "Reinder" contact | Auto-add logic removed, configurable owner contact |
| Welcome email "From: Reinder Nijhoff" | Sender uses `orgName` from config |
| `.env.backup` / `.env.dev.local` in git history | Verified: only localhost dev URLs, no secrets |
