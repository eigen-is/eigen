# Pre-Publish Checklist

Everything that should be reviewed/fixed before making the Eigen repo public.

---

## 🔴 Critical — Must fix before publishing

### 1. No LICENSE file

The repo has no `LICENSE` file. The old README referenced MIT but the file was never created. Without a license, the
code is **not legally open source** — others cannot use, modify, or distribute it.

**Fix:** Create a `LICENSE` file in the repo root (MIT, AGPL-3.0, or whichever license you choose).

### 2. `.claude/settings.local.json` is tracked in git

This file contains your personal machine paths (`/Users/reinder/...`), auto-approved command history, and
`"bypassPermissions": "bypassPermissions"`. It leaks your local setup and should never be committed.

**File:** `.claude/settings.local.json`
**Fix:** Add `.claude/settings.local.json` to `.gitignore` and remove it from tracking:
```bash
echo '.claude/settings.local.json' >> .gitignore
git rm --cached .claude/settings.local.json
```

### 3. `.env` tracked in git with dev config

The `.env` file is tracked and contains localhost dev URLs. While not secret, tracked `.env` files are a red flag for
public repos — contributors may accidentally commit their own config changes, and it signals sloppy practices.

**File:** `.env`
**Fix:** Rename the tracked version to `.env.development` (or merge its content into `.env.example`), then add `.env`
to `.gitignore`. The `.gitignore` already excludes `.env` but git continues tracking files that were added before the
ignore rule.
```bash
git rm --cached .env
```

### 4. `.env.eigen` tracked — production config for eigen.is

Contains the production domain config for `eigen.is`. Not secret (no keys), but reveals your live infrastructure
layout and shouldn't be in a public repo.

**File:** `.env.eigen`
**Fix:** Remove from tracking and add to `.gitignore`:
```bash
git rm --cached .env.eigen
echo '.env.eigen' >> .gitignore
```

### 5. Hardcoded personal email: `reinder@infi.nl`

The waitlist signup notification is hardcoded to send to your personal email.

**File:** `apps/api/src/lib/space/waitlist.ts:15`
**Fix:** Make the recipient configurable via server settings (the TODO is already there). At minimum, replace with a
placeholder or read from config before publishing.

### 6. CalDAV and IMAP auth accept ANY password

Both authentication paths skip password verification entirely:

- **CalDAV:** `apps/api/src/lib/caldav/auth.ts:33` — comment says "SECURITY: password validation not yet implemented"
- **Internal (IMAP/Dovecot):** `apps/api/src/routes/internal.ts:14` — "For now: accept any password"

This is a **known security hole**. It's already documented in `DEPLOYMENT.md`, but for a public repo people will
deploy this. At minimum:

**Fix options:**
- Implement app-specific passwords before publishing
- Or add a loud `⚠️ WARNING` in the README, DEPLOYMENT.md, and in the setup wizard that CalDAV/IMAP auth is not
  production-safe
- Or disable the internal auth endpoint and CalDAV by default, requiring explicit opt-in

---

## 🟡 Should fix — Embarrassing or unprofessional

### 7. Dutch comment and hardcoded "Reinder" contact

Every new user gets "Reinder Nijhoff" auto-added to their contacts. The code has a Dutch comment:
`// add reinder, zodat het een beetje gezellig is` ("add reinder, so it's a bit cozy").

**File:** `apps/api/src/lib/contacts/contacts.ts:86-103`
**Fix:** Remove the auto-add-reinder logic entirely, or replace with a generic "welcome" contact mechanism.

### 8. Welcome email hardcoded as "From: Reinder Nijhoff"

The welcome email sent to new users has your name hardcoded in the `From` header and the email body is signed
"Reinder". It also embeds a large base64-encoded nyan.gif (500+ lines of base64).

**File:** `apps/api/src/lib/mail/welcome.ts:4` and throughout
**Fix:** Make the sender name configurable (from server settings or org admin name). Consider making the welcome
email a proper template rather than a raw MIME string with an embedded gif.

### 9. Git history contains `.env.backup` and `.env.dev.local`

