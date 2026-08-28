# Proposal: Single Sign-On (SSO) for organisations

> **TLDR**: Let an organisation that already runs an identity provider (Keycloak, Authentik,
> Microsoft Entra, Okta, Google Workspace, Zitadel…) log into Eigen with it, instead of a separate
> Eigen password. Use better-auth's `sso` plugin (`@better-auth/sso`, versioned in lockstep with
> the installed `better-auth@1.5.6`), which lets providers be **registered at runtime** — so
> configuration lives in the admin app, not in env files. Providers map by **email domain** and
> **JIT-provision** users on first login. Almost everything is plugin wiring: org membership and
> share reconciliation already run from the `user.create.after` hook for *any* new user, and the
> Home/maildir/default-mount bootstrap is **already lazy** (first `getHome()` call), so an SSO user
> lands with a working workspace with **zero new provisioning code** (verified against code
> 2026-07-06 — see § Provisioning). The real work is: the schema migration, the admin CRUD +
> UI, the login-page button, gating better-auth's own `/sso/register` endpoint, and pointing SSO
> users (who are passwordless) at **app passwords** for mail/calendar/file clients. **v1 is
> OIDC-only**; SAML is supported by the same plugin and deferred until an org actually asks.
> Eigen-as-an-identity-provider, SCIM, and group→team sync are explicit non-goals.

## Goals

1. An admin can register their organisation's OIDC IdP and have staff sign in with it.
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
- **Consumer social login** (personal Google/GitHub/Apple). That's `socialProviders` — trivial to
  add later, but a different audience from "my organisation's SSO".
- **Changing the collaboration or data model.** This touches authentication only.

## Why now — foundation verified (2026-07-06)

The auth foundation already fits; all of the following was re-verified against source:

- `../../apps/api/src/lib/auth/auth.ts` runs better-auth with the `organization` (teams enabled),
  `admin`, `twoFactor` and `apiKey` plugins, and a `databaseHooks.user.create.after` hook that
  adds any newly-created non-guest user to the default org (`authAddUserToDefaultOrg`, role
  `member`) and reconciles pending shares (`reconcileSharesForNewUser` in
  `../../apps/api/src/lib/share/reconciliation.ts`). A JIT-created SSO user goes through the same
  create path, so org membership and share reconciliation come for free.
- **Home provisioning is lazy, not waitlist-driven.** The waitlist
  (`../../apps/api/src/lib/waitlist/waitlist.ts`, `registerFromInvite`) only calls
  `auth.api.createUser` and signs the user in — it creates *no* Home. The Home, maildir, default
  mount and quota all materialise on the first `getHome(userId)`
  (`../../apps/api/src/lib/home/get-home.ts` → `UserHome.init()` in `user-home.ts`, which seeds the
  default mount from server settings and runs `Drive.init(autoCreateDefaultMount)` +
  `Mail.init()` etc.; quotas are resolved at read time by `resolveUserQuotas`). `getHome` is
  idempotent and concurrent-safe (`createAsyncSingleton` + install-race retry loop). An SSO user
  is therefore provisioned exactly like a waitlist user: on their first authenticated request.
- `verifyProtocolAuth` (`../../apps/api/src/lib/auth/protocol-auth.ts`) already checks the **app
  password (API key) first** and only then falls back to `signInEmail` — so IMAP/CalDAV/WebDAV
  already work for passwordless accounts that hold an app password.
