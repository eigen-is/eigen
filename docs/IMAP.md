# Maildir Storage & Dovecot Compatibility

> **TLDR**: Email is stored in standard Maildir++ with Dovecot-compatible filenames, flags, and directory
> layout. The filesystem is the source of truth; `mail.db` is a rebuild-safe read cache. A scan-based sync
> engine reconciles disk against DB in chunks, off the request path. There is no in-repo IMAP server —
> Dovecot runs as its own container over the same files. App-level mail is in **[MAIL.md](MAIL.md)**.

## Design Principles

1. **Maildir on disk is the source of truth.** `mail.db` accelerates queries and stores parsed metadata. It can always
   be rebuilt by scanning the Maildir.
2. **Dovecot owns `new/` -> `cur/` transitions.** When Dovecot is running, it moves files from `new/` to `cur/`,
   manages flag renames, and handles expunges. Eigen delivers to `new/` (always safe) and reads from `cur/`.
3. **Eigen writes directly to `cur/` for local operations.** Flag changes, moves, and deletes rename files in `cur/`
   directly. This can cause a Dovecot UID reassignment if Dovecot scans simultaneously -- acceptable for a self-hosted
   single-user system and self-correcting on Dovecot's next scan.
4. **Standalone mode.** When Dovecot is not running, Eigen handles `new/` -> `cur/` moves itself. The sync engine
   handles both modes transparently using ENOENT-safe renames.
5. **Fixed mailbox set.** Eigen exposes only 6 standard mailboxes. Extra folders created via IMAP are ignored by Eigen
   but remain fully accessible through any IMAP client.

## Code Architecture

Everything lives in `apps/api/src/lib/mail/`. The storage half:

| File | Responsibility |
|------|----------------|
| `mail-store.ts` | `MailStore` interface -- the swappable storage contract, plus the `MailStoreEvents` change stream |
| `maildir-store.ts` | `MaildirStore implements MailStore` -- Maildir filesystem ops (deliver, move, list, rename, watch), the sync engine, and the `mail.db` index. Returns `BunFile` via `getMessageFile()` for lazy reads |
| `maildb.ts` | CRUD + batch upsert for email metadata in `mail.db` |
| `mail-parse.ts` | Parses `.eml` content into `Email` (accepts `BunFile`), sanitizes HTML via DOMPurify |
| `mailfile.ts` | Generates RFC 5322 `.eml` content from draft input |
| `mailutils.ts` | Filename generation, flag parsing, flag rebuild helpers |
| `schema.ts`, `db-config.ts` | Drizzle schema + versioned migrations for `mail.db` |

