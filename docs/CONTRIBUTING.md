# Contributing to Eigen

Eigen started as a solo project. I wanted to see how far one person could get building a self-hosted workspace
from scratch. Turns out: pretty far, but not far enough. There's way more to build than one person can do, and
I'm looking for people who want to help.

If you're curious about how this started, I wrote about it here:
[Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/).

## Current state

A lot has happened since that first blog post. Mail, Drive, Docs, Sheets, Slides, Stickies, Calendar, Contacts,
Chat, and an Admin panel are all working. Real-time collaboration, CalDAV sync, file sharing, document export,
passkey login. It's a real thing now.

But it's still early. Rough edges everywhere, missing features, architecture decisions that could still go either
way. If you like working on something where your input actually matters, this is that kind of project.

I move fast on the codebase; things change week to week. A few things to keep in mind:

- **PRs may need rebasing** if the area you touched has changed. Don't take it personally.
- **Open an issue first** if you're planning something bigger. Saves everyone time.
- **Bug reports and ideas** are just as useful as code. Sometimes more.
- **Security issues** go through [SECURITY.md](../SECURITY.md), not public issues.

## Ways to contribute

### Use it and break things

Honestly, the most helpful thing right now is just using Eigen and telling me what's broken. Deploy it, connect
a CalDAV client, try editing a doc with two people, upload weird files. Then open an issue when something
doesn't work.

### Adopt an app or area

Eigen has 13 apps and a lot of infrastructure underneath. I can't give everything equal attention. If
something here interests you, I'd love to hand you the keys. Maintain it, improve it, triage bugs.

Every app needs work:

- **Mail**: threading, search, filters, attachment handling
- **Drive**: bulk operations, drag-and-drop improvements
- **Docs**: import from DOCX/Markdown, more export polish
- **Sheets**: import, export, sheet engine cleanup (forked from fortune-sheet)
- **Slides**: import, export to PPTX, more object types
- **Stickies**: labels, filters, archiving, assigning cards to people
- **Calendar**: recurring event edge cases, CalDAV compliance
- **Contacts**: import, export (vCard), CardDAV support, merge/deduplicate
- **Chat**: threads, search, richer formatting
- **Admin**: dashboards, usage stats, bulk user management
- **Space**: account settings, profile improvements

And cross-cutting concerns:

