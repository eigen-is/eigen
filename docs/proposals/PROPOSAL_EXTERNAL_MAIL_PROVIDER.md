# Proposal: Mail that lives at an existing provider (IMAP backend)

> **TLDR**: Most people who try Eigen already have email somewhere — Microsoft 365, Google Workspace, Fastmail, Migadu, mailbox.org, their own dovecot. Today Eigen offers them one switch, `MAIL_ENABLED=0`, which drops the Mail app and all inbound calendar handling. This proposal adds a second `MailStore` implementation, **`ImapStore`**, so the Mail app becomes a client of the mailbox the user already has: the provider stays the MX, the source of truth and the spam filter; Eigen reads over IMAP, sends over the provider's SMTP submission, and keeps only a summary cache. Read state, flags and moves are the provider's, so Eigen and the user's other mail clients always agree. Authentication is **OAuth, reusing the token from SSO sign-in** (SASL XOAUTH2) — Eigen stores no mail password. IMAP is the one protocol every provider speaks, it needs no tenant admin rights and no publicly reachable host, and the storage seam it plugs into already exists. Cost: **1,200–1,500 LOC**, SSO first.

## Goals

1. A user whose mailbox lives at another provider opens Eigen's Mail app and sees **that mailbox** — same folders, same read state, same sent mail as in their other clients.
2. Works for **one user of someone else's tenant** and for an instance on **`localhost`**: nothing to configure in a provider admin console, no inbound connection from the provider to Eigen.
3. **No stored passwords.** Where the provider is also the identity provider, mail access rides on the SSO sign-in.
4. Calendar invitations and RSVPs that arrive in that mailbox still reach Eigen's Calendar.
5. **Nothing above the store changes.** The Mail domain class, the routes, the SSE events and the whole frontend stay as they are; the work is one new `MailStore` plus its wiring.

## Non-goals

- **Copying mail into Eigen** (provider-side dual delivery, forwarding rules, fetch-and-store). A copy is a second mailbox that drifts from the first: read state diverges, every message is stored twice, and setting it up needs tenant admin rights plus a public host. Considered and rejected — one mailbox, one source of truth.
- **Multiple mail accounts per user**, or an external account *next to* a hosted one. v1 is one mailbox per home, and an instance either hosts mailboxes or fronts external ones.
- **Migrating off the provider.** A one-shot IMAP import into the Maildir is a separate, smaller piece of work that can reuse this proposal's IMAP plumbing.
- **Calendar and contacts sync with the provider.** Eigen keeps its own; only mail and identity are in scope.
- **Serving IMAP for these mailboxes.** Dovecot fronts the local Maildir; with an external mailbox, protocol clients talk to the provider directly.
- **JMAP.** [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) covers a JMAP store for a server Eigen runs itself. It is a different goal; the two share the `MailStore` seam and nothing else.

## What exists today (verified against source)

| Piece | Where | State |
|---|---|---|
| Storage backend seam | `MailStore`, `apps/api/src/lib/mail/mail-store.ts` | 28 methods, one implementation (`MaildirStore`). The change-stream comment already anticipates "IMAP IDLE for a remote backend" (`:46`) |
| Store construction | `apps/api/src/lib/home/user-home.ts:24` | `new Mail(this, new MaildirStore(this))`, unconditional — the single line backend selection touches |
| Summary index | `emails` table, `apps/api/src/lib/mail/schema.ts` | Subject, addresses, a short text excerpt, flags, mailbox. Lists and search run on it; full messages are parsed lazily. An IMAP store fills the same table from `ENVELOPE` + a body excerpt |
| Hosted-mailboxes switch | `isMailEnabled()`, `apps/api/src/lib/config/env.ts:15` | Rides to the FE as `mailEnabled` on `GET /p/config`; every Mail entry point disappears when off |
| Outbound | `createTransport()`, `apps/api/src/lib/core/mailer.ts:45` | One global `SMTP_*` relay with optional user/password. No per-user transport, no OAuth |
| Inbound iMIP | `Mail.mailboxDeliver`, `apps/api/src/lib/mail/mail-domain.ts:124` | Runs `processInboundImip` on **delivered bytes only** — a message that arrives any other way never reaches the Calendar |
| iMIP sender trust | `verifyImipSender`, `apps/api/src/lib/mail/imip-auth.ts:49` | Requires an `Authentication-Results` header stamped with **our** authserv-id (`getMailDomain()`) carrying an aligned `dkim=pass` |
| OAuth token storage | `account` table, `apps/api/auth-schema.ts:42-47` | `access_token`, `refresh_token`, `scope` and both expiry columns exist; better-auth fills them for social sign-ins. Nothing reads them yet |
| Welcome mail | `apps/api/src/lib/mail/mail-domain.ts:91-93` | Appended into a fresh store's INBOX — must not happen to a real external mailbox |
| Home lifetime | `apps/api/src/lib/home/home.ts:37` | Homes idle out after five minutes, taking their store (and any IMAP connection) with them |

