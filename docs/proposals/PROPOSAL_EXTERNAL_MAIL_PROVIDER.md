# Proposal: Eigen alongside an existing mail provider

> **TLDR**: Most self-hosters already have email at their own domain — Google Workspace, Microsoft 365, Fastmail, Migadu, mailbox.org, or their own postfix. Today Eigen offers them one switch, `MAIL_ENABLED=0`, which relays outbound mail and drops the Mail app and all inbound calendar handling. This proposal makes **coexistence** first-class instead: the provider stays the MX, Eigen sends through the provider's relay, and the provider dual-delivers a copy of every inbound message into Eigen's existing `POST /mail/deliver/:to` endpoint. That is a deployment pattern, not a new mail backend — it reuses the Maildir, the sync engine and the iMIP path untouched, and needs **three small code changes** (a configurable From, own-copy filing into `Sent`, a configurable trusted authserv-id). The design names three *provider capabilities* rather than a vendor, so it covers Workspace, Microsoft 365 and any provider exposing Sieve-style redirect rules. Coexistence has two preconditions: **a publicly reachable Eigen host**, always, and on Workspace and Microsoft 365 **admin rights on the mail tenant**. A single user of someone else's tenant, or an instance on `localhost`, is served only by the pull-based IMAP `MailStore` — ten times the work, sketched in § The tier-4 alternative and made concrete in § Reference scenario: one Microsoft 365 mailbox on a local instance.

## Goals

1. A self-hoster with existing email at their own domain runs Eigen without becoming the MX, and still gets: outbound mail with a correct `From`, inbound mail visible in the Mail app, working calendar invitations **and RSVPs**, and SSO where the provider is also an identity provider.
2. **No new mail backend.** Everything runs through the Maildir store, the deliver route and the iMIP path that exist today.
3. **Provider-agnostic.** The pattern is expressed as three capabilities a provider either has or lacks, with a matrix telling a self-hoster which tier they are in before they start.
4. The configuration is documentable end-to-end in [../../docker/SETUP-GUIDE.md](../../docker/SETUP-GUIDE.md) — no bespoke per-user glue scripts.

## Non-goals

- **Two-way sync of read/flag state.** A dual-delivered copy is a second view, not a mirror. Marking a message read in Eigen does not mark it read at the provider. Changing that means an `ImapStore implements MailStore` — see § The tier-4 alternative.
- **Eigen as the MX.** That is the existing hosted mode (`mail` profile with postfix as the edge), unchanged and still the default.
- **Migrating off the provider.** A one-shot IMAP import into the Maildir is a separate, smaller piece of work.
- **Calendar and contacts sync with the provider.** Eigen keeps its own calendar and contacts; only mail and identity are in scope.
- **Per-user OAuth against the provider.** The whole point of this pattern is that it needs no per-user tokens. They become relevant only for the pull-based fallback — see § The tier-4 alternative.

## What exists today (verified against source)

| Piece | Where | State |
|---|---|---|
| Hosted-mailboxes switch | `isMailEnabled()`, `apps/api/src/lib/config/env.ts:15` | Rides to the FE as `mailEnabled` on `GET /p/config`; every Mail entry point disappears when off |
| Outbound relay | `createTransport()`, `apps/api/src/lib/core/mailer.ts:45` | `SMTP_HOST`/`PORT`/`USER`/`PASSWORD`/`SECURE`; STARTTLS + cert verification mandatory once `SMTP_USER` is set |
| Mail domain ≠ web domain | `getMailDomain()`, `apps/api/src/lib/config/server-config.ts:72` | `MAIL_DOMAIN` decouples addresses from the web URL |
| Inbound delivery | `POST /mail/deliver/:to`, `apps/api/src/routes/mail.ts:68` | `requireLocalhost`, resolves the user by address, appends to INBOX |
| Inbound iMIP | `Mail.mailboxDeliver`, `apps/api/src/lib/mail/mail-domain.ts:124` | Parses the delivered bytes and runs `processInboundImip` synchronously |
| iMIP sender trust | `verifyImipSender`, `apps/api/src/lib/mail/imip-auth.ts:49` | Requires an `Authentication-Results` header stamped with **our** authserv-id (`getMailDomain()`) carrying an aligned `dkim=pass` |
| Storage backend seam | `MailStore`, `apps/api/src/lib/mail/mail-store.ts` | 28 methods, one implementation (`MaildirStore`) |

