# Deep-dive: the mail domain + backend abstraction

_Companion to [AUDIT.md](AUDIT.md). Scope: `apps/api/src/lib/mail/` (maildir.ts 837, the mail-parser/
MIME fork 1424+, maildir-store.ts, maildb.ts, mail-split/, sender.ts), `routes/mail.ts`. Includes the
future-proofing analysis you asked for: making mail swappable for another backend (Stalwart/JMAP, or
an external IMAP account as a source)._

**Grade: C+.** The architecture is genuinely clean — thin authz-consistent routes, a single facade
seam, atomic Maildir writes, drift-free FTS triggers. It ships two P1s (one exposed endpoint, one
charset-corruption-on-write), and it carries a 5.3k-LOC vendored MIME fork with dead modules and
happy-path-only tests over untrusted internet input. Would be a B+ without the two P1s.

## How mail actually flows today

Verified against code + docker, because the audit should reflect the real pipeline:

- **Inbound:** internet SMTP → Postfix container (OpenDKIM outbound signing, 25 MB cap) → pipe
  transport `docker/postfix/eigen-deliver` → `curl POST http://eigen-api:8000/mail/deliver/:to` →
  `mailboxDeliver` (mail.ts:17) → `MaildirStore.deliverAtomic` (tmp/ → rename new/) → `syncMailbox`
  parses the EML, inserts a summary row into `mail.db`, emits `MAIL_RECEIVED` SSE + coalesced
  notification. iMIP calendar parts are processed **synchronously** in the same request (mail.ts:28).
- **Storage:** Maildir++ on local disk under `{home}/eigen.mail/Maildir` is the source of truth;
  `mail.db` (Drizzle/SQLite, v3) is a rebuild-safe summary cache + FTS5 index. Bodies are **re-parsed
  from the EML on every read**; only summaries are cached. `mail.db` is never VACUUM'd or S3-staged, so
  the external-content-FTS-rowid hazard is unreachable.
- **Outbound:** `messageSend` (maildir.ts:638) → full EML rebuild into Drafts → `sendMail`
  (core/mailer.ts, nodemailer → `SMTP_HOST=postfix:25`) → move to Sent.
- **IMAP:** Dovecot reads the same Maildir; auth via checkpassword → `POST /internal/auth/verify`.
  Eigen and Dovecot coexist via the scan-based `doSyncMailbox` 3-way diff + `fs.watch`.
- **Search:** `home.mail.search()` → `MailDB.searchMail` two-pass FTS JOIN + Drizzle hydrate.

## P1 findings

### `/mail/deliver/:to` is internet-reachable and unauthenticated [certain]

Full write-up is finding 1 in [AUDIT.md](AUDIT.md) (shared root cause with `/internal/auth/verify`).
In short: `requireLocalhost` (routes/mail.ts:50) trusts the socket peer, which behind Caddy is the
trusted bridge IP, and Caddy's `handle_path /eigen/*` proxies `/eigen/mail/deliver/*` with no
exclusion. An internet caller injects arbitrary RFC822 into any inbox (phishing that bypasses
SPF/DKIM/DMARC because it never transits SMTP) and, because delivery runs `processInboundImip`
synchronously, injects spoofed calendar invites. Postfix reaches the API directly on the bridge, so a
Caddy `respond 404` for `/eigen/mail/deliver/*` costs nothing. **Fix:** the edge exclusion +
`requireLocalhost` rejecting when `X-Real-IP`/`X-Forwarded-For` are present.

### Inbound 8-bit / non-UTF-8 mail is corrupted before it's written to disk [certain]

```ts
// mail.ts:22-24
const message = new TextDecoder().decode(new Uint8Array(file));  // lossy for non-UTF-8 bytes
const result = await home.mail.mailboxDeliver(message);
```

`TextDecoder` defaults to `utf-8`, non-fatal, so any byte that isn't valid UTF-8 (Latin-1 `8bit`
bodies, raw ISO-8859-1 / Shift-JIS headers, binary MIME parts) becomes U+FFFD. That string is written
as the `.eml` **source of truth**, and the `,S=` size hint is computed from the mangled length. The
parser's entire charset machinery (`iconv-lite`, `JPDecoder`) then runs on already-destroyed bytes. The
route receives a clean `ArrayBuffer` (`parse: 'arrayBuffer'`), so the corruption is purely the string
conversion. `deliverAtomic` already accepts `string | Buffer`. `messageCopy` (maildir.ts:257) has the
same `.text()` round-trip. **Fix:** pass the `Buffer` through unchanged; decode only for the throwaway
iMIP parse (or hand `simpleParser` the Buffer). This is a data-integrity bug on a frozen persisted
format with live users.