## Architecture

```
            provider (MX, spam filter, source of truth)
             ▲ IMAP 993, XOAUTH2          ▲ SMTP submission 587, XOAUTH2
             │                            │
        ImapStore ── mail.db (summary cache + uid map)      per-user transport
             │                            │
             └────────── Mail domain ─────┘      routes, SSE, frontend: unchanged
```

### The store

`ImapStore implements MailStore`, in `apps/api/src/lib/mail/imap-store.ts`, beside `maildir-store.ts`.

- **Cache, not copy.** `mail.db` holds summaries only, exactly as today. `getMessage` / `getRawMessage` / `getAttachments` fetch from the provider on demand; a small bounded body cache on disk is an optimization, not a requirement. Mail quota stops mattering in this mode — the provider enforces its own.
- **Stable ids.** Eigen message ids must survive a move; IMAP UIDs do not. The store mints a local id per message and keeps a `(mailbox, UIDVALIDITY, UID) → id` map in `mail.db`. A move Eigen performs updates the map from the `COPYUID` response (UIDPLUS). A move made in another client shows up as a delete plus a new message, and is re-joined on the `Message-ID` header. A changed `UIDVALIDITY` drops that mailbox's map and resyncs it.
- **Sync.** On `init`: list folders, then per folder fetch what changed — `CONDSTORE`/`QRESYNC` where the server offers them, a UID-range fetch plus a flags refresh where it doesn't. `watch()` holds an `IDLE` on INBOX and turns server pushes into the existing `received` / `flagsChanged` / `deleted` events. Because homes idle out, there is no push while the user is away: mail is current when they open Eigen, and new-mail notifications only fire during a session. That is an accepted limit of v1, not a bug to engineer around.
- **Folders.** Eigen's Sent / Drafts / Trash / Junk / Archive map onto the provider's folders through `SPECIAL-USE` (RFC 6154), with a name-based fallback. Other folders list as they are.
- **Flags.** `seen`, `replied`, `flagged`, `draft` are the IMAP system flags; `forwarded` is the `$Forwarded` keyword where the server permits keywords; `trashed` is a move to Trash.
- **Search.** `search()` is synchronous and runs on the summary index today, so parity costs nothing: the same query over the same table. Server-side full-text (`UID SEARCH`) is a later, async addition.
- **Drafts stay local in v1.** The sidecar + temp-file machinery (`writeDraftMeta`, `persistDraftTemp`, …) assumes in-place rewrites IMAP does not have. Drafts are kept in the home directory and are not visible in other clients until sent. Appending to the provider's Drafts folder is a follow-up.
- **No welcome mail.** `Mail.init` skips the seed when the store is remote.
- **Library.** `imapflow` is the candidate — same maintainers as the already-used `nodemailer`, with XOAUTH2, IDLE, CONDSTORE/QRESYNC and SPECIAL-USE built in. Verify it under Bun before committing to it.

### Sending

The Mail app and iMIP both send *as the acting user* (`messageSend`; `from: organizer.email`, `apps/api/src/lib/calendar/imip.ts:74`). In this mode those sends go through the **user's own SMTP submission** with the same OAuth token, via a per-send transport (nodemailer supports `auth.type: 'OAuth2'`) — so the provider signs them and the `From` is simply true. After a send the store appends the message to Sent, **except** where the provider already files submitted mail itself (Gmail and Exchange Online both do); appending there would duplicate it.

