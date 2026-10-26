# Contributing to Eigen

Eigen started as a solo project. I wanted to see how far one person could get building a self-hosted workspace from scratch. Turns out: pretty far, but not far enough. There's way more to build than one person can do, and I'm looking for people who want to help.

If you're curious about how this started, I wrote about it here: [Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/).

This page covers the ways you can help, how to get Eigen running on your own machine, and where to start reading the code.

## Current state

A lot has happened since that first blog post. Mail, Drive, Docs, Sheets, Slides, Vector, Stickies, Calendar, Contacts, Chat, and an Admin panel are all working. Real-time collaboration, CalDAV sync, file sharing, document export, passkey login. It's a real thing now.

But it's still early. Rough edges everywhere, missing features, architecture decisions that could still go either way. If you like working on something where your input actually matters, this is that kind of project.

I move fast on the codebase; things change week to week. A few things to keep in mind:

- **PRs may need rebasing** if the area you touched has changed. Don't take it personally.
- **Open an issue first** if you're planning something bigger. Saves everyone time.
- **Bug reports and ideas** are just as useful as code. Sometimes more.
- **Security issues** go through [SECURITY.md](../SECURITY.md), not public issues.

## Ways to contribute

### Use it and break things

Honestly, the most helpful thing right now is just using Eigen and telling me what's broken. Deploy it, connect a CalDAV client, try editing a doc with two people, upload weird files. Then open an issue when something doesn't work.

### Adopt an app or area

Eigen has a dozen apps and a lot of infrastructure underneath. I can't give everything equal attention. If something here interests you, I'd love to hand you the keys. Maintain it, improve it, triage bugs.

Every app needs work:

- **Mail**: threading, filters, attachment handling
- **Drive**: bulk operations, drag-and-drop improvements
- **Docs**: import from Markdown, more export polish
- **Sheets**: sheet engine cleanup (forked from fortune-sheet)
- **Slides**: more object types, and what the pptx import still leaves out (connector arrowheads, crop, SmartArt)
- **Stickies**: labels, filters, archiving
- **Calendar**: recurring event edge cases, CalDAV compliance
- **Contacts**: merge and deduplicate
- **Chat**: threads, search, richer formatting
- **Admin**: dashboards, usage stats, bulk user management
- **Space**: account settings, profile improvements

And cross-cutting concerns:

- **Search**: calendar, contacts and chat in the one search that covers mail and Drive ([SEARCH.md](SEARCH.md))
- **IMAP/Dovecot**: edge cases, flag sync, mailbox management
- **CalDAV**: client compatibility (Apple Calendar, DAVx5, etc.)
- **Mobile/responsive**: the open items in the Mobile row of [ROADMAP.md](ROADMAP.md), and testing on real devices
- **Accessibility**: keyboard nav, screen readers, ARIA
- **Performance**: profiling, optimizations, offloading heavy work to workers
- **Security**: audits, penetration testing, hardening
- **Copy/paste**: from external sources into Docs/Sheets/Slides, and between apps
- **Testing**: more coverage
- **Documentation**: tutorials, guides, API docs

Reach out at [reinder@eigen.is](mailto:reinder@eigen.is) or just open an issue saying "I want to work on X".

### Sponsor

