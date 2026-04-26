# Proposal: Split Instance Host from Mail Domain (and Allow Multiple Mail Domains)

> **TLDR**: A single `DOMAIN` env var currently drives both *where the eigen UI/API lives* (e.g.
> `eigen.example.com`) and *what suffix users have on their email addresses* (e.g. `@example.com`).
> These are different concepts and should be separate config: `INSTANCE_HOST` (web origin) and
> `MAIL_DOMAIN` (email + autoconfig + DKIM). The split is mostly mechanical inside the API
> (`getDomain()` callsites split into two helpers), plus more substantive changes to Postfix
> (`virtual_mailbox_domains`), DKIM (per-domain key + selector), Caddy (vhost on the mail domain
> for `/.well-known/autoconfig`), and the setup wizard. **Recommended approach (Option B):** model
> mail domains as a list internally so a Phase 2 multi-domain rollout (the "use your own email
> domain" feature) is a config + DKIM-keygen change, not a schema rewrite. better-auth login is by
> email-string and is unaffected by either change.

## Goals

1. Allow the eigen instance to live at one host (e.g. `eigen.example.com`) while users have email
   addresses at a different domain (e.g. `alice@example.com`). DNS for the email domain points its
   MX at the eigen host; the eigen instance accepts mail for it.
2. Keep auth/login working unchanged — login is already by `(email, password)` and the email is just
   a string in the auth DB; no migration of existing users is required.
3. Lay groundwork for "use your own email domain" — a Phase 2 feature where one eigen instance
   accepts mail for several domains (e.g. `@example.com` *and* `@example.org`), each with its own
   DKIM key and DNS records.

## Non-goals

- **Per-user self-service domain registration.** Adding a domain is an instance-operator action,
  not a button users press. DKIM publication and MX records require DNS access only the domain
  owner has; automating that (ACME-style domain-control verification, automated TXT-record
  publication) is out of scope.
- **Multi-tenant isolation.** This proposal does not subdivide one instance into per-org tenants;
  one instance still has one auth DB and one set of users. Multi-domain mail is a vanity feature on
  top of the existing single-tenant model — different users can have addresses on different domains
  but they all share the same Eigen org/team graph.
- **Renaming a user's email after creation.** Better-auth supports it but it's a separate change;
  here we only worry about composing addresses correctly at creation time.

## Current Coupling

A single env var `DOMAIN` is read from at least four places that have nothing to do with each other:

| Layer | File | What `DOMAIN` is used for | Concept it really represents |
|---|---|---|---|
| Caddy reverse proxy | `Caddyfile` | vhost name; `www.${DOMAIN}` redirect | **Instance host** |
| Caddy autoconfig vhost | `Caddyfile` (template under same vhost) | `/.well-known/autoconfig/mail/config-v1.1.xml` | **Mail domain** (clients query *their email's* domain) |
| API server config | `apps/api/src/lib/config/server-config.ts:70` (`getDomain()`) | Returned to callers below | Both, depending on caller |
| Mailer default `From:` | `apps/api/src/lib/core/mailer.ts:54` (`noreply@${getDomain()}`) | Outbound system mail | **Mail domain** |
| Welcome email | `apps/api/src/lib/mail/welcome.ts` (`From: noreply@${domain}`, `Message-ID: <...@${domain}>`) | Same | **Mail domain** |
| Calendar invite footer | `apps/api/src/lib/calendar/imip.ts:40` (`https://${domain}` link) | URL in iMIP HTML | **Instance host** |
| Drive | `apps/api/src/lib/drive/drive.ts:607` | Domain-derived | (verify when implementing) |
| Setup wizard | `apps/admin/src/components/admin/setup-wizard.tsx` | `adminEmail = ${user}@${domain}` | **Mail domain** |
| Postfix | `docker/postfix/main.cf.template` | `myhostname`, `mydomain`, `virtual_mailbox_domains`, DKIM `Domain` | **Mail domain** (myhostname is its own thing — the SMTP banner) |
| Dovecot | `docker/dovecot/dovecot.conf` (cert path), `docker-compose.yml` (`DOMAIN` env) | TLS cert CN | **Instance host** (clients connect to the eigen host's IMAP port) |
| Autoconfig XML | `docker/caddy/autoconfig.xml` | IMAP/SMTP `<hostname>` | **Instance host** (where IMAP/SMTP actually listens) |
| docker-compose | `COOKIE_DOMAIN: .${DOMAIN}` | env var passed to API | **Dead config** — see below |
| `scripts/generate-env.sh` | Same | Same | Dead config |

### `COOKIE_DOMAIN` is dead

`docker-compose.yml`, `.env.example`, and `scripts/generate-env.sh` all set `COOKIE_DOMAIN=.${DOMAIN}`,
but nothing in `apps/api/src/` reads `process.env.COOKIE_DOMAIN`. better-auth has no
`advanced.cookies`/`crossSubDomainCookies` block in `auth.ts`, so it defaults to host-only cookies on
the API origin. This proposal removes the dead env var as a cleanup.

### Why login is unaffected

`emailAndPassword: { enabled: true }` in `apps/api/src/lib/auth/auth.ts`. The user's email is just a
string column in the better-auth `user` table; `getUserByEmail()` does a lowercased exact match
(`apps/api/src/lib/user/user.ts:8`). better-auth doesn't validate the email's domain against any
instance config. So *splitting* the instance host from the mail domain — and even *adding* a second
mail domain later — has zero impact on the auth flow. The only places "domain" leaks into the
user-facing flow are address-composition UIs (setup wizard, create-user dialog).

## Proposed Model

Two independent concepts:

```
INSTANCE_HOST   = eigen.example.com    # singular; web origin; cookies, baseURL, IMAP/SMTP TLS CN
MAIL_DOMAINS    = [example.com]        # list (length 1 to start); accepted-recipient domains, DKIM
                                       # PRIMARY_MAIL_DOMAIN := MAIL_DOMAINS[0]
                                       # used as the `noreply@` From: address default
```

**Backward compatibility for existing single-domain installs:** if `INSTANCE_HOST` is unset, fall
back to `DOMAIN`. If `MAIL_DOMAINS` is unset, fall back to `[DOMAIN]`. So an existing
`.env.production` keeps working untouched.

### API surface

Replace the single `getDomain()` with two helpers in `server-config.ts`:

```ts
// The web origin — used for URLs (calendar invite footer, baseURL, redirects).
export function getInstanceHost(): string;

// The list of accepted mail domains. Always non-empty after setup.
export function getMailDomains(): string[];

// Convenience: the domain used in the default `noreply@…` address.
export function getPrimaryMailDomain(): string;  // = getMailDomains()[0]
```

Each existing `getDomain()` callsite gets routed to the right one (see table above).

### Postfix

```cf
# main.cf.template — both vars come in via envsubst
myhostname = $INSTANCE_HOST
mydomain   = $PRIMARY_MAIL_DOMAIN
virtual_mailbox_domains = $MAIL_DOMAINS  # space-separated list
```

`myhostname` is the SMTP banner / HELO string — convention is the actual server hostname, so
`INSTANCE_HOST` is correct here. `virtual_mailbox_domains` is *which domains we accept mail for*,
which is the mail domain list. Postfix already accepts a space-separated list; the only change is
`envsubst` + the new env var.

### DKIM

Today `entrypoint.sh` generates one keypair (`/data/dkim/eigen.private`, selector `eigen`) for one
domain. For multi-domain, OpenDKIM uses `KeyTable` + `SigningTable`:

```
# /data/dkim/key.table
eigen._domainkey.example.com  example.com:eigen:/data/dkim/example.com.private
eigen._domainkey.example.org  example.org:eigen:/data/dkim/example.org.private

# /data/dkim/signing.table
*@example.com   eigen._domainkey.example.com
*@example.org   eigen._domainkey.example.org
```

Phase 1 ships with a one-element list. The `entrypoint.sh` loop generates one keypair per
`MAIL_DOMAINS` entry and prints the DNS TXT record for each (currently it prints once). The
operator publishes those TXT records at each domain's DNS provider.

### Caddy

The instance vhost stays as-is. Add a second vhost on each `MAIL_DOMAIN` entry that:

1. Serves `/.well-known/autoconfig/mail/config-v1.1.xml` (templated per domain — IMAP/SMTP host =
   `INSTANCE_HOST`, but the `<emailProvider id>` and `<domain>` reflect the per-mail-domain).
2. 308-redirects everything else to `https://${INSTANCE_HOST}/` so a user typing `example.com` in a
   browser lands on the app.

Caddy's snippet syntax handles this cleanly:

```caddyfile
(mail_vhost) {
    handle /.well-known/autoconfig/mail/config-v1.1.xml {
        root * /etc/caddy
        rewrite * /autoconfig.{args[0]}.xml
        templates
        header Content-Type "application/xml"
        file_server
    }
    handle {
        redir https://{$INSTANCE_HOST}{uri} 308
    }
}

# For each domain in MAIL_DOMAINS:
example.com { import mail_vhost example.com }
```

Templating per-domain autoconfig XML is the new bit. Either generate one file per domain at
container start, or use Caddy's `{{env}}` template and a single XML that takes the domain from a
query/path arg.

### Autoconfig XML

Currently `docker/caddy/autoconfig.xml` is a single file with `{{env "DOMAIN"}}` substituted in
both the `<emailProvider id>` / `<domain>` slots **and** the IMAP/SMTP `<hostname>` slot. This
conflates the two concepts; mail clients require:

- `<emailProvider id>` and `<domain>`: the email's domain (so they know "yes, this config is
  for me")
- `<hostname>` (IMAP and SMTP): the actual server they connect to — `INSTANCE_HOST`

After the split, the file uses `INSTANCE_HOST` for hostnames and the per-vhost domain for the
provider/domain identifiers.

### Setup wizard

`apps/admin/src/components/admin/setup-wizard.tsx` currently has a single "domain" field and
composes `adminEmail = ${adminUsername}@${domain}`. Phase 1 changes:

- Two fields: **Instance host** (where eigen runs) and **Mail domain** (default = same value, so
  existing single-domain users see no UX difference).
- Admin email is composed from the **mail domain**, not the instance host.

When `INSTANCE_HOST` is preset via env var, prefill it and lock it (the existing
`domainFromEnv` flag pattern). Same treatment for a preset `MAIL_DOMAIN`.

### Create-user dialog

`apps/admin/src/components/admin/create-user-dialog.tsx` (not yet read in detail — flag for
implementation review) presumably shares the username-then-`@domain`-suffix pattern. After the
split it uses the mail domain. For multi-domain (Phase 2), this becomes a
username + domain-dropdown.

### DNS the operator must set

For each `MAIL_DOMAIN` (where each entry is a domain the operator owns):

| Record | Value | Why |
|---|---|---|
| `MX example.com` | `eigen.example.com.` (the instance host) | Inbound mail routes to the eigen Postfix |
| `TXT example.com` | `v=spf1 mx -all` | SPF — receivers verify the sending IP |
| `TXT eigen._domainkey.example.com` | `v=DKIM1; k=rsa; p=…` (printed by `entrypoint.sh`) | DKIM signature verification |
| `TXT _dmarc.example.com` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@…` | DMARC alignment |
| `A/AAAA eigen.example.com` | server IP | Existing — for the instance host |

`INSTANCE_HOST` is *not* used as the email domain anywhere; if `eigen.example.com` doesn't have an
MX record, that's correct (no mail is sent to or accepted at `@eigen.example.com`). Some operators
may want a stub MX on the instance host pointing at itself for completeness, but it's not
required.

## Three Options for Multi-Domain Scope

| | Phase 1 only | Phase 1 + multi-domain data model | Phase 1 + Phase 2 (full) |
|---|---|---|---|
| **A** | `MAIL_DOMAIN: string`, single value everywhere. Multi-domain is a future redesign. | | |
| **B (recommended)** | | `MAIL_DOMAINS: string[]` internally + in Postfix template + in DKIM keygen loop, but setup wizard / env var ships a single value to start. Adding a second domain later = config + key generation, no schema change. | |
| **C** | | | Full multi-domain UI in admin (add/remove domains in browser, key generation flow with DNS-record display, autoconfig vhost provisioning), per-domain DKIM, autoconfig vhost on every domain. Per-user primary-domain selection. |

### Why B

- Postfix `virtual_mailbox_domains` is already a list; modeling our config as a list of length 1
  costs nothing today.
- The DKIM scaffolding (KeyTable / SigningTable) is identical for one domain or many; writing the
  loop now means Phase 2 just bumps the list length.
- The setup wizard is the visible UX surface; keeping that single-value (with a "you can add more
  later" affordance pointing at admin → server settings) means Phase 2 doesn't disrupt new-install
  flow.

### Phase 2 (out-of-scope for this proposal but worth sketching)

Adding a domain in admin UI requires:

1. POST to a new admin endpoint `POST /admin/mail-domains` with `{ domain }`.
2. Backend generates a DKIM keypair, writes it to `/data/dkim/${domain}.private`, updates
   `KeyTable` / `SigningTable`, reloads OpenDKIM, updates Postfix `virtual_mailbox_domains`,
   reloads Postfix.
3. Backend updates `MAIL_DOMAINS` in server config (persisted in `config.json`).
4. UI shows the DKIM TXT record + an "I've published this DNS record" checkbox; only after that
   does the domain become eligible for new user addresses.
5. Caddy needs to learn about the new vhost. Caddy's admin API supports dynamic route changes —
   alternatively, regenerate `Caddyfile` from a template + reload (kept simple).
6. DNS check helper: backend resolves `MX example.com` and `TXT eigen._domainkey.example.com` and
   shows green/red status next to each domain.

The whole thing is achievable but it's another spec.

## Test Plan (Phase 1)

1. **Single-domain regression.** With `DOMAIN=example.com` and `MAIL_DOMAINS` unset, behavior is
   identical to today: web at `example.com`, mail at `@example.com`.
2. **Split deployment.** With `INSTANCE_HOST=eigen.example.com` and `MAIL_DOMAINS=example.com`,
   verify:
   - Web works at `https://eigen.example.com/`.
   - `https://example.com/` redirects to `https://eigen.example.com/`.
   - `alice@example.com` can be created in the setup wizard.
   - Inbound mail to `alice@example.com` is delivered (Postfix accepts, eigen-deliver routes).
   - Outbound from `alice@example.com` is signed with DKIM key for `example.com`.
   - Mail client autoconfig at `https://example.com/.well-known/autoconfig/mail/config-v1.1.xml`
     returns IMAP/SMTP host = `eigen.example.com`.
   - IMAP/SMTP TLS cert presents `eigen.example.com` (matching what the autoconfig advertises).
   - Login at `https://eigen.example.com/` works with `alice@example.com` + password.
   - 2FA, app passwords, IMAP, CalDAV, all unchanged.
3. **`COOKIE_DOMAIN` removal.** Existing sessions on a real install survive a re-deploy without
   the env var (cookies were already host-only; nothing to invalidate).
4. **Calendar invite emails** (`imip.ts`) carry `https://eigen.example.com/` in the footer link,
   not `https://example.com/`.

## Open Questions

1. **Should Caddy redirect `example.com` → `eigen.example.com` for the web?** Recommended yes, but
   some operators may want `example.com` to be a separate marketing site they control. Make the
   redirect opt-out via env var (`MAIL_DOMAIN_REDIRECT=true|false`, default `true`).
2. **What happens to the existing `getDomain()` in `drive.ts:607`?** Need to check what it's used
   for during implementation; likely instance host (URL-shaped) but worth confirming.
3. **Should the setup wizard refuse mismatched domains?** E.g. if the user enters
   `INSTANCE_HOST=eigen.foo.com` and `MAIL_DOMAIN=bar.com`, that's a valid config but unusual.
   Suggest no validation — operators may want unrelated domains.
4. **`trustedOrigins` is hardcoded in `auth.ts` (incl. `https://eigen.is`).** Should this become
   `INSTANCE_HOST`-derived? Probably yes — drop the hardcoded entry and synthesise from env.
5. **DKIM key rotation.** Out of scope, but worth filing — currently keys live forever; for
   multi-domain we'll want a "rotate this domain's key" admin action eventually.

## Recommended Sequence

1. **Refactor `getDomain()`** into `getInstanceHost()` + `getMailDomains()` + `getPrimaryMailDomain()`
   in `server-config.ts`. Update each callsite per the table above. Falls back to `DOMAIN` if the
   new vars are unset.
2. **Postfix template** — switch to `INSTANCE_HOST` and `MAIL_DOMAINS` env vars; convert the DKIM
   keygen block to a loop over the list.
3. **Caddy vhost** for `MAIL_DOMAIN` entries (Phase 1 hardcodes the single entry; Phase 2 generates
   the Caddyfile).
4. **Autoconfig XML** — split per-domain.
5. **Setup wizard** — second field; address composition uses mail domain.
6. **Server config persistence** — `config.json` gains `instanceHost` and `mailDomains` fields.
7. **Cleanup** — remove `COOKIE_DOMAIN` from `docker-compose.yml`, `.env.example`,
   `scripts/generate-env.sh`. Drop the hardcoded `https://eigen.is` from `trustedOrigins`.
8. **Docs** — update `docs/DEPLOYMENT.md`, `docker/SETUP-GUIDE.md`, this proposal becomes the
   anchor reference.
