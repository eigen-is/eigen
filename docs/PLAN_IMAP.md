# IMAP / Dovecot Maildir Compatibility

This document describes how to make Eigen's mail backend fully compatible with Dovecot so that both Eigen and Dovecot
can read and write from the same Maildir structure. The goal is for Dovecot to handle IMAP access while Eigen's API
keeps `mail.db` in sync by scanning the Maildir for changes.

## Design Principles

1. **Maildir on disk is the source of truth.** `mail.db` is a read-cache that accelerates queries and stores parsed
   metadata. It can always be rebuilt by scanning the Maildir.
2. **Dovecot owns `new/` → `cur/` transitions.** When Dovecot is running, it moves files from `new/` to `cur/`,
   manages flag renames, and handles expunges. Eigen delivers to `new/` (always safe) and reads from `cur/`.
3. **Eigen writes directly to `cur/` for local operations.** Flag changes, moves, and deletes rename files in `cur/`
   directly. This can cause a Dovecot UID reassignment if Dovecot scans at the exact same instant — acceptable for
   a self-hosted single-user system and self-correcting on Dovecot's next scan.
4. **Standalone mode.** When Dovecot is not running, Eigen handles `new/` → `cur/` moves itself. The sync engine
   handles both modes transparently using ENOENT-safe renames.
5. **Fixed mailbox set.** Eigen exposes only 6 standard mailboxes (INBOX, Sent, Drafts, Trash, Junk, Archive).
   Extra folders created via IMAP are ignored by Eigen (not indexed, not shown) but fully accessible via IMAP.

## Code Architecture

After the refactor, the mail backend is split into focused modules:

| File | Class/Function | Responsibility |
|------|---------------|----------------|
| `maildir.ts` | `Maildir` | Orchestrator — public API, ties together store + DB + parsing + SSE |
| `maildir-store.ts` | `MaildirStore` | Pure filesystem ops on Maildir structure (deliver, move, list, delete) |
| `mail-parse.ts` | `parseEml()` | Parses `.eml` content string into `Email` object, sanitizes HTML |
| `maildb.ts` | `MailDB` | Database operations on `mail.db` (CRUD for email metadata) |
| `mailfile.ts` | `createEmlContent()` | Generates RFC 5322 `.eml` content from `EmlInput` |
| `mailutils.ts` | Helpers | Maildir filename generation, parsing, flag helpers |
| `mail.ts` | Facade | Thin layer resolving `User` → `Maildir` instance, called by routes |

Constants (`STANDARD_MAILBOXES`, `PATHS.MAIL`) live in `apps/api/src/lib/core/constants.ts`.

---

## 1. Filename Format

### Current

```
{timestamp}.{uuid}.eml          # e.g. 1710614400.a1b2c3d4-e5f6-4d4a-b5c6-d7e8f9a0b1c2.eml
```

All files use `.eml` extension. No flags in filename. Same format in both `new/` and `cur/`.

### Standard (Maildir / Maildir++ / Dovecot)

```
new/:  {unique}                  # no colon, no flags, no extension
cur/:  {unique}:2,{FLAGS}        # colon-2-comma separator, then flag characters
```

The unique part follows the pattern `{time}.{delivery-id}.{hostname}`:

```
1709234567.M412345P9876.mail.example.com
```

The `,S={size}` hint is appended to the unique part (before `:2,`) but is **not** part of the logical message ID.
The full filename in `cur/` looks like:

```
1709234567.M412345P9876.host,S=4523:2,RS
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^
unique + size hint                 flags (Replied + Seen)
```

Flag characters are uppercase, ASCII-sorted: `D`(Draft), `F`(Flagged), `P`(Passed/Forwarded), `R`(Replied),
`S`(Seen), `T`(Trashed). Dovecot appends lowercase `a-z` for custom keywords (mapped via `dovecot-keywords`).

### Fix

**File: `mailutils.ts`** — `createUniqueMessageId()`

Replace UUID-based IDs with a Maildir-compatible unique name:

```typescript
import {hostname} from 'os'

let deliveryCounter = 0

function createUniqueMessageId(): string {
    const time = Math.floor(Date.now() / 1000)
    const usec = (Date.now() % 1000) * 1000
    const pid = process.pid
    const seq = deliveryCounter++
    const host = hostname().replace(/\//g, '\\057').replace(/:/g, '\\072')
    return `${time}.M${usec}P${pid}Q${seq}.${host}`
}
```

**File: `mailutils.ts`** — `getMailIDfromFileName()`

Extract the logical message ID: the unique part before any `,S=` size hint or `:2,` flags:

```typescript
function getMailIDfromFileName(fileName: string): string {
    const colonIndex = fileName.indexOf(':')
    const withoutFlags = colonIndex >= 0 ? fileName.substring(0, colonIndex) : fileName
    const commaIndex = withoutFlags.indexOf(',')
    return commaIndex >= 0 ? withoutFlags.substring(0, commaIndex) : withoutFlags
}
```

