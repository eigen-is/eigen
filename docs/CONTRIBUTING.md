# Contributing to Eigen

Eigen started as a solo project, to see how far one person could get building a self-hosted workspace from scratch. The answer: far, but not far enough. There is more to build than one person can do, and I'm looking for people who want to help. How it started: [Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/).

This page covers how you can help, how to run Eigen on your own computer, and where to start reading the code.

## Current state

Mail, Drive, Docs, Sheets, Slides, Vector, Stickies, Calendar, Contacts, Chat and an Admin panel all work, and so do real-time editing together, calendar and contacts sync with your phone (CalDAV and CardDAV), file sharing, export to Office and PDF, and two-factor sign-in.

But it's early, before version 1.0: there are rough edges, missing features, and design choices that could still go either way. If you like a project where your input really matters, this is one. The code changes week to week, so a pull request may need a rebase if the code around it changed; don't take it personally. Bug reports and ideas help as much as code, sometimes more. Security problems go through [SECURITY.md](../SECURITY.md), not a public issue.

## Ways to contribute

### Use it and break things

The most useful thing right now is to use Eigen and tell me what breaks. Install it, connect a calendar app, edit a doc with two people at once, upload strange files, and open an issue when something doesn't work.

### Adopt an app or area

Eigen has a dozen apps and a lot of shared code underneath, and I can't give all of it the same attention. If one interests you, I'd love to hand it over: look after it, improve it, sort its bug reports. What each app is working toward:

- **Mail**: everything people expect from Gmail or Outlook, in the browser and in any mail app on a phone or computer (IMAP and SMTP)
- **Drive**: a file store as easy as Google Drive or Dropbox, that people trust with their only copy, and that opens as a folder on a phone or computer (WebDAV)
- **Docs**: on par with Word and Google Docs, opening and saving Word files without losing anything
- **Sheets**: on par with Excel and Google Sheets, in formulas, charts and Excel files
- **Slides**: on par with PowerPoint and Google Slides, with PowerPoint files that open as they were made
- **Vector**: a drawing app as easy to use as Excalidraw
- **Stickies**: a board for notes and ideas, as easy as Miro or FigJam
- **Calendar and Contacts**: on par with Google Calendar and Contacts, syncing with every phone and calendar app (CalDAV and CardDAV)
- **Chat**: on par with Slack or Google Chat, for small teams
- **Admin and Space** (account settings): running an Eigen server and an account without needing the command line

Areas that cross apps need owners too: search, accessibility, phones and tablets, speed, security, copy and paste, tests and documentation.

The open work:

- **[ROADMAP.md](ROADMAP.md)**: every app and area, most important first, with **Before 0.5.0** at the top. What waits until after 1.0 is in [ROADMAP-POST-1.md](ROADMAP-POST-1.md).
- **The app backlogs**: [DOCS-TODO.md](DOCS-TODO.md), [SHEETS-TODO.md](SHEETS-TODO.md), [CHARTS-TODO.md](CHARTS-TODO.md) and [CANVAS-TODO.md](CANVAS-TODO.md) (Slides, Vector and Stickies).
- **[docs/proposals/](proposals/)**: designs for larger features not built yet, a good start if you want to own something bigger.

Write to [reinder@eigen.is](mailto:reinder@eigen.is), or open an issue that says "I want to work on X".

### Sponsor