`STANDARD_MAILBOXES` and `PATHS.MAIL` come from `lib/core/constants.ts`. The app half on top of the store
(`mail-domain.ts`, `mail.ts`, `sender.ts`, `welcome.ts`, `sse-events.ts`) is mapped in
[MAIL.md § Architecture](MAIL.md#architecture).

## Filename Format

Files follow Maildir++ conventions. The unique ID uses the `{time}.M{usec}P{pid}Q{seq}.{hostname}` pattern
(`createUniqueMessageId()`). A `,S={size}` hint is appended before the flag separator but is not part of the logical
message ID.

```
new/:  {unique},S={size}                         # no flags
cur/:  {unique},S={size}:2,{FLAGS}               # colon-2-comma, then sorted flag chars

Example:
1709234567.M412345P9876.host,S=4523:2,RS
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^
unique + size hint                flags (Replied + Seen)
```

`getMailIDfromFileName()` extracts the logical message ID by stripping everything after the first `,` or `:`.

## Flag Storage

Flags are stored **in the filename** after `:2,` -- this is the source of truth. The DB mirrors flags for query
performance.

| Flag char | Meaning | DB column |
|-----------|---------|-----------|
| `S` | Seen | `isRead` |
| `R` | Replied | `isReplied` |
| `F` | Flagged (starred in UI) | `isFlagged` |
| `D` | Draft | `isDraft` |
| `T` | Trashed | -- |
| `P` | Passed/Forwarded | -- |

Flag characters are uppercase and ASCII-sorted. Dovecot appends lowercase `a-z` for custom keywords (mapped via its
`dovecot-keywords` file). `rebuildFlagsSuffix()` preserves unknown lowercase keywords when Eigen modifies standard
flags, avoiding stripping keywords Dovecot set.

Changing a flag renames the file in `cur/` via `renameInCur()`, then updates the DB. `parseFlagsFromFilename()` and
`applyFlagsFromFilename()` handle the read path.

## Mailbox Structure

Six standard mailboxes, canonical case. `STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']`.
Empty string represents INBOX (the Maildir root).

```
eigen.mail/
  Maildir/                  # INBOX
    cur/ new/ tmp/
    subscriptions           # IMAP folder subscriptions
    .Sent/                  # Maildir++ dot-prefix
      cur/ new/ tmp/
      maildirfolder         # required marker file
    .Drafts/
    .Trash/
    .Junk/
    .Archive/
```

`mailboxDir()` maps names: empty/`INBOX` -> `Maildir/`, others -> `Maildir/.{name}`. Mailbox names are validated
against path traversal and special characters. `canonicalMailbox()` in `mail-domain.ts` normalizes case-insensitive
input to canonical form.

Mailbox membership is the only organization Eigen has. The `emailLabels`/`emailsToLabels` tables are
**vestigial** — the v1 `CREATE TABLE` is the only place they appear; no code reads or writes them.

## Delivery Flow

**Incoming mail** (`deliverAtomic`): writes to `tmp/` then renames to `new/` for atomicity. Used by the
`/mail/deliver/:to` endpoint (called by Postfix or compatible MTA) and by `messageCopy()`. A subsequent
`syncMailbox()` call parses the message and adds it to the DB.

**Drafts and sent copies** (`deliverToCur`): writes to `tmp/` then renames directly to `cur/` with flags already set.
Drafts get `D`+`S` flags. Skips `new/` because Eigen knows the final flags at creation time.

**Send flow**: `messageSend()` saves via `messageHandleDraft()` into Drafts, sends via `sendMail()` (using
`draftToOutboundMail()` from `sender.ts`), then moves to Sent and clears the draft flag.

## Sync Engine

`syncMailbox()` in `maildir-store.ts` runs four phases:

1. **Move `new/` -> `cur/`** -- standalone mode fallback. Appends `:2,` (empty flags). ENOENT-safe if Dovecot already
   moved the file.
2. **Build disk state** -- lists all files in `cur/`, builds a `Map<messageId, filename>`.
3. **Reconcile with DB** -- diff the disk map against `getAllEmails(mailbox)`. Each discovery is reported through
   `MailStoreEvents`; the `Mail` domain class turns them into SSE events + notifications:
   - **New messages** (on disk, not in DB): processed in **chunks of 250**. A chunk is parsed first (file via
     `getMessageFile()` → `BunFile`, `parseEml`, flags applied from the filename), then written by a single
     `insertEmails` upsert transaction, then its `received` events fire (`MAIL_RECEIVED` +
     `home.notifications`). One transaction and one SSE burst per chunk, not per message — this is the cold-index
     win. A message that fails to parse is logged and skipped so one bad `.eml` can't drop the rest of the chunk.
   - **Flag changes** (on disk with different filename than DB): update DB flags + filename, report `flagsChanged`
     (`MAIL_FLAGS_CHANGED`).
   - **Deleted messages** (in DB, not on disk): delete from DB, report `deleted` (`MAIL_DELETED`).
4. **Deduplication guard** -- `syncingMailboxes` Map prevents redundant concurrent syncs on the same mailbox. If a sync
   is already running, callers await the existing promise.

Sync triggers: filesystem watcher events, Eigen's own writes (deliver, copy), and reads of a mailbox. **A read
does not wait for the sync**: `listMessages` awaits `syncMailbox()` only when the mailbox has no rows yet (first
open, so the user sees content immediately); otherwise it returns the DB rows straight away and fires the sync in
the background with `.catch()`. Anything the background sync finds reaches the client over SSE. See
[MAIL.md § Performance design](MAIL.md#performance-design).

## File Watching

`MaildirStore.watch()` sets up `fs.watch()` on `cur/` and `new/` for each standard mailbox. Changes trigger
`syncMailbox()` which detects new messages, flag renames, and deletions, then reports them through `MailStoreEvents`
so the frontend updates without page refresh. `unwatch()` closes all watchers and awaits in-flight syncs on
`Mail.destruct()`.

## Dovecot Compatibility

### Control files

| File | Owner | Eigen behavior |
|------|-------|----------------|
| `dovecot-uidlist` | Dovecot | Never modify. Deleting forces all IMAP clients to re-download. |
| `dovecot-keywords` | Dovecot | Never modify. Maps `a-z` to keyword names. |
| `dovecot.index*` | Dovecot | Ignore. Dovecot rebuilds if deleted. |
| `subscriptions` | Shared | Eigen writes on mailbox creation. Dovecot updates on subscribe/unsubscribe. |
| `maildirfolder` | Eigen | Empty marker in each subfolder, required by Maildir++ spec. |
| `mail.db` | Eigen | Dovecot ignores SQLite files. |

### Coexistence behavior

- Extra IMAP-created folders exist on disk but are not indexed or shown in Eigen. Messages moved to custom folders
  appear as "deleted" from Eigen's perspective; moving them back triggers re-detection.
- Simultaneous flag renames by Dovecot and Eigen: one rename fails with ENOENT, next sync corrects.
- Dovecot assigns UIDs on its next scan of `cur/`. Moves (which land directly in target `cur/`) cause UID
  reassignment, matching IMAP MOVE semantics (COPY + EXPUNGE).

## Dovecot Configuration Reference

The config is `docker/dovecot/dovecot.conf`. Three settings carry the whole compatibility contract:

```
mail_location = maildir:~/Maildir      # ~ = data/home/{userId}/eigen.mail/

namespace inbox {
    separator = .                      # Maildir++ dot-prefix: .Sent/, .Drafts/
    mailbox Sent {                     # one block per standard mailbox
        auto = subscribe
        special_use = \Sent
    }
}
```

`separator = .` is what makes Dovecot's folder names line up with the on-disk `.Mailbox` layout, and the
`special_use` blocks make clients see the same six mailboxes Eigen exposes. The rest of the file is TLS
(`ssl = required`, plaintext auth off), the `checkpassword` passdb, running IMAP workers as `vmail` (uid 1000,
matching the API container), and the SASL listener Postfix uses for submission.

## Dovecot Deployment

Dovecot runs as a Docker container alongside Eigen. Authentication uses Dovecot's `checkpassword` mechanism:
Dovecot calls `eigen-checkpassword` (a bash script) which `POST`s to Eigen's `/internal/auth/verify` endpoint.
The endpoint verifies the password via `verifyProtocolAuth()` — tries app passwords (better-auth API keys) first,
falls back to primary password (rejected if 2FA is enabled). The container set and compose files live in
`docker/`; [CONTRIBUTING.md § Docker](CONTRIBUTING.md#option-2-docker-full-stack) covers running the full stack
locally.

The script also sends the client's address as `ip`, taken from `TCPREMOTEIP`, the DJB-interface variable
Dovecot exports to a checkpassword process. Use that name and not Dovecot's `IP`, which carries the **local**
address for compatibility with old `checkpassword-reply` builds. For an IMAP login the client is the mail
client; for an SMTP submission login it is the SMTP client, which Postfix hands to Dovecot as `rip`. The API
keys its per-IP failure limiter on it. The variable is unset for internal sessions such as `doveadm`, and then
the field is left out.

**Files:** `docker/dovecot/dovecot.conf`, `docker/dovecot/eigen-checkpassword`

## Not Yet Implemented

- **Stale `tmp/` cleanup.** Per Maildir spec, files in `tmp/` older than 36 hours can be safely deleted. No
  housekeeping code exists.
- **Labels.** The `emailLabels`/`emailsToLabels` tables exist in the v1 migration and nowhere else.