The gap this proposal closes: with `MAIL_ENABLED=0` there is **no inbound path at all**, so attendee RSVPs and externally-organized invitations never reach the Calendar, and the Mail app is simply gone.

## The three provider capabilities

| | Capability | What it must do | What it buys |
|---|---|---|---|
| **C1** | **Send-as relay** | Accept mail from your server and send it as any address in your domain | Outbound with the real `From` (share notices, invitations, iMIP), signed by the provider — which also sidesteps self-hosted IP reputation |
| **C2** | **Inbound copy** | Deliver a second copy of inbound mail to another host, preserving headers and body | Mail app content, and inbound iMIP (invitations + RSVPs) through the endpoint that already exists |
| **C3** | **OIDC identity provider** | Standard OIDC discovery + a domain claim | SSO, and Eigen identities that *are* the provider's mailbox addresses — see § SSO |

C2 must **redirect, not rewrite**. A redirect (Sieve `redirect`, Gmail dual delivery, an Exchange redirect rule) leaves the body and original headers intact, so the sender's DKIM signature still verifies and `verifyImipSender` can pass. SPF will fail on the copy, because the connecting IP is the provider's — that is fine and expected: the iMIP gate reads DKIM only, never SPF. A "forward with my address as sender" feature that re-signs or reformats the message breaks this and is not a substitute.

Two preconditions sit under the matrix below. C2 delivers to a host the provider can reach from the internet, on every tier. And on Workspace and Microsoft 365, C1 and C2 are **tenant-level** settings only an admin can change. An Eigen that runs on `localhost`, or a user who is not an admin of their Workspace/M365 tenant, is in tier 4 whatever the provider.

## Provider matrix

