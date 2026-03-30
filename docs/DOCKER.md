# Docker Deployment

> **This document is superseded.** See the new deployment docs:
>
> - **[Deployment Architecture](DEPLOYMENT.md)** — architecture, current state, remaining work
> - **[VPS Setup Guide](../docker/SETUP-GUIDE.md)** — step-by-step server deployment
> - **[Local Testing Guide](../docker/LOCAL-TESTING.md)** — run the full stack locally
>
> The old nginx-based Docker setup (Dockerfile, nginx.conf, deploy.sh) has been replaced by a
> Caddy-based setup with Postfix (email) and Dovecot (IMAP) support.
