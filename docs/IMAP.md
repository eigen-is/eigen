# IMAP / Dovecot Maildir Compatibility

This document describes how to make Eigen's mail backend fully compatible with Dovecot so that both Eigen and Dovecot
can read and write from the same Maildir structure. The goal is for Dovecot to handle IMAP access while Eigen's API
keeps `mail.db` in sync by scanning the Maildir for changes.

## Design Principles

1. **Dovecot is the Maildir owner.** When Dovecot is running, it manages `new/` → `cur/` moves, flag renames, and
   expunges. Eigen treats the Maildir as a shared data store and syncs from it.
2. **Eigen writes are safe by default.** Eigen only delivers to `new/` (always safe, no coordination needed) and
   reads from `cur/`. For flag changes, moves, and deletes, Eigen renames files in `cur/` directly — this works
   reliably in practice but can cause a UID reassignment if Dovecot is scanning at the exact same moment.
3. **`mail.db` is a cache.** The Maildir on disk is the source of truth. The DB accelerates queries and stores
   parsed metadata. It can always be rebuilt by scanning the Maildir.
4. **Fixed mailbox set.** Eigen exposes only the 6 standard mailboxes (INBOX, Sent, Drafts, Trash, Junk, Archive).
   Extra folders created via IMAP clients are tolerated on disk but not shown in Eigen's UI.

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
1709234567.M412345P9876V00000001I0004F030.mail.example.com
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

Extract the logical message ID: the unique part before any `,S=` size hint or `:2,` flags. This ensures the ID
is stable even if Dovecot adds `,W=` (virtual size) or other extensions later:

```typescript
function getMailIDfromFileName(fileName: string): string {
    // Strip :2,FLAGS suffix
    const colonIndex = fileName.indexOf(':')
    const withoutFlags = colonIndex >= 0 ? fileName.substring(0, colonIndex) : fileName
    // Strip ,S=size and ,W=vsize hints
    const commaIndex = withoutFlags.indexOf(',')
    return commaIndex >= 0 ? withoutFlags.substring(0, commaIndex) : withoutFlags
}
```

Add helpers to build and parse Maildir filenames:

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