**File: `mailutils.ts`** — Add helpers to build and parse Maildir filenames:

```typescript
const FLAG_MAP = { seen: 'S', replied: 'R', flagged: 'F', draft: 'D', trashed: 'T', forwarded: 'P' } as const

function buildMaildirFilename(uniqueId: string, flags: Record<string, boolean>, size?: number): string {
    const sizeHint = size != null ? `,S=${size}` : ''
    const flagStr = Object.entries(FLAG_MAP)
        .filter(([key]) => flags[key as keyof typeof flags])
        .map(([, char]) => char)
        .sort()
        .join('')
    return `${uniqueId}${sizeHint}:2,${flagStr}`
}

function parseFlagsFromFilename(fileName: string): {
    seen: boolean, replied: boolean, flagged: boolean,
    draft: boolean, trashed: boolean, forwarded: boolean
} {
    const match = fileName.match(/:2,([A-Za-z]*)/)
    const flagStr = match?.[1] || ''
    return {
        seen: flagStr.includes('S'),
        replied: flagStr.includes('R'),
        flagged: flagStr.includes('F'),
        draft: flagStr.includes('D'),
        trashed: flagStr.includes('T'),
        forwarded: flagStr.includes('P'),
    }
}
```

The regex uses `[A-Za-z]*` to capture both standard flags (uppercase) and Dovecot custom keywords (lowercase).
Eigen only interprets the uppercase flags but preserves the full flag string when rebuilding filenames to avoid
stripping keywords Dovecot set.

To preserve unknown flags during rename:

```typescript
function rebuildFlagsSuffix(currentFilename: string, changes: Partial<Record<string, boolean>>): string {
    const match = currentFilename.match(/:2,([A-Za-z]*)/)
    const existing = match?.[1] || ''
    const keywords = existing.replace(/[A-Z]/g, '')
    const current = parseFlagsFromFilename(currentFilename)
    const merged = { ...current, ...changes }
    const standardFlags = Object.entries(FLAG_MAP)
        .filter(([key]) => merged[key as keyof typeof merged])
        .map(([, char]) => char)
        .sort()
        .join('')
    return standardFlags + keywords
}
```

---

## 2. Flag Storage

### Current

Flags (`isRead`, `isStarred`, `isDraft`) live only in `mail.db`. The on-disk filename carries no flag information.
`mail-parse.ts` hardcodes defaults: `isDraft: mailbox === 'drafts'`, `isRead: mailbox === 'drafts'`,
`isStarred: false`. When Dovecot changes flags via IMAP, Eigen never sees it.

### Standard

Flags are stored **in the filename** after `:2,`. This is the source of truth. Dovecot renames the file when flags
change. Any tool that reads the Maildir can see current flags by parsing filenames.

### Fix

#### DB schema changes (`schema.ts`)

Add `isReplied` and rename `isStarred` → `isFlagged` to match IMAP semantics. Add a `filename` column so we can
detect renames (flag changes) during sync:

```
emails table:
  + filename   TEXT NOT NULL        -- current Maildir filename (for rename detection)
  + isReplied  BOOLEAN DEFAULT 0    -- \Answered flag
  ~ isStarred  → isFlagged          -- \Flagged (IMAP \Flagged = starred in UI)
  - _isParsed                       -- remove, unused after sync-based approach
```

The frontend can keep calling it "starred" in the UI — it maps to `\Flagged` in IMAP, which is what every mail
client uses for stars/importance.

#### Remove hardcoded flag defaults from `parseEml()`

**Critical fix.** `mail-parse.ts` currently sets `isDraft`, `isRead`, and `isStarred` based on mailbox name.
**Remove all flag defaults from `parseEml()`** — flags must come exclusively from the filename via
`applyFlagsFromFilename()`. The parser should only return content-derived fields (subject, from, text, html,
attachments, date, size).

New helper in `mailutils.ts`:

```typescript
function applyFlagsFromFilename(email: EmailSummary, filename: string): void {
    const flags = parseFlagsFromFilename(filename)
    email.isRead = flags.seen
    email.isFlagged = flags.flagged
    email.isDraft = flags.draft
    email.isReplied = flags.replied
}
```

#### Writing flags to disk

When Eigen changes a flag (e.g. `messageSetRead`), `MaildirStore` renames the file. Use `rebuildFlagsSuffix()` to
preserve any Dovecot keyword flags:

```typescript
// In Maildir (orchestrator)
async messageSetRead(messageId: string, read: boolean): Promise<void> {
    const email = this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    const newFlagStr = rebuildFlagsSuffix(email.filename, { seen: read })
    const uniqueWithSize = email.filename.split(':')[0]
    const newFilename = `${uniqueWithSize}:2,${newFlagStr}`

    await this.store.renameInCur(email.mailbox, email.filename, newFilename)
    this.db.setRead(messageId, read)
    this.db.setFilename(messageId, newFilename)
    // ... emit SSE
}
```

#### Add `messageSetFlagged()` for starred/flagged toggle

