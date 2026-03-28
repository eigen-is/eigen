# Maildir Storage & Dovecot Compatibility

**TLDR:** Eigen stores email in standard Maildir++ format with Dovecot-compatible filenames, flags, and directory
layout. The filesystem is the source of truth; `mail.db` is a rebuild-safe read cache. A scan-based sync engine
reconciles disk state with the DB, enabling seamless coexistence with Dovecot IMAP.

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

| File | Responsibility |
|------|----------------|
| `maildir.ts` | Orchestrator -- public API, ties together store + DB + parsing + SSE |
| `maildir-store.ts` | Filesystem ops on Maildir structure (deliver, move, list, rename, watch). Returns `BunFile` via `getMessageFile()` for lazy reads |
| `maildb.ts` | CRUD for email metadata in `mail.db` |
| `mail-parse.ts` | Parses `.eml` content into `Email` (accepts `BunFile`), sanitizes HTML via DOMPurify |
| `mailfile.ts` | Generates RFC 5322 `.eml` content from draft input |
| `mailutils.ts` | Filename generation, flag parsing, flag rebuild helpers |
| `sender.ts` | `draftToOutboundMail()` -- converts `EmailDraft` to `OutboundMail` for `sendMail()` |
| `welcome.ts` | Generates the welcome email delivered on first mailbox init |
| `mail.ts` | Thin facade resolving `User` -> `Maildir` instance (called by routes) |
| `sse-events.ts` | `buildMailEvent()` -- SSE event builder for mail mutations |
| `schema.ts` | Drizzle ORM schema for `emails`, `emailLabels`, `emailsToLabels` |
| `constants.ts` | `STANDARD_MAILBOXES`, `PATHS.MAIL` |

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
against path traversal and special characters. `canonicalMailbox()` in `maildir.ts` normalizes case-insensitive
input to canonical form.

Labels (`emailLabels` table) provide per-message tagging as an alternative to folder-based organization.

## Delivery Flow

**Incoming mail** (`deliverAtomic`): writes to `tmp/` then renames to `new/` for atomicity. Used by the
`/mail/deliver/:to` endpoint (called by Postfix or compatible MTA) and by `messageCopy()`. A subsequent
`syncMailbox()` call parses the message and adds it to the DB.

**Drafts and sent copies** (`deliverToCur`): writes to `tmp/` then renames directly to `cur/` with flags already set.
Drafts get `D`+`S` flags. Skips `new/` because Eigen knows the final flags at creation time.

**Send flow**: `messageSend()` saves via `messageHandleDraft()` into Drafts, sends via `sendMail()` (using
`draftToOutboundMail()` from `sender.ts`), then moves to Sent and clears the draft flag.

## Sync Engine

`syncMailbox()` in `maildir.ts` runs four phases:

1. **Move `new/` -> `cur/`** -- standalone mode fallback. Appends `:2,` (empty flags). ENOENT-safe if Dovecot already
   moved the file.
2. **Build disk state** -- lists all files in `cur/`, builds a `Map<messageId, filename>`.
3. **Reconcile with DB** --
   - **New messages** (on disk, not in DB): read file via `getMessageFile()` (returns `BunFile`), parse EML, apply
     flags from filename, insert into DB, emit `MAIL_RECEIVED`, persist notification via `home.notifications`.
   - **Flag changes** (on disk with different filename than DB): update DB flags + filename, emit
     `MAIL_FLAGS_CHANGED`.
   - **Deleted messages** (in DB, not on disk): delete from DB, emit `MAIL_DELETED`.
4. **Deduplication guard** -- `syncingMailboxes` Map prevents redundant concurrent syncs on the same mailbox. If a sync
   is already running, callers await the existing promise.

Sync triggers: API request for mailbox contents (before returning data), filesystem watcher events, and after Eigen
writes (deliver, copy).

## File Watching

`MaildirStore.watchMailboxes()` sets up `fs.watch()` on `cur/` and `new/` for each standard mailbox. Changes trigger
`syncMailbox()` which detects new messages, flag renames, and deletions, then emits SSE events to update the frontend
without page refresh. `unwatchMailboxes()` closes all watchers on `destruct()`.

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

```
mail_location = maildir:~/Maildir

namespace inbox {
    inbox = yes
    separator = .

    mailbox Sent {
        auto = subscribe
        special_use = \Sent
    }
    mailbox Drafts {
        auto = subscribe
        special_use = \Drafts
    }
    mailbox Trash {
        auto = subscribe
        special_use = \Trash
    }
    mailbox Junk {
        auto = subscribe
        special_use = \Junk
    }
    mailbox Archive {
        auto = subscribe
        special_use = \Archive
    }
}

maildir_very_dirty_syncs = no
```

`~/Maildir` maps to `data/home/{userId}/eigen.mail/Maildir` in Eigen's data layout.

## Not Yet Implemented

- **Dovecot IMAP server deployment.** The filesystem format is Dovecot-compatible, but no actual Dovecot deployment
  configuration, UID/UIDVALIDITY tracking, or IMAP authentication wiring exists. Running an IMAP server alongside
  Eigen has not been set up.
- **Stale `tmp/` cleanup.** Per Maildir spec, files in `tmp/` older than 36 hours can be safely deleted. No
  housekeeping code exists.

## File Reference

| File | Path |
|------|------|
| Orchestrator | `apps/api/src/lib/mail/maildir.ts` |
| Filesystem store | `apps/api/src/lib/mail/maildir-store.ts` |
| DB operations | `apps/api/src/lib/mail/maildb.ts` |
| EML parser | `apps/api/src/lib/mail/mail-parse.ts` |
| EML generator | `apps/api/src/lib/mail/mailfile.ts` |
| Filename helpers | `apps/api/src/lib/mail/mailutils.ts` |
| Send helper | `apps/api/src/lib/mail/sender.ts` |
| Welcome email | `apps/api/src/lib/mail/welcome.ts` |
| Route facade | `apps/api/src/lib/mail/mail.ts` |
| SSE events | `apps/api/src/lib/mail/sse-events.ts` |
| Routes | `apps/api/src/routes/mail.ts` |
| DB schema | `apps/api/src/lib/mail/schema.ts` |
| DB config | `apps/api/src/lib/mail/db-config.ts` |
| Constants | `apps/api/src/lib/core/constants.ts` |
| Shared types | `packages/lib/src/types/mail.ts` |
