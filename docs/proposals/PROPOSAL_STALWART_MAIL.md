# Proposal: Optional Stalwart Mail Backend (JMAP)

> **TLDR**: Add Stalwart Mail Server as an **opt-in alternative** to Eigen's current
> Maildir+Dovecot+Postfix stack. Eigen's BE keeps the same `/mail/*` HTTP routes; behind them, a
> small `MailStore` interface (shipped 2026-07-03) dispatches either to the existing `MaildirStore` class or to a new
> `StalwartMail` class that talks **JMAP over HTTP** to a co-deployed Stalwart instance. The FE
> never sees the difference. Net wins: JMAP for native clients, server-side full-text search,
> inbound DMARC/SPF/ARC verification, inbound spam filtering, Sieve filters. Existing wins we'd
> *replace* but not gain: outbound DKIM signing is already in the Postfix container via
> OpenDKIM. Cost: a second daemon, ~600–900 LOC adapter, a user-provisioning bridge, and the
> loss of "Maildir on disk is the source of truth." This is a feature, not a migration: existing
> Maildir users keep working unchanged. **A `rspamd` sidecar on top of the current stack would
> get the spam/DMARC wins at ~10% of the cost; see *§ Cheaper alternative*.**

## Goals

1. **Eigen users can opt-in to Stalwart** as their mail backend per-deployment (single global
   toggle in server config). Default stays Maildir/Dovecot.
2. **No FE changes.** The `/mail/*` REST surface in `../../apps/api/src/routes/mail.ts` is preserved
   byte-for-byte; the `useEmails`, `useEmail`, `useMailboxes`, `useDraft` hooks under
   `../../packages/lib/src/core/mail` keep their current types and call paths.
3. **External IMAP/SMTP "just work"** on the Stalwart side: native iOS Mail, Thunderbird, mutt,
   Apple Mail can speak IMAP4 or JMAP directly to Stalwart, with no Eigen-in-the-loop. (Today
   they go through Dovecot reading the Maildir.)
4. **Reuse Eigen's auth.** A user authenticated to Eigen never needs to type a second password
   to read their mail through the Eigen UI. External clients authenticate to Stalwart with an
   app-password we provision behind the scenes.
5. **Same Home boundary.** Mail data lives under
   `data/home/{userId}/eigen.mail-stalwart/` (per-user, sharding-friendly), matching the
   existing per-Home storage convention from [STORAGE.md](../STORAGE.md).

## Non-goals

- **Replacing Maildir.** The Maildir path stays. We are not deprecating it. Existing
  installations keep their Postfix+Dovecot stack untouched.
- **Hot-migrating live mail.** Moving an existing user's mail from Maildir to Stalwart is a
  one-shot import (out of scope here; sketched in *§ Migration* as a follow-up).
- **Team or shared mailboxes.** Eigen mail is personal-only today (`requireSelf(ownerId,
  user.id)` in every route); this proposal keeps that invariant. Shared mailboxes would be a
  separate proposal whether or not we adopt Stalwart.
- **Re-architecting iMIP.** The synchronous `processInboundImip()` path stays; we just move the
  trigger point (see *§ Inbound mail*).
- **Building a JMAP client for FE consumption.** The FE talks to Eigen's REST as it does today.
  JMAP is a BE-internal protocol.
- **Reusing Stalwart's CalDAV/CardDAV/WebDAV.** Eigen already has all three. This proposal is
  about mail only.

## Why now

Three things make this a sensible option to evaluate, not a vanity feature:

1. **JMAP is the modern protocol.** RFC 8620 + RFC 8621, JSON over HTTP, real push (RFC 8887
   WebSocket, EventSource). Apple Mail and Fastmail have shipped JMAP clients; the IETF
   trajectory points away from line-based IMAP. Eigen's current path locks us into Dovecot's
   filesystem-coupled design.
