# Proposal: Single Sign-On (SSO) for organisations

> **TLDR**: Let an organisation that already runs an identity provider (Keycloak, Authentik,
> Microsoft Entra, Okta, Google Workspace, Zitadel…) log into Eigen with it, instead of a separate
> Eigen password. Use better-auth's `sso` plugin (`@better-auth/sso`), which speaks **OIDC and SAML
> 2.0** and lets providers be **registered at runtime** — so configuration lives in the admin app
> and, optionally, the setup wizard, not in env files. Providers map by **email domain** and
> **JIT-provision** users into an Eigen org. Most of the wiring is plugin config; the real work is
> three Eigen-specific touch-ups: making sure an SSO-created user gets a Home/maildir/quota (today
> that happens via the waitlist, which SSO bypasses), pointing SSO users at **app passwords** for
> mail/calendar/file clients (they have no primary password), and the admin/setup UX. Eigen-as-an-
> identity-provider, SCIM, and group→team sync are explicit non-goals.

## Goals

1. An admin can register their organisation's IdP (OIDC or SAML) and have staff sign in with it.
2. Users from a configured **email domain** are routed to the right provider and provisioned into
   the right Eigen organisation on first login (JIT), with a sensible default role.
3. SSO coexists with email/password: a deployment can be SSO-only, password-only, or mixed.
4. Configuration is done in the **admin app** (and optionally seeded in the **setup wizard**), not
   by hand-editing env or restarting the server.
5. Reuse the existing auth stack — the `organization` plugin's data model, the `user.create` hook
   that already provisions org membership, and the app-password (`apiKey`) mechanism for protocol
   clients.

## Non-goals