- **Search**: unified search across all apps (there's a detailed proposal in `docs/`)
- **IMAP/Dovecot**: edge cases, flag sync, mailbox management
- **CalDAV**: client compatibility (Apple Calendar, DAVx5, etc.)
- **Mobile/responsive**: works on desktop, needs love on smaller screens
- **Accessibility**: keyboard nav, screen readers, ARIA
- **Performance**: profiling, optimizations, offloading heavy work to workers
- **Security**: audits, penetration testing, hardening
- **Copy/paste**: from external sources into Docs/Sheets/Slides, and between apps
- **Testing**: more coverage, CI pipeline
- **Documentation**: tutorials, guides, API docs

Reach out at [reinder@eigen.is](mailto:reinder@eigen.is) or just open an issue saying "I want to work on X".

### Sponsor

If you or your company want to support the project, you can sponsor Eigen through
[GitHub Sponsors](https://github.com/sponsors/eigen-is) or
[Open Collective](https://opencollective.com/eigen). Open Collective is the better fit if you
need an invoice. Questions? Reach out at [reinder@eigen.is](mailto:reinder@eigen.is).

### Issues first, PRs for small fixes

I'd rather see feature ideas and larger changes as **issues**, not pull requests.

The codebase moves fast. Things change week to week. A PR for a new feature that sits for a few days often
needs a full rebase by the time I can review it — and sometimes the approach it was built on has already
shifted. That's frustrating for both of us.

A simple rule:

- **Small fixes** (bugs, typos, UI tweaks, one-liners): open a PR directly. Always welcome.
- **New features or bigger changes**: open an **issue** first. Describe the problem and what you'd like to
  build. If we agree on the direction, go for it — no wasted work.
- **Want to adopt a whole area** — a full app (say Docs, Contacts, or Calendar), or a cross-cutting concern
  like search or accessibility? That's the most valuable kind of contribution. See
  [Adopt an app or area](#adopt-an-app-or-area) above, and email me at
  [reinder@eigen.is](mailto:reinder@eigen.is) to talk.

#### PR checklist (for small fixes)

1. Fork the repo, create a branch
2. Run `bun run check` before pushing (lint, typecheck, repo guards and tests)
3. One concern per PR
4. Link to a related issue if there is one
5. Enable "Allow edits from maintainers" so I can help land your PR

## Setting up your development environment

### Prerequisites

- [Bun](https://bun.sh) at the version in `.bun-version`, the one CI and the Docker image run: `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`. `bun run serve` warns when yours differs.
- [Git](https://git-scm.com)
- Optional: `weasyprint` on your PATH for PDF export, `ffmpeg` for video thumbnails. Everything else works without them.

### Run it

```bash
git clone https://github.com/eigen-is/eigen.git
cd eigen
bun install
bun run serve
```

This starts the API on `localhost:8000` and every app on its own port, with hot reload. The API logs a one-time link, `Finish the setup at http://localhost:3009/admin/#setup=…`. Open it to create your admin account and choose where files are stored. Every restart before setup is done logs a fresh link and retires the previous one. Data lands in `data/` in the checkout.

Run one app instead of all of them:

```bash
bun run serve:mail     # Just Mail + API
bun run serve:docs     # Just Docs + API
# ... works for any app name
```

The API reads `.env.development`. Put your own overrides in `.env`, which git ignores.

Eigen sends no mail in development: the API logs each message's sender, recipient and subject instead. To read the mail itself, such as a 2FA or guest sign-in code, run [Mailpit](https://mailpit.axllent.org) and add `SMTP_HOST=localhost` and `SMTP_PORT=1025` to `.env`.

### Useful commands

```bash
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix lint + format
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + repo guards + tests (run this before submitting a PR)
```

Committing runs Biome on the staged files (`.githooks/pre-commit`, which `bun install` sets up). What `check` runs and how to run one test file: [TESTING.md](TESTING.md).

### Eigen in Docker

You need Docker only to test mail delivery, IMAP, HTTPS or the images themselves. It takes Docker with Compose 2.20 or newer, and no Bun. Use a clone of its own, never the checkout you develop in: the stack writes that folder's `data/` and `.env.production`.

```bash
git clone /path/to/your/eigen eigen-docker
cd eigen-docker
cp docker-compose.dev.yml docker-compose.override.yml
./eigen setup --domain localhost --yes
```

That builds the images from the clone and starts Caddy, the API, Postfix, Dovecot, Unbound and Mailpit. Setup prints the one-time link; open it and accept the certificate warning. Eigen runs at `https://localhost`. Addresses live on `eigen.localhost`, because a sign-in address needs a dot in its domain. Mailpit, at `http://localhost:8025`, catches every mail Eigen sends. The API runs in development mode, and Postfix and Dovecot use a self-signed certificate.

From then on, run the clone as an operator would: `./eigen logs`, `./eigen status`, `./eigen restart`, `./eigen backup`. To try new commits, commit them in your checkout and run `./eigen update` in the clone. Run no `docker compose up` of your own in it: that shares the launcher's project and `data/`, and `./eigen restart`, `backup` or `update` removes every container the launcher does not know.

To start fresh, stop it with `docker compose --env-file .env.production down`, move `data/` and `caddy-data/` aside, and run `./eigen setup` again.

Mail from outside reaches Eigen through Postfix, which calls the API on the Docker network; the web server hides that route. To deliver a message by hand, post it from inside the API container:

```bash
printf 'From: sender@example.com\nTo: you@eigen.localhost\nSubject: Test\n\nHello.\n' |
    docker compose --env-file .env.production exec -T eigen-api curl -s -X POST \
    -H "Content-Type: application/octet-stream" --data-binary @- \
    "http://localhost:8000/mail/deliver/you@eigen.localhost"
```

Replace `you@eigen.localhost` with your address. To connect a mail or calendar client, follow the [setup guide](../docker/SETUP-GUIDE.md#7-connect-a-mail-or-calendar-client-optional) with `localhost` as the server and accept the certificate warning.

## Finding your way around

It's a monorepo: one API server in `apps/api/`, frontend apps in `apps/*/`, and shared code in
`packages/lib/` (types, hooks, API client) and `packages/ui/` (components).

Start here:

- **[AGENTS.md](../AGENTS.md)** has the full project context and the critical rules. Written for
  humans and AI assistants alike.
- **[CODE-STANDARDS.md](CODE-STANDARDS.md)** covers code patterns and Eden Treaty usage; **[ARCHITECTURE.md](ARCHITECTURE.md)** has the backend and frontend location tables, the Drive layers and the pitfalls.
- **[STORAGE.md](STORAGE.md)** explains the per-user SQLite + file storage design.
- **[ACL.md](ACL.md)** describes sharing and permissions.

Most subsystems have their own doc in `docs/`.

## Code style (short version)

- English everywhere: code, comments, commits
- `type` over `interface`
- No `as any`. Fix the type at the source
- Theme tokens (`text-muted-foreground`), not hardcoded colors (`text-gray-500`)
- Data hooks go in `packages/lib/`, not in app components
- Error handling goes in hooks, not in UI code

Full version: [CODE-STANDARDS.md](CODE-STANDARDS.md).

## License

Contributions are licensed under [MIT](../LICENSE.txt), same as the rest of the project.

## Get in touch

Questions, ideas, or just want to say hi: [reinder@eigen.is](mailto:reinder@eigen.is), or open an issue.
