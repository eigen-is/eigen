# Eigen

A self-hosted alternative to Google Workspace.

Mail, drive, docs, sheets, slides, drawings, stickies, calendar, contacts and chat.

Try the demo at [demo.eigen.is](https://demo.eigen.is). It is a shared workspace that resets every hour.

### Use your favorite apps

Works with the mail, calendar, contacts and file apps on your phone, Mac or PC. `IMAP` `SMTP` `CalDAV` `CardDAV` `WebDAV`

### Office compatible

Create and edit documents, spreadsheets and slides in your browser. Bring the files you have, and take them with you when you leave. `.docx` `.xlsx` `.pptx`

### Built for data sovereignty

MIT-licensed code running on your own server. Your mail, contacts and calendars stay in open formats, so there is no lock-in. `.eml` `.vcf` `.ics`

## Why

The name Eigen, is Dutch and German for "own". Given the power large tech companies hold over our data, I think a self-hosted European alternative is needed. [Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/) tells how it started. The help center has [a tour of the apps](https://eigen.is/support/getting-started/about-eigen).

Why not Nextcloud? Nextcloud is mature and has a large ecosystem. If you need something proven today, it is the safer choice. Eigen is one codebase: the apps share one API and one login, and several people can edit a doc, sheet, deck, drawing or board at the same time without a separate office server. It runs from one compose file on SQLite, with no PHP, MySQL or Redis.

## Status

Reality check: Eigen is pre-1.0 and I build it on my own, in my spare time, unpaid. The core works and improves fast, but I would not yet trust it with data you cannot afford to lose. For hobbyists, self-hosters and small teams comfortable with rough edges, it is ready to try.

Until 1.0 a release can change how data is stored. It then converts the data once or drops it. `./eigen update` makes a Full backup first, so `./eigen rollback` can go back.

The backups are yours to arrange. Turn on the nightly backup in Admin, under Settings, or run `./eigen backup`. Send the backups to a bucket off the server and [try a restore](https://eigen.is/support/self-hosting/back-up-and-restore#try-a-restore-without-moving).

The server's security is yours too: keep the host patched and lock down SSH.

What is planned is in [docs/ROADMAP.md](docs/ROADMAP.md), and what changed is in [CHANGELOG.md](CHANGELOG.md).

## Install on a server

You need a Linux server (amd64 or arm64) with 2 GB of RAM, 4 GB recommended, and 10 GB of disk plus room for your data. It needs Docker with the Docker Compose plugin 2.20 or newer, and a domain that points at it.

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script downloads the `eigen` command and runs `./eigen setup`. Setup asks five questions, starts Eigen and prints a link that finishes the setup in your browser. Everything runs in Docker: Caddy for HTTPS, the Eigen API, and Postfix, Dovecot and Unbound when Eigen hosts your mail. The same command updates, backs up and restores: `./eigen help`.

The step-by-step guide is the [Self-hosting](https://eigen.is/support/self-hosting/get-started) section of the help center. The technical reference is [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Development

You need [Bun](https://bun.sh) at the version in `.bun-version`, and Git.

```bash
git clone https://github.com/eigen-is/eigen.git
cd eigen
bun install
bun run serve
```

This starts the API on `localhost:8000` and each app on its own port. The API prints a one-time link that starts with `Finish the setup at`. Open it to create your admin account. Your data goes to `data/` in the checkout. Run `bun run check` before a pull request.

The rest is in [CONTRIBUTING.md](docs/CONTRIBUTING.md): the optional tools, running one app, mail in development, [Eigen in Docker](docs/CONTRIBUTING.md#eigen-in-docker) and how to contribute.

## How it is built

Each user and each team has its own folder on the server, with its own SQLite databases. [docs/STORAGE.md](docs/STORAGE.md) describes the layout and [docs/BACKUP.md](docs/BACKUP.md) the backups.

The server is [Bun](https://bun.sh) with [Elysia](https://elysiajs.com) and [Drizzle](https://orm.drizzle.team). The apps are React and TypeScript, and [Yjs](https://yjs.dev) carries the live editing.

[docs/README.md](docs/README.md) lists every doc by topic, [ARCHITECTURE.md](docs/ARCHITECTURE.md) says where each kind of code lives, [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) covers how it is written and [AGENTS.md](AGENTS.md) holds the rules every change follows.

## Security

Found a security issue? Do not open a public issue. [SECURITY.md](SECURITY.md) says how to report it privately.

## License

MIT, see [LICENSE.txt](LICENSE.txt). Eigen comes as it is, with no warranty.

## Contact

Questions or ideas? [reinder@eigen.is](mailto:reinder@eigen.is)