## P2 findings

- **`mail-split/` ships three dead modules (~360 LOC):** `node-rewriter.ts` (199), `node-streamer.ts`
  (129), `message-joiner.ts` (30) — zero importers (grep-verified). They're the write/rewrite half of
  upstream `mailsplit` that Eigen only reads. Delete all three (also resolves the triple `FlowedDecoder`
  instantiation). _[certain]_
- **Header key typo `disposition-notification.ts-to`** (mail-parser.ts:600, 644) — the RFC 3798 header
  is `disposition-notification-to`; the `.ts` is a mechanical "add `.ts`" rename that hit a string
  literal. Read-receipt headers are never address-parsed, and it's a canary that tooling edited the
  fork without understanding the strings. _[likely]_
- **`messageGet` swallows all errors as `null` → 404** (maildir.ts:158) — a parse failure, disk EIO, or
  DB error on a message the user _can_ see is indistinguishable from "not found," with no log. Combined
  with `readAndParse`'s inner `catch → null`, genuine faults are invisible. Let unexpected errors
  propagate (Elysia → 500); keep `null` only for the real cache-miss. _[likely]_

## P3 findings

- **`sender.ts:31` `Buffer.from(String(a.content))`** on a non-Buffer attachment silently produces
  `"[object Object]"` bytes. Assert/skip non-Buffer content like mail.ts:121 does.
- **`mail-parse.ts:14` collapses whitespace inside `<pre>`/`<textarea>`** (runs `replace(/\s+/g,' ')`
  after DOMPurify) — preformatted content in HTML mail loses formatting. Cosmetic but sender-visible.
- **`searchMail`'s from/to filter is `lower(col) LIKE '%needle%'`** (maildb.ts:164) — a full scan with a
  leading wildcard. Fine at personal-mailbox scale; note it if mailboxes grow large.
- **`size()` returns `dirSize() || db.size()`** (maildir.ts:107) — an empty maildir (0 bytes) falls
  through to the DB sum; the `||` masks the real answer.

## Duplication

- Parser type definitions (`AddressObject`, `Attachment`, `ParsedMail`, …) are defined **twice** — in
  `mail-parser.ts:50` and in `packages/lib/src/types/mail.ts` — reconciled by `as Email` casts
  (mail-parse.ts:43). This is the seam between the fork and the shared types; the fork's
  `content: unknown` vs the lib shapes makes unifying non-trivial. Noted, not urgent.
- **Recipient-summary extraction written twice:** `draftFastSave` (maildir.ts:344) and `parseEml`
  (mail-parse.ts:17) both build `{toShort, toAddress, recipientsAll}` with identical flatten/join — and
  already differ subtly. A shared `buildRecipientSummary(to, cc)` removes the drift.
- `FlowedDecoder` instantiated in three places (two are in the dead modules above).

## Backend abstraction analysis

You asked specifically about future-proofing mail for other backends — connecting Stalwart or an
external IMAP server as a source. There's an existing proposal
([PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md)) whose decision section says "don't build the
full adapter until someone asks for JMAP; land the interface refactor and an rspamd sidecar instead."
I agree with that call. Here's the concrete seam analysis to make the interface refactor real.

### The seam is already clean

Only **four** places outside `lib/mail/` touch mail, all through `home.mail`:

- `routes/mail.ts` — every handler calls `(await getMailClient(user)).<method>()` or a `mail.ts`
  facade fn. **Zero** filesystem / filename / SQL knowledge in routes (verified).
- `routes/search.ts:38` — `home.mail.search(...)`.
- `lib/config/enforcement.ts:60` — `home.mail?.size()`.
- `lib/home/user-home.ts:24` — `new Maildir(this)` (the one construction site).

Everything Maildir-specific lives inside `Maildir` + its collaborators. That is a good starting
position — the abstraction work is "name the contract `Maildir` already implicitly satisfies," not
"untangle mail from the app."

### Where local-Maildir is assumed (the concrete callsites)

| Capability | Callsite |
|---|---|
| list folders | `mailboxesList` → `store.mailboxDirExists`, `db.getEmailsCount*` (maildir.ts:119) |
| list messages | `mailboxGet` → `syncMailbox` + `db.getAllEmails` (maildir.ts:147) |
| fetch body | `messageGetFile`/`readAndParse` → `store.getMessageFile` + `parseEml` (maildir.ts:196,762) |
| store flags | `renameFlag` → `store.renameInCur` + filename rebuild (maildir.ts:262) |
| move / delete | `store.moveMessage`/`deleteMessage` (cur/ rename) (maildir.ts:221) |
| append / deliver | `mailboxDeliver` → `store.deliverAtomic`; drafts → `deliverToCur` (maildir.ts:141) |
| search | `db.searchMail` (FTS5 in mail.db) (maildir.ts:110) |
| watch / notify | `store.watchMailboxes` (`fs.watch`) → `syncMailbox` → SSE (maildir-store.ts:272) |