Currently there is **no route** for toggling the starred/flagged state. Add:
- `Maildir.messageSetFlagged(messageId, flagged)` — same pattern as `messageSetRead()`, toggles `F` flag
- `MailDB.setFlagged(id, isFlagged)`
- Route: `PUT /mail/:ownerId/message/:id/flagged` with body `{ flagged: boolean }`
- Hook: `useToggleFlaggedEmail()` in `use-emails.ts`

---

## 3. Mailbox Directory Names

### Current

`STANDARD_MAILBOXES` uses capitalized names: `['', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive']`.
But `mailboxDir()` lowercases everything, so `.Sent/` becomes `.sent/`. And `maildb.ts` lowercases the `mailbox`
column on every insert and query. Result: Dovecot expects `.Sent/` but Eigen creates `.sent/`.

### Standard (Maildir++)

Dovecot uses **capitalized** names by convention and the Junk folder is `.Junk/` (matching `\Junk` special-use
from RFC 6154):

```
Maildir/                    # INBOX (root, no dot-prefix)
Maildir/.Sent/
Maildir/.Drafts/
Maildir/.Trash/
Maildir/.Junk/              # not .Spam
Maildir/.Archive/
```

Each subfolder contains `cur/`, `new/`, `tmp/`, and an empty `maildirfolder` marker file.

### Fix

**File: `core/constants.ts`** — Update `STANDARD_MAILBOXES`:

```typescript
export const STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'] as const
```

**File: `maildir-store.ts`** — `mailboxDir()` — stop lowercasing:

```typescript
mailboxDir(mailbox: string): string {
    if (mailbox === '' || mailbox === 'INBOX') return this.basePath
    return `${this.basePath}/.${mailbox.replace('/', '.')}`
}
```

**File: `maildir-store.ts`** — `createStandardMailboxes()` — add `maildirfolder` markers and `subscriptions`:

```typescript
if (mailbox !== '') {
    await this.storage.file(this.storage.pathJoin(mailboxPath, 'maildirfolder')).write('')
}
// After loop:
const subscriptions = STANDARD_MAILBOXES.filter(m => m !== '').join('\n') + '\n'
await this.storage.file(this.storage.pathJoin(this.basePath, 'subscriptions')).write(subscriptions)
```

**File: `maildb.ts`** — **Remove all `.toLowerCase()` calls** on mailbox names. The DB stores canonical case
(`Sent`, `Drafts`, `Trash`, `Junk`, `Archive`, `''` for INBOX). Affected methods: `addEmail()`, `getAllEmails()`,
`getEmailsCount()`, `getEmailsCountUnread()`, `moveEmail()`, `renameMailbox()`, `deleteMailbox()`.

**File: `mail.ts` facade** — Fix hardcoded lowercase mailbox names:
- `messageSend()`: `this.messageMove(mail.id, 'sent')` → `'Sent'`

**File: `maildir.ts`** — Fix hardcoded lowercase references:
- `messageDelete()`: `email.mailbox || 'inbox'` → not needed (DB stores canonical)
- `messageHandleDraft()` SSE: `mailbox: 'drafts'` → `'Drafts'`

**File: `mailutils.ts`** — Update `getStandardMailboxFlags()`: handle `Junk` instead of `Spam`.

**Frontend fixes** (all lowercase mailbox comparisons must use canonical case):
- `email-detail.tsx`: `email.mailbox !== 'archive'` → `'Archive'`, `email.mailbox !== 'spam'` → `'Junk'`
- `_auth.$filterType.$filterId.tsx`: `mail.mailbox === 'trash'` → `'Trash'`,
  `handleMoveEmail(email, 'spam')` → `'Junk'`, `handleMoveEmail(email, 'archive')` → `'Archive'`
- `use-emails.ts`: `useDeleteEmail` checks `email.mailbox === 'trash'` → `'Trash'`
- `email-sidebar.tsx`: Update hardcoded fallback paths (already uses flag-based matching, mostly correct)

---

## 4. Folder Policy

### Decision: Fixed 6 Mailboxes Only

Eigen's UI exposes only the 6 standard mailboxes: **INBOX, Sent, Drafts, Trash, Junk, Archive**. No user-created
folders in Eigen. The existing `emailLabels` table provides a better organizational model (tags > folders).

### Extra Folders Created via IMAP

IMAP clients can create additional folders via Dovecot. Instead of trying to prevent this:

- **Tolerate on disk**: Extra folders exist and work through IMAP.
- **Don't index in Eigen**: `syncAllMailboxes()` only syncs the 6 standard mailboxes. Messages in extra folders
  are invisible to Eigen but fully accessible through any IMAP client.
- **Don't expose in UI**: `mailboxesList()` returns only the 6 standard mailboxes.

