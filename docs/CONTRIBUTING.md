# Contributing to Eigen

Eigen started as a solo project. I wanted to see how far one person could get building a self-hosted workspace
from scratch. Turns out: pretty far, but not far enough. There's way more to build than one person can do, and
I'm looking for people who want to help.

If you're curious about how this started, I wrote about it here:
[Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/).

## Current state

The basics work. You can send email, edit documents together, manage files, sync calendars with Thunderbird.
But it's early. Rough edges everywhere, missing features, architecture decisions that could still go either
way. If you like working on something where your input actually matters, this is that kind of project.

I move fast on the codebase; things change week to week. A few things to keep in mind:

- **PRs may need rebasing** if the area you touched has changed. Don't take it personally.
- **Open an issue first** if you're planning something bigger. Saves everyone time.
- **Bug reports and ideas** are just as useful as code. Sometimes more.

## Ways to contribute

### Use it and break things

Honestly, the most helpful thing right now is just using Eigen and telling me what's broken. Deploy it, connect
a CalDAV client, try editing a doc with two people, upload weird files. Then open an issue when something
doesn't work.

### Adopt an app or area

Eigen has 12 apps and a lot of infrastructure underneath. I can't give everything equal attention. If
something here interests you, I'd love to hand you the keys. Maintain it, improve it, triage bugs.

Every app needs work:

- **Mail**: threading, search, filters, attachment handling
- **Drive**: bulk operations, drag-and-drop improvements
- **Docs**: export quality, tables, import from DOCX/Markdown
- **Sheets**: import, export, the forked fortune-sheet engine cleanup
- **Slides**: import, export to PDF/PPTX, more object types
- **Stickies**: labels, filters, archiving, assigning cards to people
- **Calendar**: recurring event edge cases, CalDAV compliance
- **Contacts**: import, export (vCard), CardDAV support
- **Chat**: better integration, unread indicators, notifications
- **Admin**: settings UI, team management, dashboards

And cross-cutting concerns:

- **IMAP/Dovecot**: edge cases, flag sync, mailbox management
- **CalDAV**: client compatibility (Apple Calendar, DAVx5, etc.)
- **Mobile/responsive**: works on desktop, needs love on smaller screens
- **Accessibility**: keyboard nav, screen readers, ARIA
- **Performance**: profiling, optimizations, offloading heavy work to off-thread workers
- **Security**: audits, penetration testing, hardening
- **Copy/paste**: from external sources into Docs/Sheets/Slides, and between apps
- **Testing**: more coverage, CI pipeline
- **Documentation**: tutorials, guides, API docs

Reach out at [reinder@eigen.is](mailto:reinder@eigen.is) or just open an issue saying "I want to work on X".

### Sponsor

If you or your company want to support the project, reach out at
[reinder@eigen.is](mailto:reinder@eigen.is).

### Pull requests

Small fixes (bugs, typos, UI tweaks): just open a PR. For bigger changes, open an issue first.

1. Fork the repo, create a branch
2. Run `bun run check` before pushing (lint + typecheck + tests)
3. One concern per PR
4. Link to a related issue if there is one
5. Enable "Allow edits from maintainers" so I can help land your PR

## Setting up your development environment

### Prerequisites

- [Bun](https://bun.sh)
- [Git](https://git-scm.com)

### Option 1: Direct with Bun (recommended)

Fastest way to get going. Runs the API and frontend apps directly on your machine.

```bash
git clone https://github.com/eigen-foundation/eigen.git
cd eigen
bun install
bun run serve
```

Open `http://localhost:3009/admin` to run the setup wizard. It creates your admin account and initializes storage.

After that, run everything or just what you need:

```bash
bun run serve          # All apps + API
bun serve:mail         # Just Mail + API
bun serve:calendar     # Just Calendar + API
bun serve:docs         # Just Docs + API
# ... works for any app name
```

### Option 2: Docker (full stack)

For testing email, IMAP, HTTPS, and CalDAV you'll want the Docker setup. Four containers: Caddy, Eigen API,
Mailpit (catches outbound mail), and Dovecot (IMAP).

```bash
./scripts/generate-env.sh localhost > .env.production
sed -i '' 's/COOKIE_DOMAIN=.localhost/COOKIE_DOMAIN=localhost/' .env.production

set -a && source .env.production && set +a
bun install
bun run build:prod

docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production up -d
```

Open `https://localhost` (accept the self-signed certificate warning), then go to `/admin`.

See the [Local Testing Guide](../docker/LOCAL-TESTING.md) for detailed instructions on testing email, IMAP,
and CalDAV with the Docker setup.

### Useful commands

```bash
bun run serve          # All apps + API (dev mode with hot reload)
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix lint + format
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + test (run this before submitting a PR)
```

## Finding your way around

It's a monorepo: one API server in `apps/api/`, a dozen frontend apps in `apps/*/`, and shared code in
`packages/lib/` (types, hooks, API client) and `packages/ui/` (components).

Start here:

- **[AGENTS.md](../AGENTS.md)** has the full project context, architecture, and critical rules. Written for
  humans and AI assistants alike.
- **[CODE-STANDARDS.md](CODE-STANDARDS.md)** covers code patterns, the architecture table, Eden Treaty usage,
  and file types.
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