System mail — share notices, OTPs, access requests — has no acting mailbox and keeps using the instance-wide `SMTP_*` relay. One small change rides along: `MAIL_FROM` (and optional `MAIL_FROM_NAME`) overriding `defaultFrom()`, because `noreply@{mailDomain}` is not an address a third-party relay will accept on an instance that does not own that domain's mail.

### Inbound iMIP

With no delivery, the iMIP hook moves: when sync surfaces a **new** INBOX message with a calendar part, the store's `received` event leads to the same `processInboundImip` call `mailboxDeliver` makes today. Two conditions:

- **Trust.** `verifyImipSender` must accept the *provider's* `Authentication-Results` header, so the trusted authserv-id becomes configurable (default `getMailDomain()`, unchanged for hosted mode). This leans on the provider stripping forged headers that carry its own id, as RFC 8601 requires — verify per provider.
- **Once only.** A resync can surface the same message again. Processing must be keyed on the message so an RSVP is never applied twice; verify what `processInboundImip` already tolerates.

Invitations therefore land in the Calendar when the user next opens Eigen, not the instant they arrive.

### Credentials

| Provider kind | How `ImapStore` authenticates | v1 |
|---|---|---|
| **Microsoft 365, Google Workspace** | XOAUTH2 with the token from the SSO sign-in, refreshed from the `account` table | **Yes** |
| **Password / app-password providers** (Fastmail, Migadu, mailbox.org, own dovecot) | A per-user secret Eigen has to keep | **Deferred** |

The second row is deferred because there is no secret storage in the tree today — `settings.json` holds S3 keys in plaintext — and a user's mail password is a worse thing to leak than a scoped, revocable token. It needs encryption at rest with a key outside the data directory, and that design deserves its own decision. The store itself is indifferent: it takes a credential provider, and OAuth is the first one.

OAuth comes with four conditions. The sign-in must request **offline access**, or the token dies in an hour with no refresh token. Refresh runs when a home wakes and before each connect, not on a timer — a home that is asleep needs no token. Google treats mail scopes as **restricted**: free for an app internal to your own Workspace, a verification and security-assessment exercise for a public one — so every instance registers **its own** OAuth app, and the project never ships a shared one. And the `account` table becomes a store of long-lived mailbox credentials, which earns it a row in the next security audit.

### Backend selection

Instance-wide in v1: a `MAIL_BACKEND=imap` setting beside `MAIL_ENABLED`, read where `UserHome` constructs the store. The `mail` docker profile (postfix + dovecot) is off in this mode. Per-home selection — hosted and external mailboxes on one instance — is the same one line later, and not needed for either goal now.

## SSO comes first

[PROPOSAL_SSO.md](PROPOSAL_SSO.md) specifies OIDC through better-auth's `sso` plugin. For this proposal the relevant part is its noted shortcut: **`socialProviders`** for Microsoft and Google with a tenant / `hd` check. It is the cheaper sign-in for a single-domain deployment, and it is the *only* route that can request the provider's mail scopes and keep the resulting tokens — the `sso` plugin federates sign-in and has no notion of API scopes. So the order is fixed: `socialProviders` sign-in, then `ImapStore` on top of its tokens.

SSO also fixes identity. The login form composes `username@mailDomain` (`packages/ui/src/components/layout/pages/login-page.tsx:46`), so an external address cannot sign in today; SSO bypasses the form, and the Eigen identity, the mailbox and the `From` address become the same string.

Protocol clients are unaffected: `verifyProtocolAuth` tries the app password first, so SSO users reach CalDAV, CardDAV and WebDAV with one. IMAP clients point at the provider.

## Reference scenario: one Microsoft 365 mailbox on a local instance

The first thing to build and the dogfood case: a developer runs Eigen on `localhost`, signs in with their work Microsoft account (`dev@company.example`), and sees that mailbox in the Mail app. No tenant mail-flow change, no public host, no stored password.

| Piece | What it takes |
|---|---|
| **Sign-in** | `socialProviders.microsoft` with `tenantId` pinned to the one tenant, so nobody outside it can provision an account. Redirect URI `{API_URL}/auth/callback/microsoft`; Entra accepts `http://localhost` redirect URIs, so no tunnel |
| **Scopes** | `openid profile email offline_access` plus `https://outlook.office.com/IMAP.AccessAsUser.All`, and `https://outlook.office.com/SMTP.Send` for sending |
| **Reading** | `outlook.office365.com:993`, XOAUTH2. For Microsoft 365 OAuth is the only door — basic auth for IMAP is switched off there |
| **Sending** | `smtp.office365.com:587`, XOAUTH2 |