function parseFlagsFromFilename(fileName: string): { seen: boolean, replied: boolean, flagged: boolean, draft: boolean, trashed: boolean, forwarded: boolean } {
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

Note: the regex uses `[A-Za-z]*` to capture both standard flags (uppercase) and Dovecot custom keywords (lowercase).
Eigen only interprets the uppercase flags but preserves the full flag string when rebuilding filenames to avoid
stripping keywords Dovecot set.

To preserve unknown flags during rename, add a helper that replaces only the known flags while keeping the rest:

```typescript
function rebuildFlagsSuffix(currentFilename: string, changes: Partial<Record<string, boolean>>): string {
    const match = currentFilename.match(/:2,([A-Za-z]*)/)
    const existing = match?.[1] || ''
    // Keep lowercase (keyword) flags untouched
    const keywords = existing.replace(/[A-Z]/g, '')
    // Build new standard flags
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
When Dovecot changes flags (e.g. user marks a message as read via IMAP), Eigen never sees it.

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
```

The frontend can keep calling it "starred" in the UI — it maps to `\Flagged` in IMAP, which is what every mail
client uses for stars/importance.

#### Writing flags to disk (`maildir.ts`)

When Eigen changes a flag (e.g. `messageSetRead`), rename the file to update the flag suffix. Use
`rebuildFlagsSuffix()` to preserve any Dovecot keyword flags:

```typescript
async messageSetRead(messageId: string, read: boolean): Promise<void> {
    const email = await this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    const oldPath = this.getFullPathByFilename(email.mailbox, email.filename)
    const newFlagStr = rebuildFlagsSuffix(email.filename, { seen: read })
    const uniqueWithSize = email.filename.split(':')[0]
    const newFilename = `${uniqueWithSize}:2,${newFlagStr}`
    const newPath = this.getFullPathByFilename(email.mailbox, newFilename)

    await this.storage.rename(oldPath, newPath)
    await this.db.setRead(messageId, read)
    await this.db.setFilename(messageId, newFilename)
    // ... emit SSE
}
```

This rename is safe in practice. The theoretical risk — Dovecot scanning `cur/` at the exact same instant and
temporarily "losing" the message — is unlikely and self-correcting (Dovecot finds the file again on next scan and
assigns a new UID). For a self-hosted single-user system this is acceptable.

#### Reading flags from disk (sync — see section 7)

During Maildir sync, parse flags from every filename in `cur/` and update the DB if they differ.

---

## 3. Mailbox Directory Names

### Current

```
Maildir/.sent/
Maildir/.drafts/
Maildir/.trash/
Maildir/.spam/
Maildir/.archive/
```

All lowercase. Spam folder called `.spam/`.

### Standard (Maildir++)

Dovecot uses **capitalized** names by convention, and the Junk folder is called `.Junk/` (matching the `\Junk`
special-use attribute from RFC 6154):

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

**File: `maildir.ts`** — `createMailboxes()`

Change default mailbox names to capitalized, rename `Spam` → `Junk`:

```typescript
const STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'] as const
```

Add `maildirfolder` marker file creation for each subfolder:

```typescript
if (mailbox !== '') {
    await this.storage.file(this.storage.pathJoin(mailboxPath, 'maildirfolder')).write('')
}
```

Write a `subscriptions` file in the Maildir root so Dovecot knows which folders exist:

```typescript
const subscriptions = STANDARD_MAILBOXES.filter(m => m !== '').join('\n') + '\n'
await this.storage.file(this.storage.pathJoin(this.basePath, 'subscriptions')).write(subscriptions)
```

**File: `maildir.ts`** — `sanitizeDirName()`

Stop lowercasing mailbox names. The directory names should be case-preserving:

```typescript
private sanitizeDirName(mailbox: string, sub: string = '') {
    if (mailbox === '' || mailbox === 'INBOX') {
        return sub ? `${this.basePath}/${sub}` : this.basePath
    }
    const dirname = `${this.basePath}/.${mailbox.replace('/', '.')}`
    return sub ? `${dirname}/${sub}` : dirname
}
```

The DB `mailbox` column should store the canonical name (`Sent`, not `sent`). Matching should be case-insensitive
for INBOX only.

**File: `mailutils.ts`** — Update `getStandardMailboxFlags()` to handle `Junk` instead of `Spam`.

**Frontend:** Update the sidebar to handle `Junk` as the mailbox name. The `\Junk` flag is already handled.

---

## 4. Folder Policy

### Decision: Fixed 6 Mailboxes Only

Eigen's UI exposes only the 6 standard mailboxes: **INBOX, Sent, Drafts, Trash, Junk, Archive**. No user-created
folders in Eigen's interface. The existing `emailLabels` table provides a better organizational model (tags > folders).

### Extra Folders Created via IMAP

IMAP clients connected through Dovecot can create additional folders. There is no clean way to prevent this in
Dovecot without the ACL plugin (which adds significant complexity for little benefit). Instead:

- **Tolerate on disk**: `syncMailbox()` handles any folder that exists — mail in extra folders gets indexed in
  `mail.db` so it is not lost.
- **Don't expose in UI**: `mailboxesList()` filters to the known 6 mailboxes only. Extra folders created via IMAP
  are invisible in Eigen but fully accessible through any IMAP client.
- **No nested folder support**: Remove `processNestedMailboxes()` from the hot path. Eigen never creates nested
  folders. If an IMAP client creates `.Projects.2024/`, the sync engine indexes its messages but the UI ignores it.

### Dovecot Configuration

No special configuration needed beyond the standard namespace. Dovecot's `auto = subscribe` on the 6 standard
mailboxes ensures IMAP clients see them. If an IMAP client creates extra folders, they exist on disk and work
through IMAP — they just don't appear in Eigen.

---

## 5. Delivery Flow

### Current

```
write message → Maildir/new/{id}.eml
mailboxGet('') → move new/*.eml to cur/*.eml (same filename)
parseMessage() → add to DB
```

Messages go directly to `new/` with `.eml` extension. On `mailboxGet()`, moved to `cur/` with the same filename
(no `:2,` suffix added).

### Standard

```
write message → tmp/{unique},S={size}
rename()      → new/{unique},S={size}           # atomic, no extension
MUA/sync      → cur/{unique},S={size}:2,        # moved with empty flags (unseen)
```

**Delivery must go through `tmp/` first**, then `rename()` to `new/`. This ensures atomicity — a partial file never
appears in `new/`. The `rename()` is atomic on POSIX filesystems.

Messages in `new/` have **no** `:2,` suffix. When moved to `cur/`, the `:2,` suffix is appended (with no flags
initially, meaning unseen).

### Who Moves `new/` → `cur/`?

This depends on the deployment mode:

| Mode | `new/` → `cur/` handled by | Notes |
|------|---------------------------|-------|
| **Dovecot running** | Dovecot | Eigen's sync only reads `cur/`. If messages linger in `new/` (Dovecot hasn't picked them up yet), sync skips them — they appear on the next Dovecot scan. |
| **Eigen standalone** (dev, no Dovecot) | Eigen's `syncMailbox()` | Eigen moves files from `new/` to `cur/` with `:2,` suffix appended. |