2. **Stalwart is feature-complete enough to integrate.** v0.16.5 shipped 2026-05-11; it's been
   stable for >1 year, dual-licensed AGPL-3.0 / SELv1, written in Rust, deployable as one
   binary or one Docker image, supports SQLite/RocksDB/Postgres/S3 storage backends, has
   built-in DKIM/DMARC/SPF/ARC verification + signing, Sieve, anti-spam, and full-text search
   across 17 languages. We already do outbound DKIM signing via OpenDKIM in
   `../../docker/postfix`; what Stalwart adds on top is the *inbound* verification chain (DMARC
   policy enforcement, SPF check, ARC), Sieve scripting, and a spam pipeline — none of which
   exist in the current stack. See [stalwartlabs/stalwart](https://github.com/stalwartlabs/stalwart).
3. **Our seams are clean.** `../../apps/api/src/lib/mail/mail.ts` is already a thin facade
   (`getMailClient(user)` → `home.mail`); the routes in `../../apps/api/src/routes/mail.ts` never
   touch the Maildir filesystem directly. Swapping the implementation is a localised change.

This is exploratory. The goal of this proposal is to decide whether to **prototype** a Stalwart
backend, not to commit to shipping one.

## What Stalwart is

| Property | Value |
|---|---|
| Language | Rust |
| License | AGPL-3.0 (community) / Stalwart Enterprise License v1 (SELv1) |
| Latest stable | v0.16.5 (2026-05-11) |
| Protocols | JMAP, IMAP4rev2, IMAP4rev1, POP3, SMTP submission + MTA, CalDAV, CardDAV, WebDAV, ManageSieve |
| Storage backends | RocksDB (default), FoundationDB, SQLite, PostgreSQL, MySQL, S3, Azure Blob, Redis |
| Full-text | Built-in (17 languages) or Meilisearch / ElasticSearch / OpenSearch / pg / mysql |
| Auth backends | Internal, LDAP, SQL, OIDC |
| Deployment | Single static binary (~25 MB) or `stalwartlabs/mail-server` Docker image |
| Funding | NLnet grants; commercial Enterprise edition |

Stalwart is monolithic by design — "what you install is one mail server, not a stack of services
to glue together" — which is the opposite of Eigen's current Postfix-MTA + Dovecot-store + Eigen-API
arrangement.

## Current state (recap)

Full architecture in [IMAP.md](../IMAP.md); summary here for context.

```
                   Postfix MTA
                       │ POST /mail/deliver/:to (multipart EML)
                       ▼
   ┌──────────────────────────────────────────────┐
   │ Elysia API (apps/api)                        │
   │   routes/mail.ts                             │
   │   lib/mail/mail-domain.ts  (Mail facade)     │
   │   lib/mail/maildir-store.ts  (MaildirStore,  │──┐
   │        behind the MailStore interface)       │  │
   │   lib/mail/maildb.ts   (SQLite cache)        │  │ writes
   └──────────────────────────────────────────────┘  │
                       ▲ reads/writes                │
                       │                             ▼
              data/home/{userId}/eigen.mail/Maildir/{new,cur,tmp}
                                  │
                                  │ shared filesystem
                                  ▼
                          Dovecot IMAP (Docker container)
                          ▲
                          │ checkpassword → POST /internal/auth/verify → verifyProtocolAuth()
                          │
                       IMAP clients
```

Key facts that constrain any swap:

- **Routes are thin.** `routes/mail.ts` only calls the `mail.ts` facade. None of the routes look
  at filenames, Maildir paths, or SQLite columns. The seam is already at facade level.
- **`MaildirStore` is the only implementation today.** Everything specific to Maildir filenames,
  `cur/`/`new/` semantics, `:2,RS` flag suffixes, and the SQLite mirror lives inside the
  `Maildir` class in `apps/api/src/lib/mail/maildir.ts`. Nothing outside that file deals with
  on-disk Maildir format.
- **SSE is internal.** `home.broadcast(buildMailEvent(...))` is fired by the `Maildir` class
  itself. Whatever new implementation we add needs to fire the same events through the same
  `home.broadcast` channel so FE invalidation in
  `../../packages/lib/src/core/mail/sse-handlers.ts` keeps working.
- **iMIP processing is wired to delivery.** `mailboxDeliver` in
  `apps/api/src/lib/mail/mail.ts:37-58` re-parses the message after delivery to feed
  `processInboundImip(home, parsed)`. That coupling has to move when delivery moves out of the
  API process.
- **Outbound is nodemailer.** `../../apps/api/src/lib/core/mailer.ts` uses nodemailer with either
  `SMTP_HOST` or local `/usr/sbin/sendmail`. Stalwart would simply *be* the SMTP host.
- **Mail is per-user only.** `home.mail` is a singleton per `UserHome`. No `TeamHome` or
  `OrgHome` mail exists. The proposal preserves that.

## Integration model

There are three plausible shapes; I think one is right.

### Option A — Stalwart as the JMAP-spoken store, Eigen as a JMAP client (recommended)

Eigen keeps its `/mail/*` REST routes. Behind the facade, a new `StalwartMail` class talks JMAP
to a co-deployed Stalwart. Postfix is gone — Stalwart is the MTA. Dovecot is gone — Stalwart
serves IMAP and JMAP directly. The Maildir on disk is gone in Stalwart mode (Stalwart has its
own RocksDB or SQLite store).

```
       External SMTP                                External IMAP / JMAP clients
            │                                                  │
            ▼                                                  ▼
       ┌─────────────────────────────────────────────────────────┐
       │ Stalwart (Docker container)                             │
       │   ports: 25 (SMTP MTA), 587 (submission), 993 (IMAPS),  │
       │          8080 (JMAP), 4190 (ManageSieve)                │
       │   storage: RocksDB at data/stalwart/                    │
       │   directory: HTTP-bridge OR SQL on auth.db (better-auth)│
       └─────────────────────────────────────────────────────────┘
                              ▲    │
                       JMAP   │    │ JMAP EventSource (push)
                       calls  │    ▼
                       ┌──────────────────────────────────────────┐
                       │ Elysia API (apps/api)                    │
                       │   routes/mail.ts        (unchanged)      │
                       │   lib/mail/mail.ts      (facade)         │
                       │   lib/mail/stalwart.ts  (new — JMAP)     │
                       │   lib/mail/maildir.ts   (kept as fallback)│
                       └──────────────────────────────────────────┘
                              ▲
                              │ /mail/* REST (unchanged)
                              │
                          Eigen FE
```

Pros: clean seam, no Postfix needed at all (Stalwart is the MTA), no Dovecot at all (Stalwart
is the IMAP server), proper JMAP for external clients, FE untouched. Cons: Stalwart owns mail
storage — we lose the "Maildir on disk is the source of truth" property; backups become
"back up Stalwart's data dir" instead of "back up plain files."

### Option B — Stalwart as the protocol shell over Eigen's Maildir

Theoretically Stalwart could read our existing Maildir. It can't, today: Stalwart's IMAP server
reads from its own storage backend, not from a foreign Maildir tree. We'd have to write a custom
Stalwart storage adapter (Rust crate), upstream-or-fork, and maintain it. **Not viable.**

### Option C — Stalwart sidecar for JMAP only, Dovecot kept for IMAP, Maildir kept

Keep current Maildir+Dovecot+Postfix. Run Stalwart in JMAP-only mode pointed at the *same*
Maildir directory. Same blocker as B: Stalwart's JMAP server is fed from Stalwart's own store,
not an external Maildir. **Not viable.**

→ **Pick Option A.** It is the only model Stalwart actually supports.

## The seam

Today, `../../apps/api/src/lib/mail/mail.ts` does `home.mail.<method>(...)` for every operation.
`home.mail` is typed as `Maildir`. Make `home.mail` typed as an interface:

```typescript
// apps/api/src/lib/mail/mail-backend.ts
export interface MailBackend {
    init(): Promise<void>;
    destruct(): Promise<void>;
    size(): Promise<number>;

    mailboxesList(): Promise<MaildirMailbox[]>;
    mailboxCreate(name: string): Promise<void>;
    mailboxExists(name: string): Promise<MaildirMailbox | false>;
    mailboxGet(name: string): Promise<EmailSummary[]>;
    mailboxDeliver(message: string): Promise<string>;

    messageGet(id: string): Promise<Email | null>;
    messageGetFile(id: string): Promise<ArrayBuffer>;
    messageGetAttachment(id: string, index: number): Promise<Attachment>;
    messageGetAttachments(id: string): Promise<Attachment[]>;
    messageDelete(id: string): Promise<void>;
    messageMove(id: string, target: string): Promise<void>;
    messageCopy(id: string, target: string): Promise<void>;
    messageSetRead(id: string, read: boolean): Promise<void>;
    messageSetFlagged(id: string, flagged: boolean): Promise<void>;

    messageHandleDraft(mail: NewDraft | EmailDraft, opts?: DraftUpdateOptions): Promise<EmailDraft>;
    uploadDraftAttachment(req: Request, maxSize: number): Promise<DraftAttachmentUpload>;
    stageDriveAttachment(file: StorageFile, name: string, ct: string, max: number): Promise<DraftAttachmentUpload>;
    messageSend(mail: NewDraft | EmailDraft): Promise<EmailDraft>;
}
```

The `Maildir` class already implements every one of these methods — that's the existing surface
of `apps/api/src/lib/mail/maildir.ts:68-808`. Lift the interface from the class, no behaviour
change.

Selection happens once, in `UserHome.init()`:

```typescript
// apps/api/src/lib/home/user-home.ts (sketch)
const backend = getServerSettings().defaults.mail.backend; // 'maildir' | 'stalwart'
this.mail = backend === 'stalwart'
    ? new StalwartMail(this)
    : new Maildir(this);
await this.mail.init();
```

Per-deployment global setting via `serverSettings.defaults.mail.backend`, matching the
pattern used by `defaults.mount.storageType` in `../../apps/api/src/lib/config/server-settings.ts`.
Per-user opt-in could come later; the v1 toggle is global.

This is the *only* code change outside `../../apps/api/src/lib/mail`.

## The new file: `apps/api/src/lib/mail/stalwart.ts`

`StalwartMail` implements `MailBackend` by translating each call into JMAP method calls against
the co-deployed Stalwart instance. Dependencies and shape:

- **HTTP client**: native `fetch` is enough. The Bun runtime has it. JMAP request batching means
  one HTTP round-trip can contain multiple JMAP method calls — useful for compound operations
  like "move + mark seen."
- **Library**: prefer `jmap-jam` (~2 KB, zero deps, Node 18+/Bun-compatible, Web Fetch) over
  `jmap-client-ts` (heavier, more opinionated transport). Both are TypeScript. Verify
  Stalwart-specific extensions (e.g. push, blob endpoints) work against either before locking
  in.
- **Session bootstrap**: on `init()`, `GET /jmap/session` once, cache `apiUrl`, `eventSourceUrl`,
  `downloadUrl`, `uploadUrl`, and `accountId` for the user.
- **Auth header**: `Authorization: Bearer <token>` per-request. Token is the per-user Stalwart
  app-password fetched from `auth.db` (see *§ Authentication*).
- **Type adaptation**: JMAP types and Eigen types diverge in shape (JMAP `Email` is much
  richer). The adapter projects JMAP responses into `EmailSummary` / `Email` / `MaildirMailbox`
  shapes from `../../packages/lib/src/types/mail.ts` so the FE contract is unchanged.

### JMAP method mapping

| `MailBackend` method | JMAP call(s) | Notes |
|---|---|---|
| `mailboxesList()` | `Mailbox/get` then map by `role`: `inbox`→`''`, `sent`→`'Sent'`, `drafts`→`'Drafts'`, `trash`→`'Trash'`, `junk`→`'Junk'`, `archive`→`'Archive'` | Cache mailbox-id ↔ name map per session; `Mailbox/changes` invalidates |
| `mailboxCreate(name)` | `Mailbox/set { create }` | Honours `STANDARD_MAILBOXES` |
| `mailboxExists(name)` | look up cached mailbox map | No round-trip |
| `mailboxGet(name)` | `Email/query { filter: { inMailbox } } + Email/get` (chained via JMAP `#ids` back-reference) | Single HTTP request via batching |
| `mailboxDeliver(message)` | `Email/import` (RFC 8621 §2.5) — accepts raw RFC 822 blob, returns server-assigned id | The Postfix path goes away in Stalwart mode (see *§ Inbound mail*); this method exists for legacy callers like `welcome.ts` |
| `messageGet(id)` | `Email/get { ids, properties: [bodyValues, attachments, ...], fetchTextBodyValues: true }` | Stalwart returns body + parsed metadata in one call; no EML round-trip |
| `messageGetFile(id)` | `Email/get { properties: [blobId] }` then `GET /jmap/download/{accountId}/{blobId}/{name}` | Raw RFC 822 |
| `messageGetAttachment(id, index)` | resolve `attachments[index].blobId` from `Email/get`, then `/jmap/download/...` | Same path |
| `messageDelete(id)` | `Email/set { destroy: [id] }` | |
| `messageMove(id, target)` | `Email/set { update: { id: { mailboxIds: { newId: true, oldId: null } } } }` | JMAP "patch" semantics |
| `messageCopy(id, target)` | `Email/copy { fromAccountId, ifInState, create }` | Cross-account copy works the same way intra-account |
| `messageSetRead(id, r)` | `Email/set { update: { id: { "keywords/$seen": r \|\| null } } }` | |
| `messageSetFlagged(id, f)` | `Email/set { update: { id: { "keywords/$flagged": f \|\| null } } }` | |
| `uploadDraftAttachment(req)` | stream multipart parts to `POST /jmap/upload/{accountId}` → `{ blobId, size, type }` | Bun's streaming `Request` body works; same `maxSize` enforcement at the route boundary |
| `messageHandleDraft(mail)` | `Email/set { create: { tempKey: { mailboxIds, keywords: { $draft }, from, to, subject, bodyValues, attachments: [{ blobId }] } } }` for new; `Email/set { update }` for existing. Drop the fast-path EML-vs-sidecar dance entirely — JMAP's structured payload makes it irrelevant. | The current `DraftMeta` sidecar exists *because* Maildir requires an EML rebuild on every save. JMAP doesn't. The Stalwart backend can update fields directly. ~150 LOC of `draftFullSave`/`draftFastSave` disappears |
| `messageSend(mail)` | `EmailSubmission/set { create: { tempKey: { emailId: "#draftKey", identityId, envelope } } }` chained with the draft `Email/set`. Stalwart moves to Sent automatically per `onSuccessUpdateEmail` / `onSuccessDestroyEmail` JMAP options | Replaces the nodemailer SMTP call entirely for Stalwart users |

### What goes away in Stalwart mode

- **The `cur/`/`new/` filesystem watcher** (`MaildirStore.watchMailboxes`) — replaced by JMAP
  EventSource subscription.
- **The Maildir SQLite cache** (`maildb.ts`) — Stalwart is the cache.
- **The sync engine** (`Maildir.doSyncMailbox`) — Stalwart is authoritative; no reconciliation
  needed.
- **The draft fast-path** (`DraftMeta` sidecar) — JMAP can patch fields without an EML rebuild.
- **The Postfix→`/mail/deliver` bridge** — Stalwart receives mail itself.
- **The Dovecot container** — Stalwart serves IMAP.

What stays: everything in `../../packages/lib/src/core/mail` (hooks, SSE handlers, types), every
route in `../../apps/api/src/routes/mail.ts`, every `/mail/*` HTTP contract.

## Authentication

This is the load-bearing part. Eigen authenticates with better-auth (email/password, optional
2FA, optional app passwords). Stalwart needs to authenticate the same users for:

1. **Eigen BE → Stalwart JMAP** (when the API process serves the user's `/mail/*` request).
2. **External clients → Stalwart IMAP/JMAP/SMTP** (when the user sets up iOS Mail).

Stalwart supports four directory backends: Internal, LDAP, SQL, OIDC
([stalw.art/docs/auth/backend/overview](https://stalw.art/docs/auth/backend/overview/)).
There is **no native HTTP-callback / webhook backend** — which is what we'd ideally use to point
Stalwart at our existing `/internal/auth/verify` endpoint, the way Dovecot does today via
`checkpassword`. So we have to bridge.

Three options ranked best to worst for our case:

### A1 — SQL backend reading better-auth's tables (recommended)

Stalwart's SQL backend executes configurable queries to look up principals and verify passwords.
Point it at `data/auth.db` (better-auth's SQLite) with queries like:

```toml
[directory."eigen-auth".lookup.query]
name = "SELECT id, email FROM user WHERE email = ?"
auth = "SELECT password FROM account WHERE userId = (SELECT id FROM user WHERE email = ?)"
```

Verify the hash format. better-auth's default is `scrypt` per its source; Stalwart's SQL
backend supports `bcrypt`, `argon2`, `scrypt`, `pbkdf2`, plain. If the formats match
out-of-the-box, this is the cleanest path: zero new infrastructure, single password of truth,
2FA automatically *bypassed* for protocol auth (matching the current
`verifyProtocolAuth` behaviour for non-2FA users — we'd need to handle 2FA users separately by
forcing them onto app-passwords).

If hash formats *don't* match: write a tiny `bridge.db` view computed from better-auth's table
that re-encodes the hash on every update. Trigger-maintained, no new write path.

App-passwords: better-auth API keys live in a separate table; either include them in the SQL
query with a `UNION` (so "is this string a valid password for this email?" returns true for
both primary and app-password rows) or wire a second `auth = ...` query.

### A2 — Provisioned per-user Stalwart accounts (fallback)

On Eigen user creation, Eigen calls Stalwart's management API
([stalw.art/docs/api](https://stalw.art/docs/api)) to create a matching internal account with a
*generated* per-user app-password. Eigen stores that app-password encrypted in
`auth.db` (alongside the better-auth API key table) and uses it for BE→Stalwart calls. The
user never sees this password.

For external clients, the user generates an Eigen app-password as today (via the UI under
account settings); Eigen pushes that to Stalwart as a *second* Stalwart app-password under the
same Stalwart account. External clients use it.

Pros: no SQL coupling, no hash-format risk, works regardless of better-auth version. Cons: two
sources of truth, drift risk on password change (need a hook), more code.

### A3 — Stalwart as OIDC client to Eigen (defer)

Stalwart can act as OIDC consumer. Eigen does not expose OIDC today. Standing one up would be a
much larger project (it's been considered separately for SSO and is its own proposal). Not in
scope here.

→ **Prototype A1 first.** If the hash format mismatch or 2FA-handling friction is bad, fall to
A2. Cross out A3 unless we're independently building OIDC.

The protocol-auth path
(`apps/api/src/lib/auth/protocol-auth.ts:32-50`) keeps its current shape; Dovecot's
`checkpassword` script goes away in Stalwart mode.

## Inbound mail

Today: Postfix → `POST /mail/deliver/:to` → `mailboxDeliver(to, file)` →
`processInboundImip(home, parsed)` synchronously. The blocking iMIP parse is important: clients
querying their calendar right after delivery must see the new event.

With Stalwart, the Postfix container goes away. Stalwart is the MTA. Eigen never sees inbound
mail at the SMTP layer.

**Replacement for iMIP**: subscribe to Stalwart's JMAP EventSource (`GET /jmap/eventsource`) and
react to `Email` state changes. On a new email with `text/calendar` part:

```typescript
// Inside StalwartMail.init() — pseudo-code
const events = new EventSource(session.eventSourceUrl + '?types=Email&closeafter=no&ping=30');
events.addEventListener('state', async (ev) => {
    const { changed } = JSON.parse(ev.data);
    if (!changed[accountId]?.Email) return;
    // Fetch newly-arrived emails and check for iMIP parts
    const arrivals = await jmap.callMethod('Email/changes', { sinceState: lastState, accountId });
    for (const id of arrivals.created) {
        const email = await jmap.callMethod('Email/get', { ids: [id], properties: ['attachments', 'bodyStructure'] });
        if (email.attachments?.some(a => a.type === 'text/calendar')) {
            // Pull raw RFC 822, run existing processInboundImip
            const blob = await fetch(downloadUrl(email.blobId));
            const parsed = parseMail(Buffer.from(await blob.arrayBuffer()));
            await processInboundImip(home, parsed);
        }
        // Mirror to home.notifications + home.broadcast (MAIL_RECEIVED), matching Maildir flow
    }
});
```

One EventSource per `UserHome` (cheap), shut down in `destruct()`. This replaces the
`fs.watch()` + `syncMailbox()` pipeline.

**iMIP latency**: previously synchronous to delivery; now event-driven (sub-second under normal
operation). For most flows this is fine. The one place it isn't is *concurrent* request
ordering: if the user opens calendar at the same moment delivery completes, the calendar query
may briefly precede iMIP processing. Mitigation: serialise via `Promise.all`-style barrier
during the EventSource handler. Acceptable for v1.

## Outbound mail

Today: `../../apps/api/src/lib/core/mailer.ts` uses nodemailer with `SMTP_HOST` or
`/usr/sbin/sendmail`. The same path is used for *both* the welcome mail
(`Maildir.welcomeMail`), system emails (shares, password resets in `mail-composers.ts`), and
user-composed mail (`Maildir.messageSend`).

In Stalwart mode:

- **User-composed mail**: `Maildir.messageSend → sendMail()` replaced by
  `StalwartMail.messageSend()` doing `Email/set { create } + EmailSubmission/set` in a single
  JMAP batch. Stalwart submits to the network; we never touch SMTP from the API process.
- **System emails** (`mail-composers.ts`, used for share-access notifications, password resets,
  etc.): still use nodemailer, but point `SMTP_HOST` at Stalwart's submission port (587). One
  config line. Stalwart authenticates the submission via a dedicated `eigen-system@...` Stalwart
  account; that account's app-password lives in env.

This means `mailer.ts` doesn't change — it just talks to a different SMTP host. The
backend-conditional code is all inside `StalwartMail.messageSend`.

## SSE bridge

The current Maildir backend emits `MAIL_RECEIVED`, `MAIL_DELETED`, `MAIL_MOVED`,
`MAIL_FLAGS_CHANGED`, `MAIL_READ_CHANGED`, `MAIL_DRAFT_UPDATED`, `MAIL_SENT` via
`home.broadcast(buildMailEvent(...))`. The FE handler in
`../../packages/lib/src/core/mail/sse-handlers.ts` invalidates query keys on these.

`StalwartMail` does the *same emission*. The trigger source changes (JMAP EventSource state
changes → fan-out to Eigen SSE), the emission pattern doesn't. FE is unaware.

There's one subtlety: JMAP state changes are *delta-encoded* (`Email/changes` returns
`created`, `updated`, `destroyed` since `lastState`). The translation layer maintains
`lastState` per `Email` collection per account, calls `Email/changes`, then emits an Eigen SSE
event per affected id with the right type. Routine bookkeeping, ~80 LOC.

## Search (incidental win)

Today: mail full-text search has shipped — an `emails_fts` FTS5 table in `mail.db`, kept in sync
by triggers and queried through `MailDB.searchMail` (see [SEARCH.md](../SEARCH.md)). But it indexes
only what `mail.db` stores: `subject`, `fromShort`/`fromAddress`, `toShort`/`toAddress`,
`recipientsAll`, `textShort` — the trimmed summaries, not full message bodies.

JMAP includes `Email/query` with a `text` filter that runs against Stalwart's built-in FTS
across full bodies. If Stalwart mode is enabled, a `useMailSearch(query)` hook becomes trivial
(one `Email/query` call). The unified-search index still indexes summaries; for "search mail
bodies" the user gets a strictly better experience on Stalwart.

Not in v1 scope, but cheap to add later. Worth noting because it's the kind of thing that makes
the option attractive beyond protocol modernity.

## Storage and deployment

### Single-binary mode (recommended for self-hosted Eigen)

Stalwart ships as a single ~25 MB static binary. Eigen's deployment already runs as a Docker
Compose stack (`../../docker`). Add one service:

```yaml
# docker-compose.yml (sketch — Stalwart mode)
services:
  stalwart:
    image: stalwartlabs/mail-server:latest
    volumes:
      - ./data/stalwart:/opt/stalwart-mail/data
      - ./data/auth.db:/opt/stalwart-mail/auth.db:ro       # for SQL directory backend
      - ./docker/stalwart/config.toml:/opt/stalwart-mail/etc/config.toml:ro
    ports:
      - "25:25"
      - "587:587"
      - "993:993"
      - "8080:8080"  # JMAP (behind Caddy)
    depends_on:
      - api
```

Replaces the `dovecot` and `postfix` services. Adds `data/stalwart/` to the backup set.

### Storage backend choice

Stalwart's RocksDB backend is the default and the path most-tested upstream. SQLite is also
supported but Stalwart documents it as preferring RocksDB for production. Pick RocksDB —
matches upstream defaults and we get LSM-level compression.

Data layout under the Home root no longer applies: Stalwart owns one big RocksDB per Stalwart
instance, *not* per-user. For sharding (per `../SCALABILITY.md`), this is a regression —
Stalwart's account isolation is logical, not filesystem-physical. Acceptable for v1 because
sharding mail homes wasn't a 2026 priority anyway, but worth flagging.

### Resource footprint

Stalwart's docs are sparse on hard numbers. From community reports the binary idles around
80–120 MB RAM, peaks higher under heavy traffic. Add ~150–250 MB to the running deployment over
Dovecot+Postfix combined (which run ~100 MB together). Disk is comparable per-message; RocksDB
adds some overhead vs raw EML files but compresses bodies.

## Migration path

This proposal does **not** propose migrating existing users. If we ship it:

- **Default**: Maildir/Dovecot/Postfix, exactly as today.
- **New deployments** can opt for Stalwart by setting
  `serverSettings.defaults.mail.backend = 'stalwart'` and including the Stalwart service in
  their Compose file. Their `UserHome.init()` picks `StalwartMail`.
- **Existing Maildir deployments** stay on Maildir. No automated migration.

A *future* migration (not in this proposal) would iterate over a user's Maildir, JMAP
`Email/import` each `.eml` into Stalwart with the right keywords and mailbox role, then flip
the per-user backend pointer. The Eigen-side draft sidecar wouldn't migrate (drafts get a full
save first). One-shot, idempotent, in a background job. Out of scope here.

## Phased rollout

Each phase is independently shippable / abandonable.

| Phase | Scope | Why this order |
|---|---|---|
| **0 — Spike** | Stand up Stalwart in a throwaway Docker, point `jmap-jam` at it, write 200-line manual JMAP exerciser hitting `Email/import` + `Email/query` + `Email/get`. Verify SQL backend reads `auth.db`. | Find showstoppers before writing the adapter |
| **1 — `MailBackend` interface** | Refactor `Maildir` to implement an explicit interface. No behaviour change. | Lock in the seam before building the second implementation |
| **2 — `StalwartMail` adapter** | Build the new class implementing read-only: `mailboxesList`, `mailboxGet`, `messageGet`, `messageGetFile`, `messageGetAttachment`. SSE bridge for `MAIL_RECEIVED`. Behind a hidden flag. | Smallest useful slice — read your mail. |
| **3 — Mutations** | `messageDelete`, `messageMove`, `messageCopy`, `messageSetRead`, `messageSetFlagged`, `mailboxCreate`. | Mutable mail. |
| **4 — Drafts + send** | `messageHandleDraft`, `uploadDraftAttachment`, `stageDriveAttachment`, `messageSend` (via JMAP `EmailSubmission/set`). | Compose. |
| **5 — iMIP via EventSource** | Hook the Stalwart EventSource handler to call the existing `processInboundImip`. | Calendar invites work. |
| **6 — Server settings + docs** | Expose `defaults.mail.backend` in admin UI, document the Compose changes, ship as alpha-opt-in. | User-visible. |

Phase 0 takes 1–2 days. Phase 2 is the riskiest (auth, type adaptation, EventSource). If phases
2–4 each take a week, we're looking at ~6 weeks total for someone going at it focused, plus
test coverage in `../../apps/api/src/test/mail/mail.test.ts` running against an ephemeral Stalwart Docker.

## Risks and reasons not to do this

- **Stalwart owns the data.** "Maildir on disk is the source of truth" is gone in this mode.
  Backups become RocksDB snapshots. Recovery requires a working Stalwart binary. This is a
  meaningful philosophical shift for a "self-hosted Google" — currently you can `tar` a
  Maildir and restore on any IMAP server, full stop.
- **Stalwart's release cadence is fast.** v0.x means breaking changes are possible. Pin the
  Docker tag, plan for upgrade testing.
- **AGPL-3.0 next to MIT.** Eigen is MIT-licensed. Running an unmodified Stalwart binary in
  the same Docker stack does *not* relicense Eigen — AGPL §13's source-disclosure obligation
  applies to modifications of the AGPL'd software itself when offered as a network service,
  not to MIT code that talks to it over a network protocol. The boundary is clean: our `fetch`
  calls to `:8080/jmap` are no different in license terms from a user's iOS Mail client
  talking IMAP to Stalwart. If we ever *fork* Stalwart and modify it, that fork must be
  AGPL'd; Eigen proper stays MIT. Worth documenting clearly in `../CONTRIBUTING.md` and the
  Stalwart-mode setup guide so contributors don't mix the codebases by accident.
- **One more daemon to operate**. Dovecot+Postfix are well-understood. Stalwart is younger;
  fewer docs/SO answers. Self-hosters debugging mail issues will have a steeper learning
  curve.
- **DKIM key migration on switch.** Postfix mode auto-generates `eigen.private` at
  `/data/dkim/` on first run with selector `eigen`. Stalwart generates its own selector and
  key. A user switching from Postfix mode to Stalwart mode would need to either (a) re-publish
  the new DNS TXT record and accept a brief deliverability dip while caches expire, or (b)
  feed Stalwart the existing private key so the same selector keeps working. Stalwart
  automates DKIM key *rotation* (rotate-on-schedule, propagate, activate, retire), which
  Postfix+OpenDKIM does not — that's a real upgrade if you care about it, but the initial
  transition is real work.
- **JMAP-client library risk.** Both `jmap-jam` and `jmap-client-ts` are small projects.
  `jmap-jam` is 2KB and could become unmaintained; `jmap-client-ts` is heavier. We may end up
  writing our own thin JMAP client (~300 LOC) rather than depending on either — this is fine,
  JMAP-over-HTTP is simple.
- **2FA users**. Today, `verifyProtocolAuth` refuses primary-password auth when 2FA is enabled
  — users with 2FA must use app passwords. Same rule for Stalwart via the SQL backend: only
  app-password rows in the bridge query. Confirm before coding.
- **iMIP timing**. Moving iMIP processing from synchronous-to-delivery (current) to
  event-driven (Stalwart EventSource) introduces a small race window. Almost certainly fine,
  but a known regression.

## Open questions

1. **Does Stalwart's SQL directory backend support better-auth's password hash format
   directly?** Need to verify by running Phase 0. If not: bridge table.
2. **How does Stalwart handle `Mailbox` roles for our 6 standard mailboxes?** RFC 8621 defines
   `inbox`, `sent`, `drafts`, `trash`, `junk`, `archive` — exact match. But what does Stalwart
   do for `Mailbox/set { create }` of a non-role mailbox? Should match IMAP `LIST` semantics;
   verify.
3. **Can `Email/changes` lag induce false unread counts?** JMAP's `Mailbox.totalEmails` /
   `unreadEmails` are eventually consistent. The FE caches unread counts; need to confirm we
   can refresh on demand without thrash.
4. **Sieve filters**: Stalwart speaks ManageSieve. Worth exposing a "Mail filters" UI later? Not
   v1, but the option is there.
5. **What's the right per-user app-password lifecycle?** Auto-rotate? Revoke on
   password change? Probably: tie to better-auth API key rotation, so users see one consistent
   "app passwords" list across mail / WebDAV / CalDAV / IMAP — the existing model.
6. **Multi-instance scaling**: with Maildir, each Eigen Home could in principle live on a
   different filesystem. With Stalwart, all homes share one Stalwart cluster. Is that OK at our
   scale targets in [SCALABILITY.md](../SCALABILITY.md)? Probably yes — Stalwart's FoundationDB
   backend is built for horizontal scale — but worth re-reading SCALABILITY.md against this.

## Cheaper alternative — `rspamd` sidecar on the existing stack

Most of the *concrete user pain* this proposal solves — inbound spam, DMARC/SPF/ARC
verification — does not require Stalwart. It requires an inbound filtering daemon. `rspamd` is
the obvious one: well-maintained, fast (Lua/C), used by everyone from Mailcow to ProtonMail's
inbound chain, and integrates with Postfix as a milter (same socket protocol OpenDKIM already
uses).

Sketch:

```
# docker/rspamd/Dockerfile (new, ~15 lines)
FROM rspamd/rspamd:stable
# preload spam corpora, configure DMARC/SPF/DKIM verification on inbound,
# arc-sign outbound after OpenDKIM signs

# docker/postfix/main.cf.template diff
smtpd_milters = inet:localhost:8891 inet:rspamd:11332    # add rspamd alongside opendkim
```

What we get:
- Inbound SPF check (already in rspamd default config)
- Inbound DMARC enforcement (already in rspamd default config; configurable reject/quarantine)
- Inbound ARC verification + outbound ARC signing
- Statistical + Bayesian spam scoring; rspamd's Greylisting; DNSBL lookups
- Web UI on `:11334` for tuning (admin-only)

What we don't get:
- JMAP (still IMAP via Dovecot)
- Server-side mail FTS (still subject/from-only via SQLite cache)
- Sieve scripting (deferred)
- The "all in one server" operational simplicity (we'd have *more* daemons, not fewer)

Cost: ~1 day to wire up. One new container. No code changes in `../../apps/api`.

**The two paths are not mutually exclusive.** Adding rspamd now does not preclude adding the
Stalwart backend later. If the question is *"how do we make Eigen mail better in 2026Q3"*,
rspamd is the answer. If the question is *"how do we modernise the mail stack on a 12-month
horizon"*, the Stalwart adapter is. Pick based on which question you're actually asking.

## Decision

The Stalwart adapter is technically clean and the seam is well-placed, but the user-facing
value is narrower than the engineering cost. The biggest "deliverability" wins (DMARC, SPF,
ARC, inbound spam) are addressable by `rspamd` on top of the existing stack at ~1 day of work
vs ~6 weeks. JMAP is the one thing only Stalwart gives us, and no one is asking for it today.

Recommendation, in order:

1. **Land the `rspamd` sidecar** (1–2 days). Standalone proposal, no dependency on this one.
   Fixes the actual mail pain.
2. **Land Phase 1 — `MailBackend` interface refactor** (half a day). Pure cleanup, no
   behaviour change, lets the existing `Maildir` class implement an explicit contract. Buys
   optionality for any future backend (Stalwart, JMAP-only Cyrus, future Stalwart fork).
3. **Defer Phases 2–6** (the actual Stalwart adapter) until either (a) a concrete user asks
   for JMAP, or (b) we hit an operational ceiling with the Postfix+Dovecot+rspamd stack that
   Stalwart would clear. The 1–2 day Phase 0 spike against an ephemeral Stalwart Docker stays
   on the table — running it costs nothing and produces evidence for the eventual decision.

## Reference

- Existing mail architecture: [IMAP.md](../IMAP.md)
- Storage layout: [STORAGE.md](../STORAGE.md)
- Scaling considerations: [SCALABILITY.md](../SCALABILITY.md)
- Stalwart Mail Server: [stalw.art](https://stalw.art/) / [github.com/stalwartlabs/stalwart](https://github.com/stalwartlabs/stalwart)
- JMAP Core: [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620)
- JMAP Mail: [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621)
- JMAP WebSocket: [RFC 8887](https://datatracker.ietf.org/doc/html/rfc8887)
- JMAP Blob: [RFC 9404](https://datatracker.ietf.org/doc/html/rfc9404)
- JMAP Quotas: [RFC 9425](https://datatracker.ietf.org/doc/html/rfc9425)
- JMAP Sieve: [RFC 9661](https://datatracker.ietf.org/doc/html/rfc9661)
- TS JMAP clients: [jmap-jam](https://www.npmjs.com/package/jmap-jam), [jmap-client-ts](https://github.com/linagora/jmap-client-ts)