Sponsor Eigen through [GitHub Sponsors](https://github.com/sponsors/eigen-is) or [Open Collective](https://opencollective.com/eigen); Open Collective is the better choice if you need an invoice. Questions? Write to [reinder@eigen.is](mailto:reinder@eigen.is).

### Issues first, pull requests for small fixes

The code changes quickly, so a feature pull request that waits a few days often needs a full rebase before I can review it, or was built on code that has since changed shape. So:

- **Small fixes** (bugs, typos, small UI changes): open a pull request. Always welcome.
- **New features or bigger changes**: open an **issue** first, describing the problem and what you'd like to build. Once we agree on the direction, go ahead.
- **Adopting a whole area** (an app such as Docs, Contacts or Calendar, or something like search or accessibility) helps the most: see [Adopt an app or area](#adopt-an-app-or-area) and email me at [reinder@eigen.is](mailto:reinder@eigen.is).

#### Pull request checklist (for small fixes)

1. Fork the repo, branch from `develop`, and open the pull request against `develop`.
2. Run `bun run check` before you push: the linter, the type check, the repo's own rules and the tests.
3. One change per pull request.
4. Link the issue it belongs to, if there is one.
5. Turn on "Allow edits from maintainers", so I can help finish it.

## Setting up your development environment

### What you need

- [Bun](https://bun.sh), at the version in `.bun-version`, which CI and the Docker image use too: `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`. `bun run serve` warns when your version differs.
- [Git](https://git-scm.com).
- Optional: WeasyPrint 68 or newer for PDF export, and `ffmpeg` for video thumbnails; everything else works without them. Install WeasyPrint with Homebrew (`brew install weasyprint`) or with pip in a virtual environment, with its `weasyprint` command on your PATH. `pip install --user` does not work: the Python the command starts must be able to run `python3 -I -c 'import weasyprint'`.

### Run it

```bash
git clone https://github.com/eigen-is/eigen.git
cd eigen
bun install
bun run serve
```

This starts the API on `localhost:8000` and each app on its own port, reloading on changes. The API prints a one-time link, `Finish the setup at http://localhost:3009/admin/#setup=…`: open it to create your admin account and choose where files are stored. Until setup is done, every restart prints a new link and the old one stops working. Your data goes to `data/` in the checkout.

To run one app instead of all of them:

```bash
bun run serve:mail     # Mail and the API
bun run serve:docs     # Docs and the API
# ... works for any app name
```

The API reads its settings from `.env.development`; put your own in `.env`, which git ignores.

In development Eigen sends no mail: the API logs each message's sender, recipient and subject. To read the mail itself, such as a sign-in code, run [Mailpit](https://mailpit.axllent.org) and add `SMTP_HOST=localhost` and `SMTP_PORT=1025` to `.env`.

### Useful commands

```bash
bun run lint           # Check lint and formatting (Biome)
bun run lint:fix       # Fix lint and formatting
bun run typecheck      # Type check every package
bun run test           # Run all tests
bun run check          # All of the above plus the repo's own rules: run it before a pull request
```

How `check` works, and how to run one test file: [TESTING.md](TESTING.md).

### When something is strange

- **A commit of part of a file.** Each commit runs Biome on the staged files (`.githooks/pre-commit`, which `bun install` sets up) and stages them again, whole, so a part staged with `git add -p` is lost. To commit part of a file, first make the file on disk match what you want to commit.
- **An error about a duplicate class after a dependency change.** `bun install` sometimes keeps old links and bundles two copies of one package. Run `rm -rf node_modules apps/*/node_modules packages/*/node_modules && bun install`.
- **A new import from `packages/lib` or `packages/ui` answers 500.** Vite reads the packages' import paths only at start: stop the dev servers, run `rm -rf node_modules/.vite`, and start them again.
- **A new Tailwind value such as `h-[3px]` doesn't apply.** Restart the dev server before you look for a bug in the component.
- **An old commit id doesn't exist.** The history was rewritten on 2026-07-06, so an id from before that date no longer works. Find the commit by its message instead.

### Eigen in Docker

You need Docker only to test mail delivery, IMAP, HTTPS or the Docker images themselves: Docker with Compose 2.20 or newer, and no Bun. Use a separate clone, never the checkout you work in, because the stack writes to that folder's `data/` and `.env.production`.

```bash
git clone /path/to/your/eigen eigen-docker
cd eigen-docker
cp docker-compose.dev.yml docker-compose.override.yml
./eigen setup --domain localhost --yes
```

This builds the images from the clone, downloading from npm, PyPI and Debian, and starts Caddy (the web server), the API, Postfix and Dovecot (the mail server), Unbound (DNS) and Mailpit. Setup prints the one-time link: open it and accept the certificate warning.

- Eigen runs at `https://localhost`.
- Mail addresses end in `@eigen.localhost`, because a sign-in address needs a dot in its domain.
- Mailpit, at `http://localhost:8025`, catches every mail Eigen sends.
- The API runs in development mode, and the mail server uses a self-signed certificate.

From then on, use the clone as a server admin would: `./eigen logs`, `./eigen status`, `./eigen restart`, `./eigen backup`. To try new commits, pull them into the clone and run `./eigen setup` again, which rebuilds; `./eigen update` does not work on a local build. Don't run your own `docker compose up` in the clone: `./eigen setup` and `./eigen restart` remove every container they didn't start.

To start over, stop it with `docker compose --env-file .env.production down`, move `data/` and `caddy-data/` elsewhere, and run `./eigen setup` again.

- The API runs as uid 1000, as in production.
- If the stack was off for more than 7 days, Caddy's local certificates have expired: `docker compose --env-file .env.production restart caddy` renews them.
- On a Mac, `sqlite3` on your machine can show old data from the container's databases. Read a database from inside the API container, with `docker compose --env-file .env.production exec eigen-api`.

Mail from outside reaches Eigen through Postfix, which calls the API inside Docker. To deliver a test message by hand, send it from inside the API container:

```bash
printf 'From: sender@example.com\nTo: you@eigen.localhost\nSubject: Test\n\nHello.\n' |
    docker compose --env-file .env.production exec -T eigen-api curl -s -X POST \
    -H "Content-Type: application/octet-stream" --data-binary @- \
    "http://localhost:8000/mail/deliver/you@eigen.localhost"
```

Replace `you@eigen.localhost` with your own address. To connect a mail or calendar app, follow [Set up Eigen Mail in a mail client](https://eigen.is/support/connect/mail-client) and [Set up Eigen Calendar in a calendar client](https://eigen.is/support/connect/calendar-client), with `localhost` as the server, and accept the certificate warning.

## Finding your way around

One repository holds all of Eigen: one API server in `apps/api/`, one folder per app in `apps/`, and shared code in `packages/`: `lib` (types, hooks, the API client), `ui` (components), `sheet` (the spreadsheet engine) and `math` (equations). Start here:

- **[AGENTS.md](../AGENTS.md)**: the rules every change follows, for people and AI assistants alike.
- **[docs/README.md](README.md)**: every doc, by topic. Most parts of Eigen have their own doc in `docs/`.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: where each kind of code lives, and the common mistakes.
- **[CODE-STANDARDS.md](CODE-STANDARDS.md)**: how the code is written.
- **[STORAGE.md](STORAGE.md)**: how each user's files and databases are stored.
- **[ACL.md](ACL.md)**: sharing and permissions.
- **[ROADMAP.md](ROADMAP.md)** and the backlogs it links: what is planned, most important first.

## Code style

The rules, and the checklist a change passes before review, are in [CODE-STANDARDS.md](CODE-STANDARDS.md).

### Commit messages

A commit message is read in `git log` by someone who doesn't know the code yet: plain, short English.

**Title**: `type(area): what changed`, at most 60 characters, lower case, no period.

- `type` is `feat` (something new a user can do), `fix` (a bug), `perf`, `refactor` (no behavior change), `test`, `docs` or `chore` (build, CI, dependencies).
- `area` is the app, package or domain: `sheets`, `docs`, `drive`, `mail`, `calendar`, `auth`, `backup`, `ui`, `lib`.
- Say what changed for the user or the caller, not which functions moved: `fix(sheets): undo keeps a coworker's edits`, `feat(drive): save an export straight to Drive`, `docs(roadmap): drop the done rows`.

**Body**, after a blank line, for anything beyond a one-line fix, written for someone who knows Eigen but hasn't followed this part:

- What was wrong or missing, as a user would notice it.
- What the change does about it, and why this way.
- Anything a reviewer should know: a limit, a trade-off, a follow-up.

Short sentences, everyday words, and a name explained the first time it appears. Leave out renamed symbols, measurements and test names: the diff, the tests and the domain doc hold those.

```
fix(drive): an overwrite no longer deletes a newer upload

When saving over a file failed halfway, the cleanup could remove the
bytes of a file someone uploaded a moment later. The cleanup now checks
that the bytes are still the ones it wrote before deleting them.
```

One change per commit: a title that needs "and" is two commits. No AI co-author trailers.

## License

Contributions are licensed under [MIT](../LICENSE.txt), like the rest of the project.

## Get in touch

Questions, ideas, or just want to say hi? Write to [reinder@eigen.is](mailto:reinder@eigen.is), or open an issue.
