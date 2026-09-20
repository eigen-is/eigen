# Maildir Storage & Dovecot Compatibility

> **TLDR**: Email is stored in standard Maildir++ with Dovecot-compatible filenames, flags, and directory
> layout. The filesystem is the source of truth; `mail.db` is a rebuild-safe read cache. A scan-based sync
> engine reconciles disk against DB in chunks, off the request path. There is no in-repo IMAP server —
> Dovecot runs as its own container over the same files. App-level mail is in **[MAIL.md](MAIL.md)**.

## Design Principles

1. **Maildir on disk is the source of truth.** `mail.db` accelerates queries and stores parsed metadata, and is always
   rebuilt by scanning the files: the `.eml`s, plus the `draft-meta/` sidecar a fast save writes subject, preview and
   recipients to, which the Drafts sync projects back over the row it rebuilds from the stale `.eml`
   ([MAIL.md § Files and index](MAIL.md#files-and-index)).
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
| `mail-parse.ts` | Parses the `.eml` via `parseMail` (accepts `BunFile`), sanitizes the HTML with DOMPurify, and derives the `EmailSummary` |
| `mailfile.ts` | Generates RFC 5322 `.eml` content from draft input |
| `mailutils.ts` | Filename generation, flag parsing, flag rebuild helpers |
| `schema.ts`, `db-config.ts` | Drizzle schema + versioned migrations for `mail.db` |

`STANDARD_MAILBOXES` comes from `packages/lib/src/constants/mailboxes.ts` ([MAIL.md](MAIL.md)), `PATHS.MAIL` from `lib/core/constants.ts`. The app half on top of the store
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
Empty string represents INBOX (the Maildir root). Beside them stands whatever else the Maildir holds — Dovecot
creates a folder for any IMAP client that asks, and Eigen lists it.

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
    .Projects/              # a folder an IMAP client made
    .Clients.Acme/          # nesting is the `.` delimiter, not a nested directory
```

`mailboxDir()` maps names: empty/`INBOX` -> `Maildir/`, others -> `Maildir/.{name}`, joining a `/`-delimited name
with `.` so `Clients/Acme` and `Clients.Acme` are one directory. Mailbox names are validated against path traversal
and special characters (`isValidMailboxPath`, [MAIL.md § Mailboxes](MAIL.md#mailboxes-and-the-naming-gotcha)).
`canonicalMailbox()` (`packages/lib/src/constants/mailboxes.ts`) case-folds the six standard names — `INBOX` in
any case onto the empty inbox name — and passes any other name through untouched, so a folder's own spelling is
the one Eigen addresses it by.

`mailboxesList()` enumerates the Maildir: the standard six first, then every other `.Folder` by path, each with
its `total`/`unread` read straight from the index. A directory whose name fails validation is skipped silently —
Dovecot accepts names this store cannot address, and one of them must not break the listing. So is a directory
whose name canonicalizes onto a standard mailbox (`.archive`, `.INBOX`): it is that mailbox under another
spelling, not a folder of its own. A folder Eigen has never indexed is indexed in the background, once per
process, and the sync's own SSE events land its counts — a listing itself never waits on a sync.

Mailbox membership is the only organization Eigen has — there are no labels.

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
     A sync of a mailbox with no rows yet is a **cold index**: the files were already on disk, so the events
     carry `isNew: false` and an old IMAP folder announces no new mail. The sync that follows Eigen's own
     delivery says otherwise (`append`), so a real arrival still notifies.
   - **Flag changes** (on disk with different filename than DB): update DB flags + filename, report `flagsChanged`
     (`MAIL_FLAGS_CHANGED`).
   - **Deleted messages** (in DB, not on disk): delete from DB, report `deleted` (`MAIL_DELETED`).
4. **Deduplication guard** -- `syncingMailboxes` Map prevents redundant concurrent syncs on the same mailbox. If a sync
   is already running, callers await the existing promise.

Sync triggers: filesystem watcher events, Eigen's own writes (deliver, copy), and reads of a mailbox. **A read
does not wait for the sync**: `listMessages` awaits `syncMailbox()` only when the mailbox has no rows yet (first
open, so the user sees content immediately); otherwise it returns the DB rows straight away and fires the sync in
the background with `.catch()`. `mailboxesList` never waits at all — it kicks the first index of a folder it has
not kicked before and reports the index's counts. Anything the background sync finds reaches the client over SSE. See
[MAIL.md § Performance design](MAIL.md#performance-design).

## File Watching

`MaildirStore.watch()` sets up `fs.watch()` on `cur/` and `new/` for every mailbox the enumeration finds — the
same list `mailboxesList()` reports, so a watcher exists for each folder on disk and not only for the standard
six. Changes trigger `syncMailbox()` which detects new messages, flag renames, and deletions, then reports them
through `MailStoreEvents` so the frontend updates without page refresh. The Maildir root is watched too: an IMAP
client can create a folder at any time, and each new `.Folder` picks up its own pair of watchers as it appears.
`unwatch()` closes all watchers and awaits in-flight syncs on `Mail.destruct()`.

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

- An IMAP-created folder is listed, watched and openable in Eigen, under the name Dovecot gave it. A message moved
  into one leaves its old mailbox and appears in that folder's list.
- A folder whose name Eigen's validator refuses (an empty hierarchy segment, a character outside `A-Za-z0-9_- `)
  stays reachable over IMAP and is left out of Eigen's listing.
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
`special_use` blocks make clients label the six standard mailboxes the way Eigen does. The rest of the file is TLS
(`ssl = required`, plaintext auth off), the `checkpassword` passdb, running IMAP workers as `vmail` (uid 1000,
matching the API container), and the SASL listener Postfix uses for submission.

## Dovecot Deployment

Dovecot runs as a Docker container alongside Eigen. Authentication uses Dovecot's `checkpassword` mechanism:
Dovecot calls `eigen-checkpassword` (a bash script) which `POST`s to Eigen's `/internal/auth/verify` endpoint.
The endpoint verifies the password via `verifyProtocolAuth()` — tries app passwords (better-auth API keys) first,
falls back to primary password (rejected if 2FA is enabled). The container set and compose files live in
`docker/`; [CONTRIBUTING.md § Docker](CONTRIBUTING.md#option-2-docker-full-stack) covers running the full stack
locally.

The exit code carries the difference between "wrong password" and "server trouble", so the script reads the
HTTP status rather than relying on `curl -f` (which exits the same way for a 401 as for a 500). A 401, 403 or
429 is exit 1, dovecot's "auth failed", which reaches the client as `535` and makes it ask for a password. A
connection failure or any other status is exit 111, dovecot's "temporary failure", which Postfix answers with
`454 4.7.0` and clients treat as an outage worth retrying. A 200 with no `userId` in it goes to 111 too — an
answer we cannot read is a broken API, not a wrong password, and never an open door. Mapping a refused password
to 111 also loses failures: dovecot re-runs or abandons the helper, so some attempts never reach the limiter at
all.

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
- **Labels.** Mail has no labels at all; a message belongs to exactly one mailbox.
