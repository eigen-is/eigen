# Proposal: Single Sign-On (SSO) for organizations

This proposal lets an organization's people sign in to Eigen with the identity provider the organization already runs, instead of a separate Eigen password.

**Status:** not built: `@better-auth/sso` is not installed. Brought in line with the owner's identity rulings of 27 November 2026. For how Eigen names a person, [PROPOSAL_ACCOUNT_IDENTITY.md](PROPOSAL_ACCOUNT_IDENTITY.md) is the reference, and where the two differ it wins ([section 5](PROPOSAL_ACCOUNT_IDENTITY.md#5-sso-how-it-fits-and-the-order-of-work) is about SSO). The identity change lands first, in 0.5.0. SSO starts after it and ships in a 0.5.x. Nothing of SSO is built on the email model. Discussed in [issue #16](https://github.com/eigen-is/eigen/issues/16). [ROADMAP-POST-1.md](../ROADMAP-POST-1.md) keeps its row, and [PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](PROPOSAL_EXTERNAL_MAIL_PROVIDER.md) builds on it.

> **TLDR**: Let an organization that already runs an identity provider (Keycloak, Authentik,
> Microsoft Entra, Okta, Google Workspace, Zitadel…) log into Eigen with it, instead of a separate
> Eigen password. Use better-auth's `sso` plugin (`@better-auth/sso`, versioned in lockstep with
> the installed `better-auth@1.7.14`), which lets providers be **registered at runtime** — so
> configuration lives in the admin app, not in env files. Providers map by **email domain** and
> **JIT-provision** users on first login. The login is bound to the provider and its `sub`, not
> to the address, and the provider's domain becomes a member domain. Almost everything is plugin wiring: org membership and
> share reconciliation already run from the `user.create.after` hook for *any* new user, and the
> Home/maildir/default-mount bootstrap is **already lazy** (first `getHome()` call), so an SSO user
> lands with a working workspace with **zero new provisioning code** (verified against code
> 2026-07-06 — see § Provisioning). The real work is: the schema migration, the owner-only CRUD +
> UI, the login-page button, the guards in `user.validateUserInfo`, closing better-auth's own
> `/sso/register` endpoint with `providersLimit`, and pointing SSO
> users (who are passwordless) at **app passwords** for mail/calendar/file clients. **v1 is
> OIDC-only**; SAML is supported by the same plugin and deferred until an org actually asks.
> Eigen-as-an-identity-provider, SCIM, and group→team sync are explicit non-goals.

## Goals

1. An admin can register their organization's OIDC IdP and have staff sign in with it.
2. Users from a configured **email domain** are routed to the right provider and provisioned on
   first login (JIT), with the same org membership + Home bootstrap every Eigen user gets.
3. SSO coexists with email/password: a deployment can be password-only or mixed; SSO-only is a
   deferred toggle.
4. Configuration is done in the **admin app** — no env editing, no server restart to add an IdP.
5. Reuse the existing auth stack — the `user.create.after` hook (org membership + share
   reconciliation), lazy `getHome()` provisioning, and the app-password (`apiKey`) mechanism for
   protocol clients.

## Non-goals

- **SAML in v1.** `@better-auth/sso` speaks SAML 2.0 (`samlConfig`: `issuer`, `entryPoint`,
  `cert`, SP metadata), so it's a phase-2 admin-form + test-harness job, not a redesign. Every
  IdP in the target list speaks OIDC; ship OIDC, add SAML when a concrete org needs it.