| Provider | C1 | C2 | C3 | Verdict |
|---|---|---|---|---|
| **Google Workspace** | SMTP relay service (`smtp-relay.gmail.com:587`), "allow any address in the domain" | Gmail Routing → dual delivery to an additional host | Google OIDC | **Best case.** Everything at the domain level; no per-user credentials |
| **Microsoft 365** | Direct send to the tenant's `*.mail.protection.outlook.com` host (prefer this — basic auth on SMTP AUTH client submission is being retired) | Mail-flow rule that bcc/redirects to an external host | Entra ID | **Equivalent**, via different console pages |
| **Fastmail, Migadu, mailbox.org, Zoho, own postfix/dovecot** | Per-user SMTP credentials (app password); `From` limited to addresses that account owns | Per-mailbox Sieve `redirect` (or the provider's rule UI) | None — pair with Authentik/Keycloak/Authelia | **Works, with per-user setup.** See § Outbound identity |
| **Consumer Gmail / Outlook.com** | Rewrites `From` to the authenticated account | No routing controls | — | **Not this pattern.** Outbound-only, or the tier-4 alternative |
| **Any provider without a public Eigen host; Workspace / M365 without tenant admin rights** | — | — | Whatever the provider offers | **Tier 4.** See § Reference scenario: one Microsoft 365 mailbox on a local instance |

Provider-console specifics above come from vendor documentation, not from a live console in this repo. **Each one must be verified against a real tenant before it is written into the setup guide** — see § Open questions.

## Reference deployment: Google Workspace

The provider stays the MX. Eigen keeps the `mail` profile running, not to receive from the internet but to accept the dual-delivered copies and to keep Dovecot serving IMAP over them.

```
DOMAIN=eigen.example.com
MAIL_DOMAIN=example.com          # you own it — safe, unlike pointing MAIL_DOMAIN at gmail.com
COMPOSE_PROFILES=edge,mail
SMTP_HOST=smtp-relay.gmail.com
SMTP_PORT=587
MAIL_FROM=eigen@example.com      # new — see E1
```

Admin console, two settings: **Apps → Gmail → Routing** adds a dual-delivery route sending a copy of inbound mail to `eigen.example.com`, and **Apps → Gmail → SMTP relay service** allows your server's IP to send as any address in the domain. DNS is untouched — MX stays at Google, and because Google signs the outbound relay traffic you do not publish a DKIM key for Eigen's postfix at all.

`MAIL_ENABLED` stays **on**. There is no need for a third state: mailboxes are real, Eigen just is not the MX.

## Outbound identity: the sharp edge

Eigen sends mail *as the acting user* in two places — `messageSend` (the Mail app) and iMIP, where `from: organizer.email` is the organizer's own address (`apps/api/src/lib/calendar/imip.ts:74`). Whether that survives depends entirely on C1:

- **Domain-level relay (Workspace, M365 direct send):** any user in the domain, any number of users, no per-user credentials. Nothing to solve.
- **Per-user SMTP credentials (tier 3), single-user instance:** set `SMTP_USER` to that user, and every `From` already matches. Works today.
- **Per-user SMTP credentials, multi-user instance:** one relay identity cannot legitimately send as five users. Options, in order of preference: (a) accept one envelope sender with the acting user in `Reply-To` (E1); (b) per-user SMTP credentials stored per home — which reopens the credential-storage question this proposal otherwise avoids and is **deferred**; (c) tell the operator this tier is single-user. v1 ships (a) and documents (c).

## Eigen changes

| | Change | Files | Effort |
|---|---|---|---|
| **E1** | `MAIL_FROM` (and optional `MAIL_FROM_NAME`) overriding `defaultFrom()`, plus `replyTo` set to the acting user on notification and iMIP mail — the `OutboundMail.replyTo` field exists and nothing sets it | `apps/api/src/lib/core/mailer.ts:43,88`, the `sendMail` call sites in `drive/acl-propagation.ts`, `calendar/invite-propagation.ts` | XS |
| **E2** | File a delivered message whose `From` is the recipient's own address into `Sent` rather than INBOX, deduped by `Message-ID` | `Mail.mailboxDeliver`, `apps/api/src/lib/mail/mail-domain.ts:124` | S |
| **E3** | Configurable trusted authserv-id, defaulting to `getMailDomain()`, so a deployment whose MTA stamps a different id can still act on iMIP | `apps/api/src/lib/calendar/imip.ts:210`, `apps/api/src/lib/mail/imip-auth.ts:49` | XS |
| **E4** | Setup-guide section per tier, replacing today's single "Using your existing mail server" block | `docker/SETUP-GUIDE.md`, [../MAIL.md](../MAIL.md) | S |

**E2 in detail.** With C2 configured for outbound as well as inbound, Eigen receives a copy of what its user sent from the provider's own web UI — valuable, because otherwise the Mail app shows an inbox with no matching sent side. The copy arrives addressed to the external recipient, so the routing rule must rewrite the envelope recipient to the Eigen user (a provider-side setting; **verify**). Two messages then race for the same content: the Sent copy `messageSend` writes itself, and the dual-delivered one. Dedupe is reliable because Eigen pins its own `Message-ID` to `<draftId@mailDomain>` (`buildMessageId`, `apps/api/src/lib/mail/mailutils.ts:38`) — a delivered message whose `Message-ID` already exists in `Sent` is dropped.

**Quota.** Mail and contacts share one 100 MB default (`apps/api/src/lib/config/server-settings.ts:13`) and mail usage is summed over the message index. A dual-delivered copy of a busy mailbox will hit that. No code change proposed — the admin raises the quota — but the setup guide must say so out loud.

## What this deliberately does not give you

- Marking a message read or filing it in Eigen does not change anything at the provider. The two views drift, and that is by design.
- Without the outbound half of C2, Eigen's `Sent` holds only what Eigen sent.
- Every message is stored twice.
- Spam filtering happens at the provider, before the copy — which is a feature ([PROPOSAL_RSPAMD.md](PROPOSAL_RSPAMD.md) is about the hosted mode, and is unaffected).

## The tier-4 alternative

A provider with no inbound-copy capability can only be reached by pulling: an `ImapStore implements MailStore` that keeps `mail.db` as a summary cache and fetches bodies on demand. The seam is real and its change-stream comment already anticipates "IMAP IDLE for a remote backend" (`apps/api/src/lib/mail/mail-store.ts:46`), and the architecture fits — `mail.db` already caches only summaries while full messages are re-parsed lazily. The frictions are documented: `search()` and `getSummary()` are synchronous and assume a local index; message ids must stay stable across moves while IMAP UIDs do not; drafts have no remote in-place update and keep needing local sidecar + temp storage; and homes idle out after five minutes (`apps/api/src/lib/home/home.ts:37`), so push only runs while a user is connected. Sized against the JMAP adapter in [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) (600–900 LOC), an IMAP one plus account UI and a poller is **1,200–1,500 LOC**. This proposal is the 5%-of-the-effort answer for everyone whose provider has C1 + C2; build tier 4 only when someone's does not.

**Credentials are not one of those frictions, if SSO lands first.** Storing each user's mail password was the ugliest part of a pull-based design — there is no secret storage in the tree today, and `settings.json` holds S3 keys in plaintext. OAuth removes the problem rather than solving it: an OIDC sign-in that also requests the provider's mail scope yields per-user tokens that `better-auth` already persists, since the `account` table carries `access_token`, `refresh_token`, `scope` and both expiry columns (`apps/api/auth-schema.ts:42-47`). `ImapStore` then authenticates with SASL XOAUTH2 and Eigen never holds a password. Four conditions come with it: the sign-in must ask for **offline access**, or the token dies in an hour and no refresh token is issued; the refresh has to run outside the request path, because homes idle out; Google treats mail scopes as **restricted**, which is free for an app internal to your own Workspace and a verification + security-assessment exercise for anything public; and for **Microsoft 365 this is the only door** — basic auth for IMAP is switched off there, so a tier-4 M365 integration is OAuth or nothing. Workspace has a server-side alternative that skips per-user consent entirely: a service account with domain-wide delegation, one credential for the whole domain. Note also that requesting extra scopes and keeping provider tokens is natural with `socialProviders` and awkward through the generic `sso` plugin, which federates IdPs rather than holding API tokens — the same conclusion § SSO reaches from the other direction.

## Reference scenario: one Microsoft 365 mailbox on a local instance

The concrete tier-4 target, and the first thing worth building from that tier: a developer runs Eigen on `localhost`, signs in with their work Microsoft account (`dev@company.example`), and sees that mailbox in the Mail app. No tenant mail-flow change, no public host, no stored password. Coexistence cannot serve this — there is nowhere for a dual-delivered copy to land — so it is SSO + `ImapStore`, in that order.

| Piece | What it takes | State |
|---|---|---|
| **Sign-in** | better-auth `socialProviders.microsoft` with `tenantId` pinned to the one tenant, so nobody outside it can provision an account. The redirect URI is `{API_URL}/auth/callback/microsoft`; Entra accepts `http://localhost` redirect URIs, so no tunnel is needed | Unbuilt — the cheap path from § SSO, not the `sso` plugin |
| **Scopes** | `openid profile email offline_access` plus `https://outlook.office.com/IMAP.AccessAsUser.All` (and `https://outlook.office.com/SMTP.Send` for outbound) | Config on the provider entry |
| **Tokens** | Already persisted in the `account` table. Refresh before each IMAP connect when `accessTokenExpiresAt` has passed | Columns exist; the refresh call is new |
| **Reading** | `ImapStore implements MailStore` against `outlook.office365.com:993`, SASL XOAUTH2. A read-mostly slice — list, open, flags, move, delete — is enough for "a view of my mail"; drafts stay in the local sidecar | Unbuilt — the bulk of the work |
| **Backend selection** | A per-home choice of store. `UserHome` hands `Mail` a `new MaildirStore` unconditionally today (`apps/api/src/lib/home/user-home.ts:24`) | Unbuilt, small |
| **Sending** | `smtp.office365.com:587` with XOAUTH2 as the acting user. `createTransport()` reads one global `SMTP_USER`/`SMTP_PASSWORD` pair, so this needs a per-send transport carrying the user's token (nodemailer supports `auth.type: 'OAuth2'`). Deferrable: a first cut can be read-only | Unbuilt |

What has to happen **outside** Eigen, in the Entra tenant: an app registration with the redirect URI above and the two delegated Office 365 Exchange Online permissions. Whether a plain user can consent to them, or a tenant admin must grant consent once, is tenant policy — and IMAP must be enabled for the mailbox, which a tenant can switch off. Neither is something Eigen can work around, so check both before writing any code.

Two Microsoft specifics to design for, both to **verify against a real tenant**:

- **An access token is for one resource.** The Graph scope better-auth's Microsoft provider asks for by default (`User.Read`) and the `outlook.office.com` IMAP scope cannot share a token. Consent covers both in one authorize round-trip, but the stored access token serves only one of them; the IMAP token is obtained by redeeming the refresh token with the Outlook scopes. `offline_access` is therefore not optional here.
- **SMTP AUTH is commonly disabled tenant-wide.** Where it is, `SMTP.Send` is granted and still refused. The fallback is Graph `Mail.Send` — a different send path, not a transport option — which is a reason to ship reading first.

`MAIL_DOMAIN` needs a decision in this shape. The user's address is `@company.example` but the instance does not handle mail for `company.example`: setting `MAIL_DOMAIN=company.example` makes `isInternalAddress` treat every colleague as an Eigen user on this server, and leaving it unset pins outgoing `Message-ID`s to `@localhost`. See § Open questions.

## SSO

C3 completes the pattern, and it is already specified: [PROPOSAL_SSO.md](PROPOSAL_SSO.md) (OIDC v1 via better-auth's `sso` plugin, SAML deferred) lists Google Workspace and Microsoft Entra among its targets, and verified that JIT provisioning needs no new code — the `user.create.after` hook handles org membership and share reconciliation, and Home/maildir/mount/quota bootstrap is lazy on first `getHome()`.

Three things this proposal adds to it:

1. **SSO is what makes the addresses line up.** The login form composes `username@mailDomain` (`packages/ui/src/components/layout/pages/login-page.tsx:46`), so an external address cannot sign in today; SSO bypasses that form entirely. With C1+C2+C3 on one domain, an Eigen identity, a provider mailbox and the address Eigen sends from are the same string — which is exactly the precondition the rest of this document assumes. It also satisfies the SSO proposal's own mail-domain caveat, rather than working around it.
2. **A single-domain deployment has a cheaper path.** The SSO proposal reaches for `@better-auth/sso` because it is built for runtime-registered, multi-IdP organizations. A self-hoster on one Workspace or M365 domain needs none of that: `socialProviders` with a domain (`hd` / tenant) check is a fraction of the work and needs no admin CRUD, no provider table and no auth-schema migration. That is now noted in [PROPOSAL_SSO.md](PROPOSAL_SSO.md) § Non-goals.
3. **SSO is also how the tier-4 fallback would authenticate.** A sign-in that carries the provider's mail scope leaves per-user OAuth tokens in the `account` table, which is what turns an `ImapStore` from "store every user's mail password somewhere" into "reuse the token we already hold" — see § The tier-4 alternative. That does not shorten the build, but it removes its worst design problem, so **SSO should land before any pull-based mail work starts**. The local Microsoft 365 scenario above is exactly this chain, and it needs `socialProviders`, not the `sso` plugin: the plugin federates sign-in and has no notion of extra API scopes.

Protocol clients keep working either way: `verifyProtocolAuth` tries the app password (better-auth API key) before the password fallback, so passwordless SSO users authenticate IMAP, CalDAV and WebDAV with an app password. OIDC itself cannot reach those clients — an IMAP or CalDAV login has nowhere to run a browser redirect, and making Eigen speak OAuth to them would mean becoming an identity provider, an explicit non-goal of [PROPOSAL_SSO.md](PROPOSAL_SSO.md).

## Testing

- `mailboxDeliver` files a message whose `From` is the recipient's own address into `Sent`, and drops it when a message with the same `Message-ID` is already there (E2).
- A message delivered with an `Authentication-Results` header from a configured non-default authserv-id carrying an aligned `dkim=pass` acts on its iMIP payload; the same message without the header does not (E3).
- `buildMailOptions` uses `MAIL_FROM` when set and `noreply@{mailDomain}` when not, and carries `replyTo` through (E1).
- An end-to-end delivery test already has the shape needed: the existing iMIP inbound tests under `apps/api/src/test/` deliver raw bytes through the same path.

## Open questions

1. Does Gmail dual delivery preserve the original DKIM signature well enough for OpenDKIM to record an aligned `dkim=pass`? The whole inbound-iMIP win rests on it. Verify with a real invitation before documenting the tier.
2. Can the outbound half of C2 rewrite the envelope recipient to the sending user, and is that true on both Workspace and M365? If not, E2 degrades to "Eigen's Sent holds only what Eigen sent".
3. Workspace SMTP relay daily caps versus a chatty instance's share notifications — worth a line in the guide.
4. Tier-3 multi-user: is option (a) (one envelope sender + `Reply-To`) acceptable in practice, or does that tier get documented as single-user only?
5. Local Microsoft 365 scenario: does the target tenant let a user consent to `IMAP.AccessAsUser.All`, and is IMAP enabled on the mailbox? Both are outside Eigen's control and decide whether the scenario is reachable at all.
6. Does better-auth 1.7.3's Microsoft provider persist a refresh token that can be redeemed for `outlook.office.com` scopes, given that its own default scope is a Graph one? If not, the provider entry drops `User.Read` and reads the profile from the ID token.
7. With an identity at a domain the instance does not serve mail for, should `MAIL_DOMAIN` be that domain or stay unset? Audit every `isInternalAddress` and `getMailDomain()` caller before choosing.