### The minimal `MailStore` interface (flat-and-direct)

The proposal's sketch is essentially right but conflates two layers. The cleaner cut — matching this
codebase's own storage-vs-domain split (Drive's `Mount` vs `Drive`) — abstracts **only genuine storage
ops** and keeps draft-sidecar, ref-card baking, iMIP, SSE, notifications, and quota in a domain layer
above it:

```ts
// The swappable surface — everything a Stalwart/IMAP backend must provide.
export interface MailStore {
    init(): Promise<void>;
    destruct(): Promise<void>;
    size(): Promise<number>;                                  // async: JMAP needs Quota/get

    mailboxesList(): Promise<MaildirMailbox[]>;
    mailboxCreate(name: string): Promise<void>;
    mailboxExists(name: string): Promise<MaildirMailbox | false>;

    listMessages(mailbox: string): Promise<EmailSummary[]>;   // replaces mailboxGet + sync
    getMessage(id: string): Promise<Email | null>;            // parsed body
    getRawMessage(id: string): Promise<ArrayBuffer>;          // .eml download
    getAttachments(id: string): Promise<Attachment[]>;

    append(mailbox: string, raw: Buffer, flags?: MailFlags): Promise<string>;  // deliver/copy/import
    move(id: string, target: string): Promise<void>;
    delete(id: string): Promise<void>;
    setFlags(id: string, flags: Partial<MailFlags>): Promise<void>;

    search(opts: MailSearchOpts): EmailSummary[] | Promise<EmailSummary[]>;   // sync local, async JMAP

    onChange(cb: (mailbox: string) => void): void;            // fs.watch | JMAP push | IMAP IDLE
}
```

Draft handling, `messageSend`, attachment staging, and iMIP stay **above** this interface — they're
identical regardless of backend (a JMAP backend overrides `append`/`setFlags`, it doesn't re-implement
ref-card baking). Note two shape changes the current `Maildir` would need: `search` must allow a
`Promise` return (local FTS is sync, `Email/query` is async), and `size()` becomes async.

### Fit assessment: Stalwart/JMAP vs external IMAP as a source

- **Maps cleanly to both:** folders, list, fetch body, flags, move, delete, append. JMAP
  `Email/set`/`query`/`import` and IMAP `SELECT`/`FETCH`/`STORE`/`MOVE`/`APPEND` both cover these 1:1.
- **Search is the real divergence.** Today FTS lives _inside_ `mail.db` as trigger-synced external-
  content FTS5. With **Stalwart**, delegate to `Email/query text:` (server-side FTS, strictly better).
  With **external IMAP as a source**, `SEARCH TEXT` is server-dependent and slow — you'd **keep the
  local index** and populate it on sync. So the interface must permit _either_ "delegate search" _or_
  "local index fed by sync." The current trigger-on-`mail.db`-write design already supports the local
  path for free — the proposal underweights this, treating FTS as a pure Stalwart win.