- **Eigen as an identity provider** for *other* apps (better-auth's `oidcProvider` plugin). The
  inverse feature; separate proposal if wanted.
- **SCIM / automated de-provisioning.** Disabling a user when the IdP removes them is a follow-up.
  v1 provisions on login; removal stays a manual admin action.
- **Group / claim → team mapping.** v1 gives every SSO user plain `member` in the default org.
  Mapping IdP groups onto Eigen teams is a richer follow-up (`organizationProvisioning.getRole`
  is the seam for it).
- **Consumer social login** (personal Google/GitHub/Apple). That's `socialProviders` — trivial to add later, but a different audience from "my organization's SSO". **One exception worth weighing before building any of this:** a self-hoster whose users all live on one Google Workspace or Microsoft 365 domain needs none of the runtime-registration machinery. `socialProviders` plus a domain check on the `hd` / tenant claim gives them the same sign-in with no admin CRUD, no provider table and no auth-schema migration. That is the common self-hosting shape, and it is phase 0 of [PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](PROPOSAL_EXTERNAL_MAIL_PROVIDER.md); this proposal's full plugin route is for deployments with an IdP that isn't one of those two. `socialProviders` is also the only route that can request the provider's mail scopes and keep the resulting tokens, which the IMAP mail backend in that proposal depends on.
- **Changing the collaboration or data model.** This touches authentication only.

## Why now — foundation verified (2026-07-06)

The auth foundation already fits; all of the following was re-verified against source:

- `../../apps/api/src/lib/auth/auth.ts` runs better-auth with the `organization` (teams enabled),
  `admin`, `twoFactor` and `apiKey` plugins, and a `databaseHooks.user.create.after` hook that
  adds any newly-created non-guest user to the default org (`ensureDefaultOrgMembership`, role
  `member`) and reconciles pending shares (`reconcileShares` in
  `../../apps/api/src/lib/share/reconciliation.ts`). A JIT-created SSO user goes through the same
  create path, so org membership and share reconciliation come for free.
- **Home provisioning is lazy, not waitlist-driven.** The waitlist (`../../apps/api/src/lib/waitlist/waitlist.ts`, `registerFromInvite`) only calls `auth.api.createUser` and signs the user in — it creates *no* Home. The Home, maildir, default mount and quota all materialize on the first `getHome(userId)` (`../../apps/api/src/lib/home/get-home.ts` → `Home.init()`, where `UserHome.loadSettings` seeds the default mount from server settings, then `Drive.init()` + `Mail.init()` etc.; quotas are resolved at read time by `resolveUserQuotas`). `getHome` is idempotent and concurrent-safe (`createAsyncSingleton` + install-race retry loop). An SSO user is therefore provisioned exactly like a waitlist user: on their first authenticated request.
- `verifyProtocolAuth` (`../../apps/api/src/lib/auth/protocol-auth.ts`) already checks the **app
  password (API key) first** and only then falls back to `signInEmail` — so IMAP/CalDAV/WebDAV
  already work for passwordless accounts that hold an app password.
- `@better-auth/sso` (checked against current better-auth docs): providers are stored in the auth
  DB and **registered at runtime** via `auth.api.registerSSOProvider` / `POST /auth/sso/register`,
  keyed by `providerId` + `issuer` + `domain`; OIDC discovery is fetched automatically from
  `{issuer}/.well-known/openid-configuration`, so `oidcConfig` needs only
  `clientId`/`clientSecret`. Plugin options: `provisionUser`, `provisionUserOnEveryLogin`,
  `organizationProvisioning: { disabled, defaultRole, getRole }`, `defaultSSO`. The package is
  **not yet installed** — add `@better-auth/sso` at the installed better-auth version, 1.7.14
  (same lockstep versioning as the already-used `@better-auth/api-key@1.7.14`). Implementer note: the public docs track the latest
  release; confirm the exact option surface against the pinned typings when wiring. Eigen does
  not let the plugin fetch the discovery document itself: its own owner-only route reads it (see
  § Reading the provider's settings page).
- `user.validateUserInfo` exists in the installed better-auth 1.7.14 (typed in
  `@better-auth/core`, called from `oauth2/link-account` and the internal adapter). It runs
  before the user or the login is written, with the action `create-user`, `link-account` or
  `sign-in`, and the method, `sso-oidc` for an OIDC SSO login with `source.sso.providerId`. It
  fails closed: a hook that throws refuses the login. That the SSO plugin passes its logins
  through it is the contributor's reading of the plugin in issue #16, to verify once the plugin
  is installed.
- `account.accountLinking.requireLocalEmailVerified` defaults to `true` in 1.7.14. It is marked
  deprecated there: the next minor makes the check unconditional.

**Why the plugin and not `genericOAuth`.** `genericOAuth` has fixed providers and no routing by
email domain, so Eigen would write that itself. The cost of the plugin is its SAML code, which
loads at startup even when only OIDC is used.

So the login path is plugin wiring plus admin/login UI. No Home-bootstrap extraction is needed —
an earlier draft of this proposal assumed the waitlist bootstrapped Homes; it does not.

## Architecture

### Plugin

Add to the `plugins: [...]` array in `../../apps/api/src/lib/auth/auth.ts`:

```typescript
import { sso } from '@better-auth/sso';

sso({
    // Org membership is handled by the existing user.create.after hook, which fires for
    // JIT-created SSO users too. Keep the plugin's own org provisioning OFF so the two
    // paths can't both call addMember for one user.
    organizationProvisioning: { disabled: true },
    // Only the owner may register a provider. 0 refuses /sso/register for everyone else.
    providersLimit: (user) => (isOwner(user) ? 10 : 0),
    // The provider's domain is proven with a DNS TXT record before any link.
    domainVerification: { enabled: true },
}),
```

`providersLimit` as a function and `domainVerification` come from the owner's answer and the
contributor's reading of the plugin in issue #16. Both are to verify against the plugin's typings
once it is installed. `isOwner` stands for the owner check; today's helper is `requireOwner` in
`../../apps/api/src/lib/auth/access.ts`.

No `provisionUser` hook is needed for v1: Home creation is lazy (see § Provisioning). Eigen has a
single default org (created at setup), so per-provider `organizationId` linking is also unnecessary.

### Where configuration lives

One surface: **Admin app → Authentication → SSO** (new page). List / add / remove providers, each
`{ providerId, issuer, domain, clientId, clientSecret }`. Backed by three owner-only API routes
that call `auth.api.registerSSOProvider` and read the plugin's provider table. Only the owner
sees the page. The demo-mode block on auth calls stays. Secrets are write-only
in API responses (return a placeholder, never echo the client secret).

- **A provider's issuer cannot be edited.** The login is bound to the provider. To change the
  issuer, delete the provider and add it again.
- **A provider's domain becomes a member domain** ([identity proposal, 3.2](PROPOSAL_ACCOUNT_IDENTITY.md#32-members-and-guests-never-overlap)).
  A guest can never have an address on it, so an SSO login never touches a guest.
- **Adding a provider for a domain that has guests.** The page lists those guests. The owner
  confirms, and they are deleted, with the share registry rows for their addresses. Their old
  shares and messages stay under the plain address and belong to nobody.
- **The provider's domain is proven with a DNS record** through the plugin's
  `domainVerification`. The owner sets it once. Until then the plugin links no existing account.

This matches Eigen's existing split: identity written once at setup (`server-config.ts`) vs.
runtime-adjustable settings (`server-settings.ts`). SSO providers are runtime-adjustable, so they
live in the DB and are managed from admin — no redeploy to add an IdP. A setup-wizard step is
deferred (see § What's deferred) — the admin page covers the need.

**Close the plugin's own endpoint.** better-auth mounts `POST /auth/sso/register` itself. The
plugin's `providersLimit`, as a function that gives 0 to everyone but the owner, refuses it in
one place, Eigen's own routes included. No path guard in `../../apps/api/src/routes/auth.ts`.
The plugin's update and delete routes only allow whoever registered a provider without an
organization, which is the owner (to verify in the plugin). Registration must never be reachable
by a member or an admin (better-auth also 422s on `providerId` collisions with social providers /
reserved ids — surface that error in the admin UI).

### Reading the provider's settings page

Eigen's own owner-only route reads the provider's settings page (its discovery document), not
the plugin. It accepts only public addresses and saves the addresses it finds directly, so
`trustedOrigins` stays as it is. This is the first place where the server fetches an address a
person typed, so the check is complete:

- every address the name resolves to is checked;
- the connection goes to the checked address;
- no redirect is followed;
- there is a timeout and a size limit.

A setting in the server's environment allows a provider on a private network. It is off by
default. Development and the tests (the in-process OIDC stub in § Testing) need it, and so does a
self-hoster with a login system on a home network.

### Provisioning — already covered, by design

JIT provisioning needs, and gets, nothing new:

1. **Auth user** — created by the plugin on first SSO login.
2. **Org membership + share reconciliation** — the `user.create.after` hook fires for the
   JIT-created user (their role is the default `user`, so the guest early-return doesn't trip).
3. **Home / maildir / default mount / quota** — created lazily and idempotently on the user's
   first authenticated request via `getHome()`, identical to every waitlist-onboarded user today.

The "SSO bypasses the waitlist" concern from the roadmap resolves to: the waitlist is a *signup
gate*, not a provisioning step. For SSO users the signup gate is the IdP plus the provider's
`domain` match — an email domain with no registered provider cannot SSO in. That is the intended
enterprise behavior.

**An account that SSO creates is marked "may use SSO" at that moment** (`emailVerified`, see §
Account linking). Otherwise, after the owner deletes a provider and adds it again, those members
cannot sign in until an admin marks each one.

**Mail-domain caveat (deployment guidance, document it):** waitlist signup constructs addresses
as `username@mailDomain`; an SSO user keeps their IdP email (e.g. `alice@acme.com`), which is on
the provider's domain, a member domain. Shares, chats, comments and the rest name the member by
the permanent id, so they work whatever the address is. Mail is delivered by address, and the
mail and calendar apps sign in with it. The account only *receives external mail* if the
instance actually handles mail for that domain. Recommend in the
admin UI help text: the provider `domain` should equal the instance's mail domain for a full
mailbox experience.

### Protocol auth — SSO users use app passwords

`verifyProtocolAuth` already tries the app password first, then falls back to the primary
password. SSO users have no primary password, so the fallback can never succeed for them — which
is fine: IMAP, CalDAV and WebDAV clients (Thunderbird, iOS Mail, Apple Calendar) authenticate with
an **app password**, exactly as they do against Google/Microsoft SSO accounts. No protocol-auth
redesign is needed; it works today.

Two small items:

- **Make app-password creation prominent** for passwordless users (settings page + the "connect a
  mail/calendar client" help) — it's their only path to protocol clients.
- Optional hardening: skip the doomed `signInEmail` fallback when the account has no `credential`
  row in the `account` table (`../../apps/api/auth-schema.ts`). One extra read per failed protocol auth
  saved; do it only if it stays a two-line check.

### Account linking, sessions, mixed mode

- **Mixed mode**: `emailAndPassword.enabled` stays `true`. The login page shows SSO alongside the
  password form. An instance-wide SSO-only toggle is deferred.
- **The login is bound to the provider and its `sub`**, not to the address. The `sub` is the
  fixed id the provider gives each person. better-auth stores it as `accountId` on the `account`
  row (`../../apps/api/auth-schema.ts`) and looks it up first (`handleOAuthUserInfo`). So:
  provider + `sub` → person id.
- **Account linking: only a marked account, at a proven domain.** When the `sub` is unknown,
  better-auth looks for an account with the same address and links to it. Eigen keeps the
  default `requireLocalEmailVerified: true`, so only an account with `emailVerified` set can be
  linked. Eigen makes every member with `emailVerified: false`, and members use the field for
  nothing else. So:
  - An admin marks each account **"may use SSO"** in the Admin app. That sets `emailVerified`.
    One button marks all current members.
  - The provider's domain must be proven with the DNS record (`domainVerification`, see § Where
    configuration lives). Without it the plugin links nothing, marked or not.
  - An account that SSO creates is marked at that moment.
  - An account nobody marked cannot be taken over. When something is forgotten, the result is
    "cannot sign in", not "wrong person signed in".
- **The guards live in `user.validateUserInfo`.** It runs before the user or the login is
  written, and at every sign-in. It refuses:
  - an address that is not on the provider's own domain;
  - a second `sub` from the same provider for one account (same address, other `sub`, is a new
    person);
  - the owner or an admin.
- **An admin never signs in with SSO, also after a promotion.** The hook runs at every sign-in,
  so a member who used SSO and is later made an admin is refused at the next one. The Admin app
  says so at the promotion and asks for a password: "This person signs in with SSO. As an admin
  they need a password. Set one now."
- **`overrideUserInfo` stays off** in v1. It would copy the provider's address over
  `user.email` at each sign-in.
- **An address change is refused.** `/admin/update-user` with a new address is refused in
  `user.update.before` until the address-change feature exists, and the admin role loses its
  `set-email` right until then.
- **The honest limit.** When a guard refuses a link, the new person cannot sign in at all,
  because the address is taken. An admin must first delete the old account.
- **Sessions/sign-out**: an SSO login produces a normal better-auth session cookie; sign-out
  revokes the Eigen session only. No IdP single-logout in v1.
- **2FA**: Eigen's `twoFactor` plugin applies to password sign-ins; SSO users rely on the IdP's
  MFA. A per-provider "require Eigen 2FA anyway" policy is deferred. Requiring 2FA for the owner
  and admins, who always sign in with a password, is a separate item for the Security pack of
  [ROADMAP.md](../ROADMAP.md). It is not part of SSO.

## Frozen-format

The `sso` plugin adds a provider table to the auth database (`users3.db`). `domainVerification`
adds one column to it, `domain_verified` by the contributor's reading (to verify). The identity
change of 0.5.0 also adds a table there, the former members; SSO lands after it. This is **additive**,
but Eigen is live, so treat it as a production schema change:

1. Regenerate the Drizzle schema file — which lives at **`../../apps/api/auth-schema.ts`** (repo path;
   not under `../../src`) — with better-auth's CLI (`bunx @better-auth/cli generate`) after adding the
   plugin, and diff it: only new tables, no changes to existing columns.
2. Register the new table(s) in **both** schema maps in `auth.ts` — the `drizzleAdapter(...)`
   schema and `getAuthDrizzleDb()` — they are intentionally separate instances.
3. Create the table in the two places that give `users3.db` its layout. That database has no
   versioned migrations and a release install runs no `drizzle-kit push`. A new server gets its auth
   tables from setup's own `CREATE TABLE IF NOT EXISTS` statements (`../../apps/api/src/lib/setup/setup.ts`).
   A running server gets what its tables lack from `ensureAuthSchemaColumns`
   (`../../apps/api/src/lib/auth/auth-schema-columns.ts`), which runs at start, before better-auth
   reads the database. Today that function only adds columns and skips a table that does not exist,
   so it learns to create a missing table, and its header comment says so (the owner asked for that
   in issue #16).

No Yjs or drive-format impact.

## Backend / frontend pieces

| Layer | File | Change |
|---|---|---|
| Dependency | `../../apps/api/package.json` | Add `@better-auth/sso` at the installed better-auth version, 1.7.14 (lockstep with `better-auth`). |
| Auth config | `../../apps/api/src/lib/auth/auth.ts` | Add `sso({ organizationProvisioning: { disabled: true }, providersLimit, domainVerification })` to `plugins`; the SSO guards in `user.validateUserInfo`; add new tables to both Drizzle schema maps. |
| Auth schema | `../../apps/api/auth-schema.ts`, `../../apps/api/src/lib/setup/setup.ts`, `../../apps/api/src/lib/auth/auth-schema-columns.ts` | Additive SSO provider table(s), CLI-generated in the schema file, with the `domainVerification` column. Setup creates them on a new server, and the start-up step creates them on a running one. |
| Endpoint gate | `../../apps/api/src/lib/auth/auth.ts` | The plugin's `providersLimit` gives 0 to everyone but the owner, so `POST /auth/sso/register` refuses every other caller. No path guard in `routes/auth.ts`. |
| Owner routes | `../../apps/api/src/routes/settings.ts` (or sibling, `requireOwner`-gated, no `:ownerId` — server-wide carve-out) | Three routes: list/create/delete SSO providers via `auth.api.registerSSOProvider` + provider-table reads; create reads the provider's settings page with the full address check; client secrets write-only in responses. |
| Server setting | server environment | Allow a provider on a private network. Off by default. |
| Admin UI | `../../apps/admin` (new Authentication → SSO page) | Provider list + add/remove form (OIDC fields: providerId, issuer, domain, clientId, clientSecret), owner only; the DNS record step; the guests on the domain to confirm. In the users table: "may use SSO" per account and one button for all current members; the password prompt when an SSO member is made an admin. |
| Login UI | `../../apps/space/src/routes/login.tsx` | "Sign in with {provider}" — either an explicit button per provider or domain-detection from the typed email; calls the plugin's SSO sign-in endpoint. |
| Settings UI | account settings (app-passwords section) | Surface app-password creation prominently for passwordless users; link from the connect-a-client help. |

## Phases

All phases start after the identity change has landed in 0.5.0, and SSO ships in a 0.5.x.

1. **Plugin + schema** — dependency, `sso()` in `auth.ts`, CLI-regenerated `auth-schema.ts`, both
   schema maps, the table in setup and in the start-up step, `providersLimit`, the guards in `user.validateUserInfo`. Exit: an OIDC provider registered via
   `auth.api.registerSSOProvider` in a test signs a stub-IdP user in end-to-end.
2. **Owner CRUD + UI** — routes, the settings-page read, the DNS record step, the guests to
   confirm, the "may use SSO" marks + Authentication → SSO page.
3. **Login + passwordless UX** — login-page SSO entry, app-password prominence, deployment doc
   (mail-domain caveat).
4. *(Deferred until demanded)* SAML forms + tests, SSO-only toggle, setup-wizard step.

## What's deferred

- **SAML 2.0** — plugin already supports it; needs only an admin form variant + a SAML test IdP.
- **Setup-wizard SSO step** — the admin page covers it; add if fresh-install demand appears.
- **SSO-only mode** (disable password sign-in once SSO is proven) — a server setting the login
  page reads.
- **SCIM provisioning/de-provisioning.** v1 provisions on login; disabling a departed user is manual.
- **Group → team mapping.** `organizationProvisioning.getRole` and claim mapping are the seam.
- **Eigen as an IdP** (`oidcProvider`) for other self-hosted apps. Separate proposal.
- **Consumer social providers** (`socialProviders`). Easy to add if wanted; different audience.
- **Per-provider 2FA policy.** "IdP already did MFA, skip Eigen 2FA" is a later refinement.

## Testing

Extend `../../apps/api/src/test` with an in-process OIDC stub (`Bun.serve` serving a discovery
document, JWKS, token + userinfo endpoints) acting as the IdP. The stub is on a private address,
so the tests turn on the private-network setting:

- A registered provider + a sign-in through the stub creates a user with org membership, and the
  user's first authenticated request yields a working Home (drive list + maildir resolve succeed).
- A second login as the same identity reuses the account — no duplicate user, no duplicate org
  membership (this pins the `organizationProvisioning: { disabled: true }` decision).
- A login links to an existing account only when the account is marked "may use SSO" and the
  provider's domain is verified; an unmarked account or an unverified domain is refused.
- An account that SSO creates is marked, and still signs in after its provider is deleted and
  added again.
- The guards refuse an address off the provider's domain, a second `sub` from the same provider
  for one account, and the owner or an admin. A member who used SSO and is then made an admin is
  refused at the next SSO sign-in.
- `/admin/update-user` with a new address is refused.
- The settings-page read refuses a private address with the setting off, a redirect, a name that
  resolves to a private address, a slow answer and a too-large answer.
- `verifyProtocolAuth` succeeds for an SSO user with an app password and fails cleanly without one.
- Registering a provider requires the owner: a member and an admin get `403` from the owner routes **and**
  from better-auth's built-in `/auth/sso/register`.

Use `getTestContext()` / `authedRequest()` from `../../apps/api/src/test/setup.ts`.