The sync engine handles both modes: it attempts the `new/` → `cur/` move but treats `ENOENT` (file already gone)
as a no-op, so it is safe even if Dovecot moved the file first.

### Fix

**File: `maildir.ts`** — `mailboxDeliver()`

```typescript
async mailboxDeliver(message: string, mailbox = '', notify = true): Promise<string> {
    const uniqueId = createUniqueMessageId()
    const size = Buffer.byteLength(message, 'utf-8')
    const filename = `${uniqueId},S=${size}`

    const mailboxPath = this.sanitizeDirName(mailbox)

    // Write to tmp/ first (atomic delivery)
    const tmpPath = this.storage.pathJoin(mailboxPath, 'tmp', filename)
    await this.storage.file(tmpPath).write(message)

    // Atomic rename to new/ (safe even with Dovecot running)
    const newPath = this.storage.pathJoin(mailboxPath, 'new', filename)
    await this.storage.rename(tmpPath, newPath)

    // Trigger sync (handles new/ → cur/ if Dovecot hasn't already)
    await this.syncMailbox(mailbox)
    // ... emit SSE
    return uniqueId
}
```

### Incoming Mail Transition

Currently `POST /mail/deliver/:to` is the public endpoint for incoming mail. With Dovecot, incoming mail is
typically delivered by Dovecot's LDA or LMTP service. Both paths can coexist:

- **Dovecot LDA/LMTP**: Delivers directly to Maildir `new/`. Eigen detects it via sync.
- **Eigen's `/mail/deliver/:to`**: Still works — delivers via `tmp/` → `new/`. Useful for internal notifications,
  forwarding, or deployments without a full MTA.

No code changes needed for the endpoint itself — only the delivery mechanism inside it (use `tmp/` → `new/`).

---

## 6. Draft Handling

### Current

Drafts are written directly to `Maildir/.drafts/cur/{id}.eml`. The filename has no `:2,` suffix and no `D` flag.

### Standard

Drafts should be delivered the same way: `tmp/` → `new/` → `cur/` with the `D` (Draft) and `S` (Seen) flags:

```
cur/{unique},S=1234:2,DS
```

### Fix

**File: `maildir.ts`** — `messageHandleDraft()`

Use the shared `mailboxDeliver()` to write to the Drafts mailbox's `new/`. The sync engine moves it to `cur/` with
`:2,` suffix. Then update flags to `DS` via a rename.

When updating an existing draft, delete the old file first, then deliver the new version. IMAP messages are
immutable — never modify a file in place.

---

## 7. Message Move and Copy

### Current

Move: renames `{source}/cur/{id}.eml` → `{target}/cur/{id}.eml`. Copy: reads and writes content.

### Standard

- **Move**: Rename from source `cur/` to target `new/` (stripping the `:2,FLAGS` suffix). This is a metadata-only
  operation — no file content is read or copied. Dovecot assigns a new UID when it picks up the file from `new/`.
  In standalone mode, Eigen's sync moves it to `cur/` with `:2,` and the original flags restored.