This is simpler than indexing extra folders. If someone moves a message from INBOX to a custom "Projects" folder
via IMAP, Eigen detects it as "deleted from INBOX" (correct — it's gone). The message remains accessible via IMAP.
If they move it back to INBOX, Eigen picks it up again on next sync.

---

## 5. Delivery Flow

### Current

```
write message → Maildir/new/{id}.eml
mailboxGet('') → move new/*.eml to cur/*.eml (same filename, no :2, suffix)
readAndParse() → add to DB
```

No `tmp/` intermediate step. `.eml` extension. No size hint. `mailboxGet()` does double duty: moves `new/` → `cur/`
AND reconciles DB — but only adds new messages, doesn't detect deletions or flag changes.

### Standard

```
write message → tmp/{unique},S={size}
rename()      → new/{unique},S={size}           # atomic, no extension
MUA/sync      → cur/{unique},S={size}:2,        # moved with empty flags (unseen)
```

**Delivery must go through `tmp/` first**, then `rename()` to `new/`. This ensures atomicity — a partial file never
appears in `new/`.

### Who Moves `new/` → `cur/`?

| Mode | `new/` → `cur/` handled by | Notes |
|------|---------------------------|-------|
| **Dovecot running** | Dovecot | Eigen only reads `cur/`. Messages in `new/` appear on next Dovecot scan. |
| **Eigen standalone** | Eigen's `syncMailbox()` | Moves files from `new/` to `cur/` with `:2,` suffix. |

The sync engine handles both: attempts `new/` → `cur/` move, treats `ENOENT` as no-op (Dovecot already moved it).

### Fix

**File: `maildir-store.ts`** — Add `deliverAtomic()` and update `moveNewToCur()`:

```typescript
async deliverAtomic(message: string, mailbox: string): Promise<{uniqueId: string, size: number}> {
    const uniqueId = createUniqueMessageId()
    const size = Buffer.byteLength(message, 'utf-8')
    const filename = `${uniqueId},S=${size}`
    const mailboxPath = this.mailboxDir(mailbox)

    const tmpPath = this.storage.pathJoin(mailboxPath, TMP, filename)
    await this.storage.file(tmpPath).write(message)

    const newPath = this.storage.pathJoin(mailboxPath, NEW, filename)
    await this.storage.rename(tmpPath, newPath)

    return {uniqueId, size}
}

async moveNewToCur(mailbox: string): Promise<void> {
    const mailboxPath = this.mailboxDir(mailbox)
    for (const fileName of await this.listNewFiles(mailbox)) {
        const src = this.storage.pathJoin(mailboxPath, NEW, fileName)
        const curName = fileName.includes(':') ? fileName : `${fileName}:2,`
        const dst = this.storage.pathJoin(mailboxPath, CUR, curName)
        try {
            await this.storage.rename(src, dst)
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e
        }
    }
}
```

**File: `maildir.ts`** — `mailboxDeliver()` calls `store.deliverAtomic()` then triggers sync.

### Incoming Mail

With Dovecot, incoming mail is delivered by Dovecot's LDA or LMTP directly to `new/`. Eigen detects it via sync.
Eigen's `/mail/deliver/:to` endpoint still works for internal notifications or MTA-less deployments.

### tmp/ Cleanup

Maildir spec: files in `tmp/` older than 36 hours can be safely deleted. Add a housekeeping method in
`MaildirStore` to clean stale `tmp/` files on startup.

---

## 6. Draft Handling

### Current

Drafts written directly to `Maildir/.drafts/cur/{id}.eml` via `MaildirStore.writeToMailboxCur()`. No `:2,` suffix,
no `D` flag, no `tmp/` atomicity.

### Fix

For locally-created content (drafts, sent copies), deliver via `tmp/` → `cur/` directly with flags. Eigen knows
the final flags at creation time, so there is no reason to go through `new/` and wait for sync. This is common
practice for MUAs and Dovecot handles it fine (assigns UID on next scan of `cur/`).

**File: `maildir-store.ts`** — Add `deliverToCur()`:

```typescript
async deliverToCur(mailbox: string, message: string, flags: Record<string, boolean>): Promise<{uniqueId: string, size: number, filename: string}> {
    const uniqueId = createUniqueMessageId()
    const size = Buffer.byteLength(message, 'utf-8')
    const filename = buildMaildirFilename(uniqueId, flags, size)
    const mailboxPath = this.mailboxDir(mailbox)

    const tmpPath = this.storage.pathJoin(mailboxPath, TMP, filename)
    await this.storage.file(tmpPath).write(message)

    const curPath = this.storage.pathJoin(mailboxPath, CUR, filename)
    await this.storage.rename(tmpPath, curPath)

    return {uniqueId, size, filename}
}
```

**File: `maildir.ts`** — `messageHandleDraft()`:

```typescript
async messageHandleDraft(email: EmailDraft): Promise<EmailDraft> {
    // Delete old draft file if updating existing
    if (email.id) {
        const old = this.db.getEmail(email.id)
        if (old) await this.store.deleteMessage(old.mailbox, old.filename)
        this.db.deleteEmail(email.id)
    }

    const emlContent = createEmlContent(/* ... */)
    const {uniqueId, size, filename} = await this.store.deliverToCur('Drafts', emlContent, {draft: true, seen: true})
    // parse, add to DB with filename, emit SSE
}
```

When updating an existing draft: delete old file first, then deliver new version. Brief window where draft doesn't
exist on disk is acceptable for single-user.

---

## 7. Message Move and Copy

### Current

Move: `MaildirStore.moveMessage()` renames `{source}/cur/{id}.eml` → `{target}/cur/{id}.eml`.
Copy: `MaildirStore.copyMessage()` reads content and writes to target `cur/`.
Both hardcode `{id}.eml` filenames.

### Fix: Move to target `cur/` preserving flags

Move directly from source `cur/` to target `cur/`, preserving the full filename including `:2,FLAGS`.

Dovecot detects the new file in target `cur/` on next scan and assigns a new UID. This is expected — IMAP MOVE
is semantically COPY + EXPUNGE, so UID reassignment is normal.

```typescript
// MaildirStore
async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string): Promise<void> {
    const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), CUR, fromFilename)
    const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), CUR, fromFilename)
    await this.storage.rename(srcPath, dstPath)
}
```

> **Why not move to `new/` (as in the original plan)?**
> 1. **Loses flags** — a read message becomes unread, a flagged message loses its flag.
> 2. **Requires workaround** — standalone mode would need to "remember and restore" original flags, adding
>    complexity and a potential race condition.
> 3. Moving to `cur/` is what most MUAs do for local moves. Both Dovecot and Eigen handle new files in `cur/`.

**File: `maildir.ts`** — `messageMove()`: rename file, update DB mailbox column in place:

```typescript
async messageMove(messageId: string, targetMailbox: string): Promise<void> {
    const email = this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    await this.store.moveMessage(email.mailbox, email.filename, targetMailbox)
    this.db.updateMailbox(messageId, targetMailbox)

    this.emit(SSEventType.MAIL_MOVED, {
        messageId, mailbox: email.mailbox, toMailbox: targetMailbox, subject: email.subject,
    })
}
```

No delete + re-insert needed. Just an in-place update of the `mailbox` column.

### Fix: Copy via `deliverAtomic()`

IMAP COPY creates a new message. Read source content, deliver to target:

```typescript
async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
    const email = this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    const {content} = await this.store.readMessage(email.mailbox, email.filename)
    await this.store.deliverAtomic(content, targetMailbox)
    await this.syncMailbox(targetMailbox)
}
```

---

## 8. Maildir Sync (Critical New Feature)

### Why

When Dovecot (or any IMAP client) accesses the Maildir, changes happen outside of Eigen:
- New mail delivered to `new/`
- Files renamed in `cur/` (flag changes)
- Files deleted from `cur/` (expunge)
- Messages moved between folders

### Approach: Scan-Based Sync

`syncMailbox(mailbox)` in `Maildir` handles four cases:

#### a) Messages in `new/` (standalone mode fallback)

```
for file in new/:
    curFilename = file + ':2,'
    try: rename new/{file} → cur/{curFilename}
    catch ENOENT: skip           # Dovecot already moved it
```

#### b) New messages (file in `cur/`, not in DB)

```
for file in cur/:
    id = getMailIDfromFileName(file)
    if not in DB:
        parseEml() → apply flags from filename → insert into DB
        emit SSE MAIL_RECEIVED
```

#### c) Flag changes (file in `cur/` with different filename than DB record)

```
for file in cur/:
    id = getMailIDfromFileName(file)
    dbRecord = DB.get(id)
    if dbRecord and dbRecord.filename != file:
        parseFlagsFromFilename() → update DB flags + filename
        emit SSE MAIL_FLAGS_CHANGED
```

#### d) Deleted messages (record in DB, file gone from `cur/`)

```
dbRecords = DB.getAllEmails(mailbox)
for record in dbRecords:
    if record.id not in diskFiles:
        delete from DB
        emit SSE MAIL_DELETED
```

### Implementation

```typescript
async syncMailbox(mailbox: string): Promise<void> {
    // Phase 1: Move new/ → cur/ (standalone mode / fallback)
    await this.store.moveNewToCur(mailbox)

    // Phase 2: Build disk state from cur/
    const diskFiles = new Map<string, string>()  // messageId → filename
    for (const fileName of await this.store.listCurFiles(mailbox)) {
        if (!fileName.startsWith('.')) {
            diskFiles.set(getMailIDfromFileName(fileName), fileName)
        }
    }

    // Phase 3: Get DB state
    const dbRecords = this.db.getAllEmails(mailbox)
    const dbById = new Map(dbRecords.map(r => [r.id, r]))

    // New messages (on disk but not in DB)
    for (const [id, fileName] of diskFiles) {
        if (!dbById.has(id)) {
            const {content, size} = await this.store.readMessage(mailbox, fileName)
            const parsed = await parseEml(id, mailbox, content, size)
            if (parsed) {
                applyFlagsFromFilename(parsed, fileName)
                parsed.filename = fileName
                this.db.addEmail(parsed)
                this.emit(SSEventType.MAIL_RECEIVED, { messageId: id, mailbox })
            }
        }
    }

    // Flag changes (on disk with different filename)
    for (const [id, record] of dbById) {
        const diskFilename = diskFiles.get(id)
        if (diskFilename && diskFilename !== record.filename) {
            const flags = parseFlagsFromFilename(diskFilename)
            this.db.updateFlags(id, flags, diskFilename)
            this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: id, mailbox })
        }
    }

    // Deleted messages (in DB but not on disk)
    for (const [id] of dbById) {
        if (!diskFiles.has(id)) {
            this.db.deleteEmail(id)
            this.emit(SSEventType.MAIL_DELETED, { messageId: id, mailbox })
        }
    }
}
```

### `syncAllMailboxes()`

Only syncs the 6 standard mailboxes (not extra IMAP-created folders):

```typescript
async syncAllMailboxes(): Promise<void> {
    for (const mailbox of STANDARD_MAILBOXES) {
        await this.syncMailbox(mailbox)
    }
}
```

### When to Sync

| Trigger | Method | Notes |
|---------|--------|-------|
| API request for mailbox contents | `syncMailbox(mailbox)` | Before returning data |
| Periodic background poll | `syncAllMailboxes()` every 30s | Catches Dovecot changes |
| After Eigen writes (deliver, move, etc.) | `syncMailbox(mailbox)` | Immediate consistency |

**Start with polling. Add filesystem watchers later as an optimization.** `fs.watch()` has platform-specific
quirks (especially on networked filesystems and Windows). Polling every 30s is simple, reliable, and sufficient
for a self-hosted system. If lower latency is needed later, add `fs.watch()` on each mailbox's `cur/` and `new/`
with debouncing.

### SSE Events for Sync

**Critical missing piece from original plan.** When `syncMailbox()` detects changes made by Dovecot, it must emit
SSE events so the frontend updates without a page refresh:

- New message detected → `MAIL_RECEIVED`
- Flag change detected → `MAIL_FLAGS_CHANGED` (new event type)
- Message deleted → `MAIL_DELETED`

### Concurrency

Add a simple per-mailbox lock (or flag) to prevent redundant concurrent syncs on the same mailbox. If a sync
is already running for a mailbox, skip. This avoids wasted work during rapid changes.

```typescript
private syncingMailboxes = new Set<string>()

async syncMailbox(mailbox: string): Promise<void> {
    if (this.syncingMailboxes.has(mailbox)) return
    this.syncingMailboxes.add(mailbox)
    try {
        // ... sync logic ...
    } finally {
        this.syncingMailboxes.delete(mailbox)
    }
}
```

### Performance Note

For each new message found during sync, the full EML is parsed. For bulk delivery of 100+ messages by Dovecot,
this could be slow. **Optimization for later**: during sync, only parse headers (subject, from, date) for the
summary. Defer full body parsing to `messageGet()`. For now, full parse on sync is fine — Eigen is a single-user
system and bulk deliveries are rare.

---

## 9. Dovecot Control Files

### Files Dovecot Creates

| File | Purpose | Eigen should... |
|------|---------|-----------------|
| `dovecot-uidlist` | Maps IMAP UIDs to filenames. Contains UIDVALIDITY. | **Never modify.** |
| `dovecot-keywords` | Maps custom keywords (`a-z`) to keyword names. | **Never modify.** Read to resolve lowercase flags if needed. |
| `dovecot.index*` | Index, transaction log, cache. | **Ignore.** Dovecot rebuilds if deleted. |
| `subscriptions` | IMAP folder subscriptions. | **Read and write.** Eigen writes on mailbox creation. Dovecot updates on subscribe/unsubscribe. |

**Critical**: Never delete `dovecot-uidlist` — forces all IMAP clients to re-download everything (UIDs reset).

### Files Eigen Creates

| File | Status |
|------|--------|
| `mail.db` | Keep. Dovecot ignores SQLite files. |
| `.attributes` | **Remove.** Non-standard. Dovecot's namespace config handles special-use flags. |
| `maildirfolder` | **Add.** Required by Maildir++ spec in each subfolder. |

---

## 10. `readAndParse()` Changes

### Current

Builds filename as `{messageId}.eml` and calls `MaildirStore.readMessage()`. Every method that reads a message
(`messageGet()`, `messageGetFile()`, `messageGetAttachment()`, `messageDelete()`) hardcodes this pattern.

### Fix

Look up the actual filename from the DB's `filename` column. Fallback to disk scan if not found:

```typescript
private async readAndParse(messageId: string, mailbox: string, filename?: string): Promise<Email | null> {
    if (!filename) {
        const record = this.db.getEmail(messageId)
        filename = record?.filename
    }
    if (!filename) {
        // Fallback: scan cur/ — should rarely happen, log a warning
        console.warn(`readAndParse: filename not in DB for ${messageId}, scanning disk`)
        filename = await this.store.findFileByUniqueId(messageId, mailbox)
    }
    if (!filename) return null

    const {content, size} = await this.store.readMessage(mailbox, filename)
    return parseEml(messageId, mailbox, content, size)
}
```

`findFileByUniqueId()` is O(n) — a safety net, not a primary path. Log a warning when it's used.

**Also update:** `messageGetFile()`, `messageGetAttachment()`, and `messageDelete()` — all must use DB-stored
filename instead of hardcoded `{id}.eml`.

---

## 11. Schema Update

### New `emails` Table

```sql
CREATE TABLE emails (
    id         TEXT PRIMARY KEY,      -- logical message ID (unique part, no ,S= or :2,)
    filename   TEXT NOT NULL,         -- full Maildir filename in cur/ (for rename detection)
    subject    TEXT NOT NULL,
    fromShort  TEXT NOT NULL,
    textShort  TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    date       INTEGER NOT NULL,
    isRead     INTEGER NOT NULL DEFAULT 0,   -- 'S' flag
    isFlagged  INTEGER NOT NULL DEFAULT 0,   -- 'F' flag (starred in UI)
    isDraft    INTEGER NOT NULL DEFAULT 0,   -- 'D' flag
    isReplied  INTEGER NOT NULL DEFAULT 0,   -- 'R' flag
    hasAttachments INTEGER NOT NULL DEFAULT 0,
    mailbox    TEXT NOT NULL,                 -- canonical case ('Sent', not 'sent')
    createdAt  INTEGER DEFAULT (unixepoch()),
    updatedAt  INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_emails_mailbox ON emails(mailbox);
```

Changes from current:
- **+ `filename`** — full Maildir filename for sync/rename detection
- **+ `isReplied`** — `R` flag / `\Answered`
- **~ `isStarred` → `isFlagged`** — `F` flag / `\Flagged`
- **- `_isParsed`** — removed, unused with sync-based approach
- **+ index on `mailbox`** — performance for `getAllEmails(mailbox)` queries
- **`mailbox` stores canonical case** — `'Sent'` not `'sent'`

Data is throwaway during dev — just replace the schema and migration. No backward compatibility needed.

---

## 12. Summary of Changes by File

### `apps/api/src/lib/core/constants.ts`

- `STANDARD_MAILBOXES`: `'Spam'` → `'Junk'`

### `apps/api/src/lib/mail/mailutils.ts`

| Function | Change |
|----------|--------|
| `createUniqueMessageId()` | `{time}.M{usec}P{pid}Q{seq}.{hostname}` format |
| `getMailIDfromFileName()` | Extract unique part before `,` and `:` (drop `.eml` logic) |
| `getStandardMailboxFlags()` | `Junk` instead of `Spam` |
| **new** `buildMaildirFilename()` | Build `{unique},S={size}:2,{FLAGS}` |
| **new** `parseFlagsFromFilename()` | Extract flags from `:2,{FLAGS}` suffix |
| **new** `rebuildFlagsSuffix()` | Update standard flags, preserve keyword flags |
| **new** `applyFlagsFromFilename()` | Apply parsed flags to an `EmailSummary` |

### `apps/api/src/lib/mail/maildir-store.ts`

| Method | Change |
|--------|--------|
| `createStandardMailboxes()` | Add `maildirfolder` markers, write `subscriptions` |
| `mailboxDir()` | Stop lowercasing — case-preserving |
| `deliver()` | Replace with `deliverAtomic()`: `tmp/` → `new/`, `,S=` size hint, no `.eml` |
| `moveNewToCur()` | Append `:2,` suffix, catch `ENOENT` |
| `moveMessage()` | Move to target `cur/` preserving flags (not `new/`) |
| **new** `deliverToCur()` | `tmp/` → `cur/` with flags (for drafts, sent copies) |
| **new** `findFileByUniqueId()` | Scan `cur/` to find file by message ID (fallback) |
| **new** `renameInCur()` | Rename within same `cur/` (for flag updates) |
| **new** `cleanStaleTmp()` | Remove `tmp/` files older than 36 hours |

### `apps/api/src/lib/mail/maildir.ts`

| Method | Change |
|--------|--------|
| `mailboxDeliver()` | Call `store.deliverAtomic()`, then `syncMailbox()` |
| `mailboxGet()` | Call `syncMailbox()` then return from DB |
| `mailboxesList()` | Filter to `STANDARD_MAILBOXES` only |
| `messageMove()` | `store.moveMessage()` (to `cur/`), update DB mailbox in place |
| `messageCopy()` | Read content, deliver via `store.deliverAtomic()`, sync target |
| `messageHandleDraft()` | `store.deliverToCur('Drafts', ..., {draft: true, seen: true})` |
| `messageSetRead()` | Rename file via `store.renameInCur()`, update DB |
| `readAndParse()` | Accept filename parameter, look up from DB/disk |
| **new** `messageSetFlagged()` | Rename file to toggle `F` flag |
| **new** `syncMailbox()` | Full scan sync: `new/` → `cur/`, new files, flag changes, deletions, SSE |
| **new** `syncAllMailboxes()` | Sync 6 standard mailboxes |

### `apps/api/src/lib/mail/maildb.ts`

| Method | Change |
|--------|--------|
| All methods | Remove `.toLowerCase()` on mailbox names |
| `addEmail()` | Include `filename`, `isReplied`, `isFlagged` |
| `~ setStarred()` → `setFlagged()` | Rename |
| **new** `updateFlags()` | Update flag columns + filename from sync |
| **new** `setFilename()` | Update filename after flag rename |
| **new** `updateMailbox()` | Update mailbox column (for moves) |

### `apps/api/src/lib/mail/mail-parse.ts`

- **Remove** hardcoded flag defaults (`isDraft`, `isRead`, `isStarred`). Parser returns content only.

### `apps/api/src/lib/mail/schema.ts` + `db-config.ts`

- Add `filename`, `isReplied`, rename `isStarred` → `isFlagged`, remove `_isParsed`, add mailbox index.

### `apps/api/src/routes/mail.ts`

- Add `PUT /mail/:ownerId/message/:id/flagged` route.

### `packages/lib/src/types/mail.ts`

- `EmailSummary`: + `filename`, + `isReplied`, `isStarred` → `isFlagged`, - `_isParsed`

### `packages/lib/src/core/mail/hooks/use-emails.ts`

- `isStarred` → `isFlagged` references
- Add `useToggleFlaggedEmail()` hook

### `apps/mail/src/` (Frontend)

- All lowercase mailbox comparisons → canonical case (`'Trash'`, `'Junk'`, `'Archive'`)
- `isStarred` → `isFlagged` in components (UI label stays "starred")
- `'Spam'` → `'Junk'` in display and move targets

---

## 13. Dovecot Configuration (Reference)

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

The `~/Maildir` path maps to `data/home/{userId}/eigen.mail/Maildir` in Eigen's data layout.

---

## 14. Implementation Order

| Step | Scope | Description |
|------|-------|-------------|
| 1 | `mailutils.ts` | Filename helpers: `createUniqueMessageId()`, `getMailIDfromFileName()`, `buildMaildirFilename()`, `parseFlagsFromFilename()`, `rebuildFlagsSuffix()`, `applyFlagsFromFilename()` |
| 2 | `schema.ts`, `db-config.ts`, `types/mail.ts` | Schema: + `filename`, + `isReplied`, `isStarred` → `isFlagged`, - `_isParsed`, + mailbox index |
| 3 | `constants.ts` | `STANDARD_MAILBOXES`: `'Spam'` → `'Junk'` |
| 4 | `maildir-store.ts` | `deliverAtomic()`, `deliverToCur()`, `moveNewToCur()`, `renameInCur()`, `findFileByUniqueId()`, `cleanStaleTmp()`. Fix `mailboxDir()`, `createStandardMailboxes()`. |
| 5 | `maildb.ts` | Remove lowercase, add `updateFlags()`, `setFilename()`, `updateMailbox()`, rename `setStarred` → `setFlagged` |
| 6 | `mail-parse.ts` | Remove hardcoded flag defaults |
| 7 | `maildir.ts` | `syncMailbox()`, `syncAllMailboxes()`, update all methods to use new store/DB APIs, fix hardcoded names, add `messageSetFlagged()` |
| 8 | `mail.ts`, `routes/mail.ts` | Fix facade mailbox names, add flagged route |
| 9 | Frontend | `isStarred` → `isFlagged`, lowercase → canonical mailbox names, `Spam` → `Junk` |
| 10 | Cleanup | Remove `.attributes` file support, add `tmp/` cleanup, periodic sync |

Each step should be independently testable. Delete dev data between steps if schema changes.

---

## 15. Edge Cases and Risks

| Scenario | Behavior | Risk |
|----------|----------|------|
| Dovecot and Eigen rename same file simultaneously | One rename fails with ENOENT. Next sync corrects. | Low — self-correcting |
| IMAP client moves message to custom folder | Eigen detects deletion from source. Message accessible via IMAP. | None — by design |
| IMAP client moves message from custom folder to INBOX | Eigen detects new message on next INBOX sync. | None — works correctly |
| Dovecot delivers 1000 messages at once | Next sync parses all 1000. Could take a few seconds. | Low — optimize later with header-only parse |
| `mail.db` gets corrupted or deleted | Rebuild by running `syncAllMailboxes()` on empty DB. | None — DB is a cache |
| File exists in `cur/` but is 0 bytes (partial write) | `parseEml()` returns null, message skipped in sync. | Low — log warning |
| Filename has unexpected format (no `:2,`) | `parseFlagsFromFilename()` returns all-false. `getMailIDfromFileName()` returns whole filename. | Low — safe defaults |
| Two Eigen instances for same user | Sync-on-request means each sees consistent state. Writes may conflict. | Out of scope — single-user |
| Network filesystem (NFS) | `rename()` not atomic. `fs.watch()` unreliable. | Use polling, not watchers. Avoid NFS for Maildir. |
