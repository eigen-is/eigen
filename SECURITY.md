# Security Policy

Eigen handles mail, files, documents, calendars, and other personal data. If you find a security issue,
please report it privately — not via a public GitHub issue or pull request.

## Reporting a vulnerability

Two ways, preferred first:

- **GitHub private vulnerability reporting**:
  [Report a vulnerability](https://github.com/eigen-is/eigen/security/advisories/new).
- **Email**: [reinder@eigen.is](mailto:reinder@eigen.is).

I'll do my best to acknowledge reports within 72 hours and share a rough timeline for a fix. Eigen is an
early-stage project without a dedicated security team, so response times may vary.

## Scope

In scope:

- The Eigen server (`apps/api/`) and any of its endpoints
- The shipped frontend apps (`apps/*`)
- The default Docker deployment (`docker/`, `docker-compose.yml`, `Caddyfile`)
- Shared packages (`packages/lib`, `packages/ui`, `packages/fortune-sheet`)

Out of scope:

- Issues that require physical access to the server, a compromised admin account, or a compromised user
  device
- Known issues in third-party dependencies that are already tracked upstream (please report those upstream)
- Self-inflicted misconfiguration (weak DKIM keys, exposed admin endpoints, disabled HTTPS, leaked secrets,
  etc.)
- Denial of service from a single authenticated user against their own account

## Supported versions

Eigen is still pre-1.0 and moves fast. Only the `main` branch is actively maintained. If you're running
something older, the first step is always to update.

## Disclosure

Once a fix is available, I'll credit reporters in the release notes unless you'd prefer to stay anonymous.
Please give a reasonable disclosure window (at least until a fix ships) before making details public.
