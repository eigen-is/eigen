# Security Policy

Eigen holds mail, files, documents, calendars and other personal data. If you find a security problem, please report it privately, not in a public GitHub issue or pull request.

## Reporting a problem

Two ways, the first one preferred:

- **GitHub private vulnerability reporting**: [Report a vulnerability](https://github.com/eigen-is/eigen/security/advisories/new).
- **Email**: [reinder@eigen.is](mailto:reinder@eigen.is).

I try to reply within a week, and to give a rough timeline for a fix once I've looked at it. Problems that put user data at risk come first; smaller ones can take longer. Eigen has one maintainer, so replies can be slower, for example around holidays. If you haven't heard back within two weeks, please send a reminder.

## What counts

In scope:

- The Eigen server (`apps/api/`) and all its endpoints
- The apps (`apps/*`)
- The standard Docker install (`docker/`, `docker-compose.yml`, `Caddyfile`, the `eigen` script)
- The shared packages (`packages/*`)

Out of scope:

- Problems that need physical access to the server, a hacked admin account or a hacked user device
- Known problems in other projects that Eigen uses, already reported to those projects (please report them there)
- A server set up unsafely by its admin, such as weak DKIM keys, open admin endpoints, HTTPS turned off or leaked secrets
- A signed-in user slowing down or blocking only their own account

## Supported versions

Eigen is before version 1.0 and changes fast. Fixes go into the newest release and the `main` branch only. If you run an older version, update first (`./eigen update`).

## Disclosure

Once a fix is out, I'll thank you by name in the release notes, unless you'd rather stay anonymous. Please keep the details private until the fix has shipped.