If you or your company want to support the project, you can sponsor Eigen through [GitHub Sponsors](https://github.com/sponsors/eigen-is) or [Open Collective](https://opencollective.com/eigen). Open Collective is the better fit if you need an invoice. Questions? Reach out at [reinder@eigen.is](mailto:reinder@eigen.is).

### Issues first, PRs for small fixes

I'd rather see feature ideas and larger changes as **issues**, not pull requests.

The codebase moves fast. Things change week to week. A PR for a new feature that sits for a few days often needs a full rebase by the time I can review it, and sometimes the approach it was built on has already shifted. That's frustrating for both of us.

A simple rule:

- **Small fixes** (bugs, typos, UI tweaks, one-liners): open a PR directly. Always welcome.
- **New features or bigger changes**: open an **issue** first. Describe the problem and what you'd like to build. If we agree on the direction, go for it. No wasted work.
- **Want to adopt a whole area** (a full app, say Docs, Contacts, or Calendar, or a cross-cutting concern like search or accessibility)? That's the most valuable kind of contribution. See [Adopt an app or area](#adopt-an-app-or-area), and email me at [reinder@eigen.is](mailto:reinder@eigen.is) to talk.

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
- Optional: WeasyPrint 68 or later for PDF export, `ffmpeg` for video thumbnails. Everything else works without them. Install WeasyPrint from Homebrew (`brew install weasyprint`) or with pip in a venv, and put its `weasyprint` launcher on your PATH. The Python the launcher names must run `python3 -I -c 'import weasyprint'`, so `pip install --user` won't do.

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
bun run typecheck      # Type check all packages (bun check, the TypeScript port)
bun run test           # Run all tests
bun run check          # lint + typecheck + repo guards + tests (run this before submitting a PR)
```

Committing runs Biome on the staged files (`.githooks/pre-commit`, which `bun install` sets up). The hook re-stages every staged file whole from the working tree, so a hunk staged with `git add -p` is lost: to commit part of a file, make the working tree match the commit first. What `check` runs and how to run one test file: [TESTING.md](TESTING.md).

After a `bun.lock` dedupe, `bun install` can keep stale `node_modules/.bun` links, report no changes, and the build then bundles two copies of one package. A crash about a duplicate class after a dependency change goes away with `rm -rf node_modules apps/*/node_modules packages/*/node_modules && bun install`.

Vite reads the `exports` maps once, at start. After you add a `packages/lib` or `packages/ui` subpath, the new specifier answers 500 until you stop the vite servers, `rm -rf node_modules/.vite` and start them again; a hot reload never picks it up. A new Tailwind arbitrary value (`h-[3px]`) can fail to apply on a long-running dev server too, so restart it before you debug the component.

A commit SHA from before 2026-07-06, as older notes cite, predates a history rewrite. Find the commit by its subject, or map the SHA through `.git/filter-repo/commit-map` in a clone that has one.

### Eigen in Docker

You need Docker only to test mail delivery, IMAP, HTTPS or the images themselves. It takes Docker with Compose 2.20 or newer, and no Bun. Use a clone of its own, never the checkout you develop in: the stack writes that folder's `data/` and `.env.production`.

```bash
git clone /path/to/your/eigen eigen-docker
cd eigen-docker
cp docker-compose.dev.yml docker-compose.override.yml
./eigen setup --domain localhost --yes
```

That builds the images from the clone and starts Caddy, the API, Postfix, Dovecot, Unbound and Mailpit. The build fetches from the npm registry, PyPI and Debian's mirrors. Setup prints the one-time link; open it and accept the certificate warning. Eigen runs at `https://localhost`. Addresses live on `eigen.localhost`, because a sign-in address needs a dot in its domain. Mailpit, at `http://localhost:8025`, catches every mail Eigen sends. The API runs in development mode, and Postfix and Dovecot use a self-signed certificate.

From then on, run the clone as an operator would: `./eigen logs`, `./eigen status`, `./eigen restart`, `./eigen backup`. To try new commits, pull them in the clone and run `./eigen setup` again, which rebuilds; `./eigen update` refuses on a local build. Run no `docker compose up` of your own in it: that shares the launcher's project and `data/`, and every `./eigen` command that starts Eigen, like `setup` and `restart`, removes every container of a service it does not run.

To start fresh, stop it with `docker compose --env-file .env.production down`, move `data/` and `caddy-data/` aside, and run `./eigen setup` again.

When the stack was down for more than 7 days, Caddy's local CA has expired, and `docker compose --env-file .env.production restart caddy` renews it. On a Mac, `sqlite3` on the host lags the container's writes over the bind mount, so read a database from inside the API container with `docker compose --env-file .env.production exec eigen-api`.

Mail from outside reaches Eigen through Postfix, which calls the API on the Docker network; the web server hides that route. To deliver a message by hand, post it from inside the API container:

```bash
printf 'From: sender@example.com\nTo: you@eigen.localhost\nSubject: Test\n\nHello.\n' |
    docker compose --env-file .env.production exec -T eigen-api curl -s -X POST \
    -H "Content-Type: application/octet-stream" --data-binary @- \
    "http://localhost:8000/mail/deliver/you@eigen.localhost"
```

Replace `you@eigen.localhost` with your address. To connect a mail or calendar client, follow [Set up Eigen Mail in a mail client](https://eigen.is/support/connect/mail-client) and [Set up Eigen Calendar in a calendar client](https://eigen.is/support/connect/calendar-client) with `localhost` as the server and accept the certificate warning.

## Finding your way around

It's a monorepo: one API server in `apps/api/`, frontend apps in `apps/*/`, and shared code in `packages/lib/` (types, hooks, API client) and `packages/ui/` (components).

Start here:

- **[AGENTS.md](../AGENTS.md)** has the critical rules every change follows. Written for humans and AI assistants alike.
- **[docs/README.md](README.md)** indexes every doc by domain.
- **[CODE-STANDARDS.md](CODE-STANDARDS.md)** covers code patterns and Eden Treaty usage; **[ARCHITECTURE.md](ARCHITECTURE.md)** has the backend and frontend location tables, the Drive layers and the pitfalls.
- **[STORAGE.md](STORAGE.md)** explains the per-user SQLite + file storage design.
- **[ACL.md](ACL.md)** describes sharing and permissions.

Most subsystems have their own doc in `docs/`.

## Code style

The rules, and the checklist a change passes before review, are in [CODE-STANDARDS.md](CODE-STANDARDS.md).

## License

Contributions are licensed under [MIT](../LICENSE.txt), same as the rest of the project.

## Get in touch

Questions, ideas, or just want to say hi: [reinder@eigen.is](mailto:reinder@eigen.is), or open an issue.