- **Push/notify.** `fs.watch` today; Stalwart → JMAP EventSource/WebSocket (the proposal's inbound
  section is right); external IMAP → `IDLE` per mailbox (heavier: one long-lived socket per watched
  folder, reconnect logic — the proposal doesn't cover IMAP-as-source at all). `onChange(mailbox)`
  absorbs all three shapes.
- **Where the proposal is right:** the seam is at facade level (verified), SSE must be re-emitted by
  the new backend through `home.broadcast`, and iMIP coupling to delivery must move — and note that
  both P1s above live in exactly that `mailboxDeliver` coupling the proposal already flags for
  relocation.
- **Where it has gaps:** (a) it drops the local FTS entirely in Stalwart mode but never addresses that
  `routes/search.ts` **unifies mail + drive results by rank** — a JMAP-delegated search returns
  Stalwart bm25 scores that can't be merged with drive's local bm25 (PROPOSAL_SEARCH.md already flags
  cross-index score incomparability); this needs a resolution. (b) It doesn't treat "external IMAP as a
  source" as a first-class case despite that being a real want — that case _keeps_ the local index and
  cannot drop `maildb.ts`. (c) The `size()`/quota seam assumes a cheap local `dirSize`; JMAP needs
  `Quota/get`.

### Migration path (no big-bang; each step pays off even if no second backend ships)

1. **Extract the interface, no behavior change** (½ day): lift `MailStore` from `Maildir`'s public
   surface; type `home.mail` and `user-home.ts:24` as the interface. Immediately useful as
   documentation of the seam.
2. **Split domain vs store** (1-2 days): move draft/send/iMIP/SSE/notification/quota logic into a thin
   `Mail` domain class that _holds_ a `MailStore`; `MaildirStore` + `MailDB` become the first impl. This
   is the refactor that pays off regardless — it isolates the ~400 LOC of draft-sidecar complexity from
   the storage primitives and makes the P1-2 charset fix a **one-line change at a single boundary**.
3. **Widen `search` to allow async** and make `routes/search.ts` tolerate a per-source score space
   (needed for _any_ remote backend).
4. **Fix the two P1s first** — they live in the exact `mailboxDeliver` seam step 2 refactors, so doing
   them together avoids reworking them.
5. **Only then** build a second `MailStore` (JMAP or IMAP-source) behind a server-settings toggle.

Steps 1-3 shrink the 837-LOC `Maildir` god-class, isolate the persisted-format-sensitive write path,
and make the delivery seam testable — worth doing on their own merits.

## The vendored MIME fork

`mail-parser/` (1424 LOC) + `mail-split/` is a permanent maintenance liability. It was added in a bulk
`style: format` commit with **no documented rationale** — it exists to get Bun-native streaming +
`Bun.CryptoHasher` and to drop the `mailparser`/`mailsplit` npm deps, which is a defensible reason, but
it carries: dead modules (P2), a mechanical-rename typo (P2), duplicated types, and — most concerning —
it parses **untrusted internet input** with an entirely happy-path test net (14 cases, no
malformed-boundary, truncated-header, encoding-bomb, or deeply-nested-multipart fuzzing). The
`MAX_HEAD_SIZE`/`MAX_CHILD_NODES` guards (message-splitter.ts:4) are good but untested. If you keep the
fork (and the streaming/hashing reasons are legitimate), it deserves: a one-line "why we forked"
comment at the top, deletion of the dead half, and a corpus-style fuzz/regression suite. A crash in
this parser on a hostile inbound message is a DoS, not just a dropped mail.

## Strengths

- **Atomic write discipline is correct** — `deliverAtomic` (tmp→new) and `deliverToCur` (tmp→cur)
  write-then-rename; flag renames are ENOENT-safe for Dovecot coexistence.
- **The FTS index cannot drift from the table** — all writes go through `mail.db` and the
  INSERT/UPDATE/DELETE triggers fire unconditionally (db-config.ts:73); the v3 backfill is
  version-gated idempotent; drafts route through the same triggers. This is genuinely closed.
- **Two-pass search is textbook** — id-only FTS rank, then Drizzle hydrate for correct Date typing.
- **Authz is uniform** — every route does `requireNonGuest` + `requireSelf(ownerId, user.id)`; mail is
  personal-only and the invariant holds across all 15 handlers.
- **Careful input sanitization where it counts** — `contentDisposition` RFC5987-encodes attachment
  filenames (no header injection), `sanitizeFtsQuery` neutralizes FTS operators, mailbox names are
  traversal-validated, outbound headers go through nodemailer (RFC 2047), not hand-rolled.
- **Teardown races handled** — `syncMailbox` bails on `home.destructing`, `destruct` awaits in-flight
  syncs before closing the DB (a real query-on-closed-db class, commented).

## Debt themes

1. **The 5.3k-LOC vendored fork** parses hostile input, has no fuzz tests, and carries dead code + a
   rename typo. Biggest single liability in the domain.
2. **Error-masking as a habit** — `messageGet`/`readAndParse`/`parseEml`/draft cleanups swallow to
   `null`/void; consistent with "don't crash on one bad message" but crosses into "genuine faults are
   invisible."
3. **`Maildir` is an 837-LOC god-object** mixing storage orchestration, the draft state machine, the
   send pipeline, and the sync engine — the backend-abstraction refactor (§ step 2) is the natural
   remedy.

---

_Postscript 2026-07-03: migration steps 1-2 executed on `refactor/mail-store-split` (merged 33149558) — `Maildir` split into `Mail` domain class (`mail-domain.ts`) + `MailStore` interface + `MaildirStore` impl. Deviations: per-message `MailStoreEvents` (received/flagsChanged/deleted) instead of the sketched `onChange(mailbox)`; draft-sidecar + temp-staging ops added to the contract; `append(..., {skipSync})` preserves welcome-mail timing. Step 3 (async search/size) not taken, per the doc._
