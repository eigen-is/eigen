# Pre-Publish Checklist

Everything that should be reviewed/fixed before making the Eigen repo public.

---

## Completed

| # | Item | Status |
|---|------|--------|
| 1 | **LICENSE file** — MIT license added | Done |
| 2 | **`.claude/settings.local.json` tracked** — removed from git, added to `.gitignore` | Done |
| 3 | **`.env` tracked with dev config** — renamed to `.env.development`, `.env` gitignored | Done |
| 4 | **`.env.eigen` tracked** — removed from tracking, gitignored | Done |
| 5 | **Hardcoded `reinder@infi.nl`** in waitlist — now reads from server settings | Done |
| 6 | **CalDAV/IMAP auth accepted any password** — real verification via `verifyProtocolAuth()` with app password + primary password fallback. Tests in `protocol-auth.test.ts` | Done |
| 7 | **Dutch comment + hardcoded "Reinder" contact** — auto-add logic removed, replaced with configurable owner contact | Done |
| 8 | **Welcome email hardcoded as "From: Reinder Nijhoff"** — sender uses orgName from config, nyan.gif removed | Done |

## Remaining

### Should verify before publishing

- [ ] **Git history contains `.env.backup` and `.env.dev.local`** — committed and later deleted. Verify they
  never contained secrets. If they did, use `git filter-repo` or BFG Repo Cleaner to scrub history

### Nice to fix

- [ ] **`.github/` setup** — CI workflow exists (`.github/workflows/check.yml`), but no issue templates, PR
  templates, CODEOWNERS, or FUNDING.yml
- [ ] **Login page fallback domain** — falls back to `eigen.is` when no config is loaded
  (`packages/ui/src/components/layout/pages/loginpage.tsx`). Use `localhost` or `example.com` instead
- [ ] **`index.php` for eigen.is SSR** — PHP file handles OpenGraph meta tags for production. Not useful for
  self-hosters. Either remove or document as production-only
- [ ] **`.claude/` directory** — project-level `settings.json` is fine, but the skills directory might
  surprise contributors. Consider gitignoring if unwanted in public repo
