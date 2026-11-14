## For your technical person

<!-- DRAFT: the owner rewrites this -->

Eigen runs on a server that someone has to look after. If that is not you, send this page to whoever runs the computers in your family or organization.

- Runs in Docker on one Linux server, amd64 or arm64, with 2 GB of RAM (4 GB recommended) and a domain that points at it.
- Installs with one line: `curl -fsSL https://eigen.is/install | sh`. Setup asks five questions and HTTPS is automatic.
- Speaks IMAP, SMTP, CalDAV, CardDAV and WebDAV, so the mail, calendar, contacts and file apps on your phone and computer work with it.
- Backs up the whole server every night while it runs, if you turn that on. Sending the backups off the server is up to you.
- Open source under the MIT license, and pre-1.0: until 1.0 a release can change how data is stored.

The step-by-step guide is in [Self-hosting](/support/self-hosting).