- **Eigen as an identity provider** for *other* apps (better-auth's `oidcProvider` plugin). The
  inverse feature; separate proposal if wanted.
- **SCIM / automated de-provisioning.** Disabling a user when the IdP removes them is a follow-up.
  v1 provisions on login; removal stays a manual admin action.
- **Group / claim → team mapping.** v1 maps every SSO user to one org with one default role.
  Mapping IdP groups onto Eigen teams is a richer follow-up (`getRole` is the seam for it).
- **Consumer social login** (personal Google/GitHub/Apple). That's `socialProviders` — trivial to
  add later, but a different audience from "my organisation's SSO".
- **Changing the collaboration or data model.** This touches authentication only.

## Why now

The auth foundation already fits. `apps/api/src/lib/auth/auth.ts` runs better-auth with the
`organization` (teams enabled), `admin`, `twoFactor` and `apiKey` plugins, and crucially a
`databaseHooks.user.create.after` hook that **already** adds any newly-created non-guest user to the
default org and reconciles their shares. An SSO-provisioned user is just another newly-created user,
so org membership comes for free.

better-auth's `sso` plugin is built for exactly this shape: OIDC + SAML, providers stored in the
auth DB and **registered at runtime** via `auth.api.registerSSOProvider`, keyed by `issuer` +
`domain`, optionally linked to an `organizationId`, with `provisionUser` / `organizationProvisioning`
hooks for JIT. That maps directly onto an admin-managed configuration surface rather than static
config.

So the login path is mostly plugin wiring. The work that is genuinely Eigen-specific is small and
enumerated below.

## Architecture

### Plugin

Add to the `plugins: [...]` array in `auth.ts` (separate package, same style as the already-used
`@better-auth/api-key`):

```typescript
import { sso } from '@better-auth/sso';

sso({
    // JIT provisioning. Runs when an SSO login has no matching user yet.
    provisionUser: async (user) => {
        // ensure the user's Home/maildir/quota exist — see § Provisioning
    },
    organizationProvisioning: {
        disabled: false,
        defaultRole: 'member',
    },
}),
```

Providers themselves are **not** in this static config — they are rows, added at runtime:

```typescript
await auth.api.registerSSOProvider({
    body: {
        providerId: 'acme-oidc',
        issuer: 'https://acme.okta.com',
        domain: 'acme.com',
        organizationId: 'org_acme',   // optional; links + auto-provisions into this org
        oidcConfig: { /* clientId, clientSecret, scopes, discovery URL */ },
        // or samlConfig: { entryPoint, issuer, certificate }
    },
    headers,  // caller must be org owner/admin when organizationId is set
});
```

### Where configuration lives

| Surface | Role |
|---|---|
| **Setup wizard** (`apps/admin`, first-run) | Optional: configure one server-wide OIDC/SAML provider so the instance is SSO-from-day-one. Writes through the same `registerSSOProvider` API once the default org exists. |
| **Admin app → Authentication → SSO** (new page) | The ongoing surface: list / add / edit / remove providers, each `{ providerId, type, issuer, domain, org, secret }`. Backed by `registerSSOProvider` + the plugin's provider table. Secrets are write-only in the API responses (return a placeholder, never echo the client secret / SAML key). |

This matches Eigen's existing split: identity written once at setup (`server-config.ts`) vs.
runtime-adjustable settings (`server-settings.ts`). SSO providers are runtime-adjustable, so they
live in the DB and are managed from admin — no redeploy to add an IdP.

### Provisioning (the main integration task)

JIT provisioning has two halves:

1. **Org membership** — already handled. The `user.create.after` hook adds the user to the default
   org; `organizationProvisioning` can target a specific org by domain.
2. **The Home** — the open item. Today, external users are onboarded through the **waitlist**
   (`apps/api/src/lib/waitlist`), and the waitlist-approval path is what bootstraps a user's Home,
   maildir, default mount and quota. **SSO bypasses the waitlist**, so the bootstrap must also run
   from the SSO `provisionUser` hook (or the `user.create` hook, for any passwordless user). The
   concrete task: extract the Home-bootstrap step the waitlist runs into a function callable from
   `provisionUser`, so an SSO user lands with a working drive/mailbox, not just an org row.

**Open question to verify before implementing:** pin down exactly where Home/maildir/quota are
created today (waitlist approval vs. lazy on first `getHome`) so the SSO path reuses it rather than
duplicating it.

### Protocol auth — SSO users use app passwords

`apps/api/src/lib/auth/protocol-auth.ts`'s `verifyProtocolAuth` already tries the **app password
(API key) first**, then falls back to the primary password. SSO users **have no primary password**,
so the fallback can never succeed for them — which is fine: IMAP, CalDAV and WebDAV clients
(Thunderbird, iOS Mail, Apple Calendar) authenticate with an **app password**, exactly as they do
against Google/Microsoft SSO accounts.

Two small changes:

- For passwordless (SSO-only) accounts, **skip** the primary-password fallback — it's a guaranteed
  failed `signInEmail` per request, so short-circuit it.
- Make **app-password creation prominent** in the UI for SSO users (the settings page and the
  "connect a mail/calendar client" help), since it's their only path to protocol clients.

No protocol-auth redesign is needed — the app-password-first ordering already makes SSO work today.

### Account linking & mixed mode

- A deployment may run **password + SSO** at once. `emailAndPassword.enabled` stays `true` unless an
  admin opts the instance into SSO-only.
- **Link by verified email only.** Auto-link an SSO identity to an existing Eigen account *only*
  when the IdP asserts the email is verified (`email_verified` for OIDC; the SAML equivalent).
  Otherwise treat it as a distinct account to avoid an account-takeover vector.
- Optional admin toggle: **disable password sign-in** (SSO-only) for the org once SSO is proven.

## Frozen-format

The `sso` plugin adds its own tables (SSO providers, etc.) to the auth database (`users3.db`,
schema in `apps/api/src/auth-schema.ts`). This is **additive**, but Eigen is live, so it needs a
deliberate auth-schema migration generated via better-auth's CLI (`generate` / `migrate`) and
applied with the same care as any production schema change. No existing column changes; no Yjs or
drive-format impact.

## Backend / frontend pieces

| Layer | File | Change |
|---|---|---|
| Auth config | `apps/api/src/lib/auth/auth.ts` | Add `sso({...})` to `plugins`; wire `provisionUser` to the Home-bootstrap function. |
| Auth schema | `apps/api/src/auth-schema.ts` (+ better-auth migrate) | Additive SSO provider tables. |
| Provisioning | `apps/api/src/lib/waitlist/*` → shared helper | Extract Home/maildir/quota bootstrap into a function callable from `provisionUser`. |
| Protocol auth | `apps/api/src/lib/auth/protocol-auth.ts` | Skip password fallback for passwordless accounts. |
| Admin routes | `apps/api/src/routes/settings.ts` (admin-gated) | CRUD over SSO providers via `registerSSOProvider`; secrets write-only in responses. |
| Setup wizard | `apps/admin` first-run | Optional "configure SSO" step that registers one provider. |
| Admin UI | `apps/admin` (new Authentication → SSO page) | List/add/edit/remove providers; OIDC vs SAML forms. |
| Login UI | the sign-in surface | "Sign in with {provider}" / domain-detected SSO button; SSO-only mode hides the password form. |
| Settings UI | account settings | Surface app-password creation prominently for SSO users. |

## What's deferred

- **SCIM provisioning/de-provisioning.** v1 provisions on login; disabling a departed user is manual.
- **Group → team mapping.** `organizationProvisioning.getRole` and claim mapping are the seam; v1
  maps to one org + default role.
- **Eigen as an IdP** (`oidcProvider`) for other self-hosted apps. Separate proposal.
- **Consumer social providers** (`socialProviders`). Easy to add if wanted; different audience.
- **Per-provider 2FA policy.** 2FA stays as configured globally; "IdP already did MFA, skip Eigen
  2FA" is a later refinement.

## Testing

Extend `apps/api/src/test/` with an in-process OIDC stub (Bun `Bun.serve`) acting as the IdP:

- A registered provider + a sign-in through the stub creates a user, an org membership, **and** a
  working Home (drive list + maildir resolve succeed).
- A second login as the same identity reuses the account (no duplicate provisioning).
- Account-linking only occurs when the stub asserts a verified email.
- `verifyProtocolAuth` succeeds for an SSO user with an app password and fails (cleanly, no
  password fallback) without one.
- Registering a provider requires admin / org-owner; a regular member gets `403`.

Use `getTestContext()` / `authedRequest()` from `apps/api/src/test/setup.ts`.