- **Copy**: Must generate a **new unique ID** (IMAP COPY creates a new message). Read the source file content and
  deliver to target via `tmp/` → `new/`.

### Fix

**File: `maildir.ts`** — `messageMove()`

```typescript
async messageMove(messageId: string, targetMailbox: string): Promise<void> {
    const email = await this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    const sourcePath = this.getFullPathByFilename(email.mailbox, email.filename)
    const sourceMailbox = email.mailbox

    // Strip :2,FLAGS — target gets it as "new" (unseen)
    const filenameWithoutFlags = email.filename.split(':')[0]
    const targetPath = this.storage.pathJoin(
        this.sanitizeDirName(targetMailbox), 'new', filenameWithoutFlags
    )

    await this.storage.rename(sourcePath, targetPath)
    await this.db.deleteEmail(messageId)

    // Sync target mailbox (moves new/ → cur/, re-parses, inserts into DB)
    await this.syncMailbox(targetMailbox)

    this.emit(SSEventType.MAIL_MOVED, {
        messageId, mailbox: sourceMailbox,
        toMailbox: targetMailbox, subject: email.subject,
    })
}
```

**File: `maildir.ts`** — `messageCopy()`

```typescript
async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
    const email = await this.db.getEmail(messageId)
    if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

    const sourcePath = this.getFullPathByFilename(email.mailbox, email.filename)
    const content = await this.storage.file(sourcePath).text()
    // Deliver with a new unique ID
    await this.mailboxDeliver(content, targetMailbox, false)
}
```

---

## 8. Maildir Sync (Critical New Feature)

### Why

When Dovecot is also accessing the Maildir, changes happen outside of Eigen:
- Dovecot delivers new mail to `new/`
- Dovecot renames files in `cur/` (flag changes)
- Dovecot deletes files from `cur/` (expunge)
- Dovecot moves messages between folders
- IMAP clients create extra folders

Eigen's `mail.db` must stay in sync with these changes.

### Approach: Scan-Based Sync

Add a `syncMailbox(mailbox)` method that replaces the current `mailboxGet()` sync logic. This method handles four
cases:

#### a) Messages in `new/` (standalone mode only)

```
for file in new/:
    curFilename = file + ':2,'    # unseen
    try: rename new/{file} → cur/{curFilename}
    catch ENOENT: skip           # Dovecot already moved it
```

#### b) New messages (file in `cur/`, not in DB)

```
for file in cur/:
    id = getMailIDfromFileName(file)
    if not in DB:
        parse message → insert into DB with flags from filename
```

#### c) Flag changes (file in `cur/` with different filename than DB)

```
for file in cur/:
    id = getMailIDfromFileName(file)
    dbRecord = DB.get(id)
    if dbRecord and dbRecord.filename != file:
        parse flags from new filename → update DB flags + filename
```

#### d) Deleted messages (record in DB, file gone from `cur/`)

```
dbRecords = DB.getAllEmails(mailbox)
for record in dbRecords:
    if file not in cur/:
        delete from DB
```

### Implementation