These files were committed and later deleted. They remain in git history. Check if they ever contained secrets.

**Fix:** Verify these files never contained secrets. If they did, consider using `git filter-repo` or BFG Repo
Cleaner to scrub them from history before publishing.

### 10. `index.php` for eigen.is production SSR

The PHP file handles server-side rendering of OpenGraph meta tags for `eigen.is`. It hardcodes `eigen.is` URLs and
is specific to your production deployment, not useful for self-hosters.

**File:** `apps/index/index.php`
**Fix:** Either remove it or document it as the production SSR wrapper. Self-hosters won't use PHP.

---

## 🟢 Nice to fix — Polish

### 11. No `.github/` directory

No GitHub Actions workflows, issue templates, PR templates, CODEOWNERS, or FUNDING.yml. For a public repo, you'd
want at least:
- CI workflow (the project has `bun run check` — wire it up)
- Issue templates (bug report, feature request)
- A `CODEOWNERS` file
- Branch protection rules

### 12. `console.log` statements in production code

Several `console.log` calls exist in production server code. Some are intentional (startup, migration logging), but
consider whether they should use a proper logger:

- `apps/api/src/index.ts` — startup message (fine)
- `apps/api/src/lib/home/home.ts` — init/idle/reconnect logging
- `apps/api/src/lib/core/managed-database.ts` — migration and sync logging
- `apps/api/src/utils/websockets.ts` — ping failure logging
- `apps/api/src/lib/core/mailer.ts` — dev skip logging
- `apps/api/src/lib/mount/mount.ts` — crash recovery logging

**Assessment:** These are all reasonable operational logs. Not a blocker, but a structured logger would be cleaner.

### 13. Login page fallback domain

The login page falls back to `eigen.is` when no config is loaded:
```
values.email = `${...}@${config?.domain ?? 'eigen.is'}`;
```

**File:** `packages/ui/src/components/layout/pages/loginpage.tsx:48,102`
**Fix:** Use `localhost` or `example.com` as fallback, or ensure config is always loaded before rendering.

### 14. Blog post content

`apps/index/src/data/blog/2025-10-03-eigen-proof-of-concept.md` contains the blog post with personal references.
This is content for the `eigen.is` landing page, which is fine if the index app is meant to be the public site.
Just be aware it'll be in the repo.

### 15. `.claude/` directory in general

The `.claude/settings.json` (non-local) is tracked and enables plugins. This is fine (it's a project-level config),
but the `.claude/skills/code-reviewer/` directory with Python scripts might be surprising to contributors.

**Fix:** Consider whether you want to keep the Claude skills in the public repo. If yes, that's fine. If not,
`.gitignore` the entire `.claude/` directory.

### 16. Old commit messages in Dutch

Some older commits have Dutch messages (e.g., `filesystem geklooi`). These will be visible in git history. Not a
blocker, but worth knowing.

### 17. `node_modules/.old_modules-*` directory

Old module artifacts exist locally. Not tracked in git, so not a problem for the published repo — just note that
`node_modules` is correctly gitignored.

---

## Summary

| Priority | Count | Items |
|----------|-------|-------|
| 🔴 Critical | 6 | LICENSE, `.claude/settings.local.json`, `.env` files tracked, hardcoded email, auth bypass |
| 🟡 Should fix | 4 | Dutch comment + auto-add Reinder, welcome email, git history env files, `index.php` |
| 🟢 Nice to fix | 7 | GitHub CI, console.logs, login fallback, blog content, `.claude/`, commit messages, old modules |

### Minimum viable checklist before `git push`

1. [ ] Create `LICENSE` file
2. [ ] `git rm --cached .claude/settings.local.json .env .env.eigen` + update `.gitignore`
3. [ ] Remove or configure `reinder@infi.nl` in waitlist.ts
4. [ ] Remove auto-add-Reinder logic from contacts.ts
5. [ ] Make welcome email sender configurable
6. [ ] Add prominent security warning about CalDAV/IMAP auth bypass
7. [ ] Verify deleted `.env.backup` / `.env.dev.local` never contained secrets