Outside Eigen, in the Entra tenant: an app registration with that redirect URI and the two delegated Office 365 Exchange Online permissions. Whether a plain user may consent to them or an admin must grant consent once is tenant policy, and a tenant can switch IMAP off per mailbox. Eigen cannot work around either, so check both before writing code.

Two Microsoft specifics, both to **verify against a real tenant**:

- **An access token is for one resource.** The Graph scope better-auth's Microsoft provider asks for by default (`User.Read`) and the `outlook.office.com` scopes cannot share a token. Consent covers both in one round-trip, but the stored access token serves one of them; the IMAP token comes from redeeming the refresh token with the Outlook scopes.
- **SMTP AUTH is commonly disabled tenant-wide.** Where it is, `SMTP.Send` is granted and still refused. The fallback is Graph `Mail.Send` — a different send path, not a transport option — which is why reading ships before sending.

`MAIL_DOMAIN` needs a decision here. The user's address is `@company.example` but the instance does not handle that domain's mail: setting `MAIL_DOMAIN=company.example` makes `isInternalAddress` treat every colleague as an Eigen user on this server, and leaving it unset pins outgoing `Message-ID`s to `@localhost`.

## Phases

| | Phase | Delivers | Size |
|---|---|---|---|
| **0** | `socialProviders` sign-in (Microsoft, Google), tenant/domain pin, mail scopes, token refresh helper | SSO for single-domain deployments; tokens in the `account` table | S — tracked in [PROPOSAL_SSO.md](PROPOSAL_SSO.md) |
| **1** | `ImapStore` read path: folders, sync, list, open, attachments, flags, move, delete, IDLE, search on the cache; `MAIL_BACKEND`; no welcome mail | "A view of my mail" — the reference scenario, read-only compose aside | M–L, the bulk of the 1,200–1,500 LOC |
| **2** | Per-user SMTP submission, Sent handling, local drafts, `MAIL_FROM` | Full Mail app | S–M |
| **3** | iMIP from synced messages, configurable trusted authserv-id, once-only guard | Invitations and RSVPs reach the Calendar | S |
| **4** | Secret storage + password providers; drafts on the provider; server-side search | Fastmail-class providers | Separate decision |

## Testing

- `ImapStore` is tested against a real IMAP server, not a mock — the repo's own Dovecot image (`docker/dovecot/`) over a fixture Maildir is the obvious one; how that fits the API suite's harness is a phase-1 decision. Cases: sync, UID map across a move, `UIDVALIDITY` reset, flag round-trip, IDLE → `received`.
- The `MailStore` contract suite runs against both implementations, so the Mail domain's behavior is pinned once.
- Token refresh: an expired access token with a valid refresh token connects; a revoked refresh token surfaces a re-authenticate state, not a 500.
- A synced message with an iMIP part and an aligned `dkim=pass` under the configured authserv-id acts on the Calendar exactly once across two syncs; without the header it does not act.
- `buildMailOptions` uses `MAIL_FROM` when set and `noreply@{mailDomain}` when not.

## Open questions

1. Does the target tenant let a user consent to `IMAP.AccessAsUser.All`, and is IMAP enabled on the mailbox? Both decide whether the reference scenario is reachable at all.
2. Does better-auth 1.7.3's Microsoft provider persist a refresh token that can be redeemed for `outlook.office.com` scopes, given its own default scope is a Graph one? If not, the provider entry drops `User.Read` and reads the profile from the ID token.
3. With an identity at a domain the instance does not serve mail for, should `MAIL_DOMAIN` be that domain or stay unset? Audit every `isInternalAddress` and `getMailDomain()` caller before choosing.
4. Do Exchange Online and Gmail stamp `Authentication-Results` with a stable authserv-id and strip inbound forgeries of it? The inbound-iMIP phase rests on it.
5. What should the Mail app show when the token is revoked or IMAP is unreachable — a store-level "reconnect" state is new UI the Maildir store never needed.
6. `imapflow` under Bun: TLS, IDLE and long-lived sockets all need a smoke test before phase 1 starts.