```typescript
async syncMailbox(mailbox: string): Promise<void> {
    const mailboxPath = this.sanitizeDirName(mailbox)
    const curPath = this.storage.pathJoin(mailboxPath, 'cur')
    const newPath = this.storage.pathJoin(mailboxPath, 'new')

    // Phase 1: Move new/ → cur/ (standalone mode / fallback)
    // Safe even with Dovecot: ENOENT means Dovecot already moved it
    if (await this.storage.dirExists(newPath)) {
        for (const fileName of await this.storage.readdir(newPath)) {
            if (fileName.startsWith('.')) continue
            try {
                const curFilename = `${fileName}:2,`
                await this.storage.rename(
                    this.storage.pathJoin(newPath, fileName),
                    this.storage.pathJoin(curPath, curFilename)
                )
            } catch (e: any) {
                if (e.code !== 'ENOENT') throw e
                // File already moved by Dovecot — skip
            }
        }
    }

    // Phase 2: Scan cur/ — build disk state
    const diskFiles = new Map<string, string>()  // messageId → filename
    if (await this.storage.dirExists(curPath)) {
        for (const fileName of await this.storage.readdir(curPath)) {
            if (fileName.startsWith('.')) continue
            diskFiles.set(getMailIDfromFileName(fileName), fileName)
        }
    }

    const dbRecords = await this.db.getAllEmails(mailbox)
    const dbById = new Map(dbRecords.map(r => [r.id, r]))

    // New messages (on disk but not in DB)
    for (const [id, fileName] of diskFiles) {
        if (!dbById.has(id)) {
            const parsed = await this.parseMessage(id, mailbox, fileName)
            if (parsed) {
                applyFlagsFromFilename(parsed, fileName)
                parsed.filename = fileName
                await this.db.addEmail(parsed)
            }
        }
    }

    // Flag changes (in DB but filename differs)
    for (const [id, record] of dbById) {
        const diskFilename = diskFiles.get(id)
        if (diskFilename && diskFilename !== record.filename) {
            const flags = parseFlagsFromFilename(diskFilename)
            await this.db.updateFlags(id, flags, diskFilename)
        }
    }

    // Deleted messages (in DB but not on disk)
    for (const [id] of dbById) {
        if (!diskFiles.has(id)) {
            await this.db.deleteEmail(id)
        }
    }
}
```

### Discovering Extra Mailboxes

To detect folders created by IMAP clients, `syncAllMailboxes()` should scan the Maildir root for dot-prefixed
directories beyond the standard 6:

```typescript
async syncAllMailboxes(): Promise<void> {
    // Always sync the standard set
    for (const mailbox of STANDARD_MAILBOXES) {
        await this.syncMailbox(mailbox)
    }
    // Discover and sync any extra folders (created via IMAP)
    const entries = await this.storage.readdir(this.basePath, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('.')) {
            const name = entry.name.substring(1) // strip leading dot
            if (!STANDARD_MAILBOXES.includes(name) && !['cur','new','tmp'].includes(name)) {
                await this.syncMailbox(name)
            }
        }
    }
}
```

### When to Sync

| Trigger | Method |
|---------|--------|
| API request for mailbox contents | `syncMailbox(mailbox)` before returning data |
| Periodic background poll | `syncAllMailboxes()` on interval (e.g. 30s) |
| `FSEvents`/`inotify` watch on `cur/` and `new/` | Immediate sync on filesystem change |

The filesystem watcher is the preferred approach for low-latency sync. Use `fs.watch()` on each mailbox's `cur/`
and `new/` directories. Debounce to avoid rapid re-scans during bulk operations.

---

## 9. Dovecot Control Files

### Files Dovecot Creates

| File | Purpose | Eigen should... |
|------|---------|-----------------|
| `dovecot-uidlist` | Maps IMAP UIDs to filenames. Contains UIDVALIDITY. | **Never modify.** Read-only if needed. |
| `dovecot-keywords` | Maps custom keywords (`a-z`) to IMAP keyword names. | **Never modify.** Read to resolve lowercase flags in filenames. |
| `dovecot.index` | Main index (cached flags, UIDs). | **Ignore.** Dovecot rebuilds if deleted. |
| `dovecot.index.log` | Transaction log. | **Ignore.** |
| `dovecot.index.cache` | Cached headers/body structure. | **Ignore.** |
| `subscriptions` | IMAP folder subscriptions (one name per line). | **Read and write.** Eigen writes it on mailbox creation. Dovecot updates it when IMAP clients subscribe/unsubscribe. |

**Critical rule**: Never delete `dovecot-uidlist` or `dovecot-keywords`. Deleting `dovecot-uidlist` forces all IMAP
clients to re-download all messages (UIDs reset). Deleting `dovecot-keywords` loses keyword-to-flag mappings.

### Files Eigen Creates That Dovecot Ignores

| File | Status |
|------|--------|
| `mail.db` | Keep. Dovecot does not touch SQLite files. |
| `.attributes` | **Remove.** Non-standard. Dovecot's namespace config handles special-use flags. |
| `maildirfolder` | **Add.** Required by Maildir++ spec in each subfolder. |

---

## 10. `parseMessage()` Changes

### Current