- `@better-auth/sso` (checked against current better-auth docs): providers are stored in the auth
  DB and **registered at runtime** via `auth.api.registerSSOProvider` / `POST /auth/sso/register`,
  keyed by `providerId` + `issuer` + `domain`; OIDC discovery is fetched automatically from
  `{issuer}/.well-known/openid-configuration`, so `oidcConfig` needs only
  `clientId`/`clientSecret`. Plugin options: `provisionUser`, `provisionUserOnEveryLogin`,
  `organizationProvisioning: { disabled, defaultRole, getRole }`, `defaultSSO`. The package is
  **not yet installed** — add `@better-auth/sso@1.5.6` (same lockstep versioning as the
  already-used `@better-auth/api-key@1.5.6`). Implementer note: the public docs track the latest
  release; confirm the exact option surface against the pinned 1.5.6 typings when wiring.

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
    // paths can't both call addMember — authAddUserToDefaultOrg throws ApiError(500) on
    // an addMember failure, which would fail the whole SSO login on a duplicate insert.
    organizationProvisioning: { disabled: true },
}),
```

No `provisionUser` hook is needed for v1: Home creation is lazy (see § Provisioning). Eigen has a
single default org (created at setup), so per-provider `organizationId` linking is also unnecessary.

### Where configuration lives

One surface: **Admin app → Authentication → SSO** (new page). List / add / remove providers, each
`{ providerId, issuer, domain, clientId, clientSecret }`. Backed by admin-gated API routes that
call `auth.api.registerSSOProvider` and read the plugin's provider table. Secrets are write-only
in API responses (return a placeholder, never echo the client secret).

This matches Eigen's existing split: identity written once at setup (`server-config.ts`) vs.
runtime-adjustable settings (`server-settings.ts`). SSO providers are runtime-adjustable, so they
live in the DB and are managed from admin — no redeploy to add an IdP. A setup-wizard step is
deferred (see § What's deferred) — the admin page covers the need.

**Gate the plugin's own endpoint.** better-auth mounts `POST /auth/sso/register` itself. Verify
its access-control in the pinned version; unless it already requires an admin, deny it at the
Elysia layer (the auth router in `../../apps/api/src`) so provider registration only happens through the
admin-gated routes. Registration must never be reachable by a regular member (better-auth also
422s on `providerId` collisions with social providers / reserved ids — surface that error in the
admin UI).

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
enterprise behaviour.

**Mail-domain caveat (deployment guidance, document it):** waitlist signup constructs addresses
as `username@mailDomain`; an SSO user keeps their IdP email (e.g. `alice@acme.com`). Internal
mail, sharing and protocol auth key off `user.email` and work regardless, but the account only
*receives external mail* if the instance actually handles mail for that domain. Recommend in the
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
- **Account linking — link by verified email + matching provider domain only.** Deliberate
  decision: an SSO login whose IdP-asserted, *verified* email matches an existing Eigen account
  at the provider's registered domain links to that account; anything else is rejected (not a
  silent second account — duplicate identities with one email would confuse shares and mail).
  better-auth implements this via its domain-verification / `account.accountLinking` machinery —
  configure it, don't hand-roll; verify the exact 1.5.6 behaviour (auto-link on verified domain)
  in a test before shipping.
- **Sessions/sign-out**: an SSO login produces a normal better-auth session cookie; sign-out
  revokes the Eigen session only. No IdP single-logout in v1.
- **2FA**: Eigen's `twoFactor` plugin applies to password sign-ins; SSO users rely on the IdP's
  MFA. A per-provider "require Eigen 2FA anyway" policy is deferred.

## Frozen-format

The `sso` plugin adds a provider table to the auth database (`users3.db`). This is **additive**,
but Eigen is live, so treat it as a production schema change:

1. Regenerate the Drizzle schema file — which lives at **`../../apps/api/auth-schema.ts`** (repo path;
   not under `../../src`) — with better-auth's CLI (`bunx @better-auth/cli generate`) after adding the
   plugin, and diff it: only new tables, no changes to existing columns.
2. Register the new table(s) in **both** schema maps in `auth.ts` — the `drizzleAdapter(...)`
   schema and `getAuthDrizzleDb()` — they are intentionally separate instances.
3. Apply with `drizzle-kit push` using the existing configs (`../../apps/api/drizzle.config.ts` for dev,
   `drizzle.config-prod.ts` for prod) — there is no migrations folder for `users3.db`; push is the
   established mechanism. Back up `users3.db` first (standing rule for destructive/schema ops).

No Yjs or drive-format impact.

## Backend / frontend pieces

| Layer | File | Change |
|---|---|---|
| Dependency | `../../apps/api/package.json` | Add `@better-auth/sso@1.5.6` (lockstep with `better-auth`). |
| Auth config | `../../apps/api/src/lib/auth/auth.ts` | Add `sso({ organizationProvisioning: { disabled: true } })` to `plugins`; add new tables to both Drizzle schema maps. |
| Auth schema | `../../apps/api/auth-schema.ts` (+ `drizzle-kit push`) | Additive SSO provider table(s), CLI-generated. |
| Endpoint gate | auth router in `../../apps/api/src` | Deny better-auth's built-in `POST /auth/sso/register` unless it's verified admin-gated in 1.5.6. |
| Admin routes | `../../apps/api/src/routes/settings.ts` (or sibling, `requireAdmin`-gated, no `:ownerId` — server-wide carve-out) | List/create/delete SSO providers via `auth.api.registerSSOProvider` + provider-table reads; client secrets write-only in responses. |
| Admin UI | `../../apps/admin` (new Authentication → SSO page) | Provider list + add/remove form (OIDC fields: providerId, issuer, domain, clientId, clientSecret). |
| Login UI | `../../apps/space/src/routes/login.tsx` | "Sign in with {provider}" — either an explicit button per provider or domain-detection from the typed email; calls the plugin's SSO sign-in endpoint. |
| Settings UI | account settings (app-passwords section) | Surface app-password creation prominently for passwordless users; link from the connect-a-client help. |

## Phases

1. **Plugin + schema** — dependency, `sso()` in `auth.ts`, CLI-regenerated `auth-schema.ts`, both
   schema maps, `drizzle-kit push`, `/sso/register` gate. Exit: an OIDC provider registered via
   `auth.api.registerSSOProvider` in a test signs a stub-IdP user in end-to-end.
2. **Admin CRUD + UI** — routes + Authentication → SSO page.
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
document, JWKS, token + userinfo endpoints) acting as the IdP:

- A registered provider + a sign-in through the stub creates a user with org membership, and the
  user's first authenticated request yields a working Home (drive list + maildir resolve succeed).
- A second login as the same identity reuses the account — no duplicate user, no duplicate org
  membership (this pins the `organizationProvisioning: { disabled: true }` decision).
- Account-linking occurs only when the stub asserts a verified email at the provider's domain;
  an unverified or foreign-domain email is rejected.
- `verifyProtocolAuth` succeeds for an SSO user with an app password and fails cleanly without one.
- Registering a provider requires admin: a regular member gets `403` from the admin routes **and**
  from better-auth's built-in `/auth/sso/register`.

Use `getTestContext()` / `authedRequest()` from `../../apps/api/src/test/setup.ts`.