`parseMessage(messageId, mailbox)` builds the file path as `{sanitizeDirName(mailbox)}/cur/{messageId}.eml`.
This assumes a fixed filename format.

### Fix

`parseMessage()` must accept the actual filename (which includes `,S=` and `:2,FLAGS` suffixes) or look it up.
Since the DB now stores the `filename` column, use that:

```typescript
private async parseMessage(messageId: string, mailbox: string, filename?: string): Promise<Email | null> {
    if (!filename) {
        const record = await this.db.getEmail(messageId)
        filename = record?.filename
    }
    if (!filename) {
        // Scan cur/ to find it (first-time parse, not yet in DB)
        filename = await this.findFileByUniqueId(messageId, mailbox)
    }
    if (!filename) return null

    const filePath = `${this.sanitizeDirName(mailbox)}/cur/${filename}`
    // ... parse as before
}
```

---

## 11. Schema Update

### New `emails` Table Schema

```sql
CREATE TABLE emails (
    id         TEXT PRIMARY KEY,      -- logical message ID (unique part, no ,S= or :2,)
    filename   TEXT NOT NULL,         -- full Maildir filename in cur/ (for rename detection)
    subject    TEXT NOT NULL,
    fromShort  TEXT NOT NULL,
    textShort  TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    date       INTEGER NOT NULL,      -- unix timestamp
    isRead     INTEGER NOT NULL DEFAULT 0,   -- maps to 'S' flag
    isFlagged  INTEGER NOT NULL DEFAULT 0,   -- maps to 'F' flag (starred in UI)
    isDraft    INTEGER NOT NULL DEFAULT 0,   -- maps to 'D' flag
    isReplied  INTEGER NOT NULL DEFAULT 0,   -- maps to 'R' flag
    hasAttachments INTEGER NOT NULL DEFAULT 0,
    mailbox    TEXT NOT NULL,         -- canonical name (e.g. 'Sent', not 'sent')
    createdAt  INTEGER DEFAULT (unixepoch()),
    updatedAt  INTEGER DEFAULT (unixepoch())
);
```

Changes from current:
- `+ filename` — stores full Maildir filename for sync / rename detection
- `+ isReplied` — `\Answered` / `R` flag
- `~ isStarred → isFlagged` — matches IMAP `\Flagged`
- `- _isParsed` — unused, remove
- `~ mailbox` stores canonical case (not lowered)

Since data is throwaway during dev, just replace the schema. No migration needed.

---

## 12. Summary of Changes by File

### `apps/api/src/lib/mail/mailutils.ts`

| Function | Change |
|----------|--------|
| `createUniqueMessageId()` | Generate `{time}.M{usec}P{pid}Q{seq}.{hostname}` |
| `getMailIDfromFileName()` | Extract unique part before `,` and `:` (not `.eml`) |
| `getStandardMailboxFlags()` | Handle `Junk` instead of `Spam` |
| **new** `buildMaildirFilename()` | Build `{unique},S={size}:2,{FLAGS}` |
| **new** `parseFlagsFromFilename()` | Extract flags from `:2,{FLAGS}` suffix (`[A-Za-z]`) |
| **new** `rebuildFlagsSuffix()` | Update standard flags while preserving keyword flags |
| **new** `applyFlagsFromFilename()` | Apply parsed flags to an EmailSummary |

### `apps/api/src/lib/mail/maildir.ts`

| Method | Change |
|--------|--------|
| `createMailboxes()` | Capitalize names, `Spam` → `Junk`, add `maildirfolder`, write `subscriptions` |
| `sanitizeDirName()` | Stop lowercasing, handle INBOX as root |
| `getFullPath()` | Use `filename` column instead of `{id}.eml` |
| `mailboxDeliver()` | Write to `tmp/` first, `rename()` to `new/`, include `,S=`, accept target mailbox |
| `mailboxGet()` | Call `syncMailbox()` then return from DB |
| `mailboxesList()` | Filter to `STANDARD_MAILBOXES` only |
| `messageMove()` | Rename source `cur/` → target `new/` (strip flags), sync target |
| `messageCopy()` | Read content, deliver to target with new unique ID |
| `messageHandleDraft()` | Use `mailboxDeliver()` to Drafts, then set `DS` flags via rename |
| `messageSetRead()` | Rename file to update `S` flag, preserve keyword flags |
| `messageDelete()` | Delete file and DB record (no change) |
| `parseMessage()` | Accept filename parameter, look up from DB/disk |
| **new** `syncMailbox()` | Full scan-based sync (new/ → cur/, new files, flag changes, deletions) |
| **new** `syncAllMailboxes()` | Sync standard 6 + discover extra IMAP-created folders |
| **new** `findFileByUniqueId()` | Scan `cur/` to find file matching a message ID |
| **remove** `processNestedMailboxes()` | No longer needed (fixed mailbox set) |

### `apps/api/src/lib/mail/maildb.ts`

| Method | Change |
|--------|--------|
| `addEmail()` | Include `filename`, `isReplied`, `isFlagged` |
| `moveEmail()` | Remove (moves go through delete + re-sync) |
| **new** `updateFlags()` | Update flag columns + filename from sync |
| **new** `setFilename()` | Update filename after flag-change rename |
| `setRead()` | Keep (also updates filename via `messageSetRead`) |
| `~ setStarred()` → `setFlagged()` | Rename to match IMAP semantics |

### `apps/api/src/lib/mail/schema.ts`

Add `filename`, `isReplied`, rename `isStarred` → `isFlagged`, remove `_isParsed`.

### `apps/api/src/lib/mail/mailfile.ts`

No changes needed. EML content generation is independent of Maildir format.

### `packages/lib/src/types/mail.ts`

- `EmailSummary`: add `filename`, `isReplied`, rename `isStarred` → `isFlagged`
- Frontend can map `isFlagged` → "starred" in the UI

### `packages/lib/src/core/mail/hooks/use-emails.ts`

- Update `isStarred` references → `isFlagged`
- Add `useToggleFlaggedEmail()` if not already present

### Frontend (`apps/mail/`)

- Rename all `isStarred` → `isFlagged` in components
- Handle `Junk` mailbox name instead of `Spam`
- Star icon continues to work — just maps to `isFlagged`

---

## 13. Dovecot Configuration (Reference)

Recommended Dovecot config for use with Eigen's Maildir layout:

```
# Mail location — one Maildir per user
mail_location = maildir:~/Maildir

# Namespace with special-use mailboxes
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
        auto = no
        special_use = \Archive
    }
}

# External writes expected — always re-scan, don't assume exclusive access
maildir_very_dirty_syncs = no
```

The `~/Maildir` path maps to `data/home/{userId}/eigen.mail/Maildir` in Eigen's data layout.

---

## 14. Implementation Order

1. **Filename format** — `createUniqueMessageId()`, `getMailIDfromFileName()`, `buildMaildirFilename()`,
   `parseFlagsFromFilename()`, `rebuildFlagsSuffix()`. Foundation for everything else.
2. **Schema update** — Add `filename`, `isReplied`, rename `isStarred` → `isFlagged`, remove `_isParsed`.
3. **Delivery flow** — `tmp/` → `new/` with `,S=` size hint, no extension, accept target mailbox.
4. **Mailbox names** — Capitalize, `Spam` → `Junk`, add `maildirfolder` markers, write `subscriptions`.
5. **`syncMailbox()`** — The core sync engine: `new/` → `cur/` (with ENOENT handling), new files, flag changes,
   deletions.
6. **Flag writes** — `messageSetRead()` renames file, preserves keyword flags.
7. **Move/Copy** — Move via rename to target `new/` (no content read). Copy via `mailboxDeliver()`.
8. **Draft handling** — Standard delivery to Drafts + `DS` flag rename.
9. **Folder policy** — Filter `mailboxesList()` to standard 6, remove `processNestedMailboxes()`,
   add `syncAllMailboxes()` for extra-folder discovery.
10. **Frontend** — `isStarred` → `isFlagged`, `Spam` → `Junk`.
11. **Remove `.attributes`** — No longer needed with Dovecot managing special-use.
12. **Filesystem watcher** — Watch `cur/` and `new/` for real-time sync with debounce.
