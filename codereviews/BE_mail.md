# Backend Code Review: Mail (Maildir, IMAP)

## Summary

The mail backend is a well-structured Maildir++ implementation split across focused modules: `Maildir` (orchestrator),
`MaildirStore` (filesystem), `MailDB` (database), `mailutils` (filename/flag helpers), `mail-parse` (EML parsing),
`mailfile` (EML generation), `sender` (SMTP), and `mail.ts` (facade). The IMAP compatibility plan from `docs/IMAP.md`
has been fully implemented: Maildir-compliant filenames, flag storage in filenames, atomic delivery via `tmp/`,
`syncMailbox()` with full disk/DB reconciliation, `fs.watch()` for live detection, and Dovecot keyword preservation.

The code is generally clean and follows the project architecture patterns well. The split between store/db/orchestrator
is logical and testable. However, several issues were found ranging from a security gap to concurrency concerns and
minor correctness bugs.

## Architecture Compliance

| Rule | Compliance | Notes |
|------|-----------|-------|
| Domain class in `lib/mail/maildir.ts` | Pass | Follows `lib/[domain]/[domain].ts` pattern |
| Routes in `routes/mail.ts` | Pass | Thin router, delegates to facade |
| Schema in `schema.ts` + `db-config.ts` | Pass | Drizzle schema + versioned migration |
| SSE events in `sse-events.ts` | Pass | Uses `buildMailEvent()` with notification templates |
| Shared types in `packages/lib/src/types/mail.ts` | Pass | `EmailSummary`, `Email`, `MaildirMailbox` |
| Facade pattern in `mail.ts` | Pass | User -> Home -> Maildir resolution |
| No JSDoc | Pass | |
| `type` over `interface` | Pass | All local types use `type` |
| English everywhere | Pass | |

## Issues Found

### Critical

**1. ownerId parameter is ignored -- no authorization check**
- **File**: `apps/api/src/routes/mail.ts`, lines 30-132
- **File**: `apps/api/src/lib/mail/mail.ts`, lines 7-10

All authenticated routes include `:ownerId` in the URL path but never use `params.ownerId`. Every handler passes `user`
(from the session) directly to the facade, which resolves `Home` from `user.id`. This means the `ownerId` URL
parameter is cosmetic and ignored.

While this means a user cannot access another user's mail (the session user is always used), it creates a misleading
API contract. The existing test at line 327-340 of `mail.test.ts` proves this: Bob can call
`POST /mail/${alice.id}/mailbox` with his own session token and it succeeds -- but the mailbox is created in Bob's
account, not Alice's. The test title says "ownerId spoofing does not let Bob write mailboxes into Alice account" but the
test actually shows the API silently ignores the spoofed ownerId and operates on the authenticated user's data, which
is correct behavior but the API design is misleading.

This is not a data leak, but the `ownerId` parameter should either be validated (reject if `ownerId !== user.id`) or
removed from mail routes entirely to avoid confusion and prevent future regressions if someone starts using it.

**2. Public delivery endpoint has no authentication or rate limiting**
- **File**: `apps/api/src/routes/mail.ts`, line 28
- **File**: `apps/api/src/lib/mail/mail.ts`, lines 32-39

`POST /mail/deliver/:to` accepts arbitrary EML content from unauthenticated callers. There is no rate limiting, no
size limit, no sender validation, and no spam filtering. An attacker could:
- Flood any user's mailbox with arbitrary messages
- Deliver messages with spoofed `From:` headers
- Exhaust disk space (no quota check on delivery)

The endpoint decodes the entire body as UTF-8 text (`new TextDecoder().decode(new Uint8Array(file))`) which could also
fail for binary-heavy MIME messages with non-UTF-8 encoded parts.

### Important

**3. `readMessage` returns stale size from `file()` constructor**
- **File**: `apps/api/src/lib/mail/maildir-store.ts`, lines 100-104
- **File**: `apps/api/src/lib/core/local-filesystem.ts`, line 153

```typescript
async readMessage(mailbox: string, filename: string): Promise<{content: string, size: number}> {
    const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
    const file = this.storage.file(filePath)
    return {content: await file.text(), size: file.size}
}
```

`this.storage.file(filePath)` captures `bunFile.size` at object creation time (line 153 of `local-filesystem.ts`:
`size: bunFile.size`). BunFile's `.size` is evaluated when the BunFile is created. If the file does not yet exist or
was just written, `.size` could be 0 or stale. This is mainly a risk during sync when reading newly delivered messages.
The size should be computed from the content length: `Buffer.byteLength(content, 'utf-8')`.

**4. `syncMailbox` race condition: concurrent callers get coalesced but late arrivals miss changes**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 297-308

```typescript
async syncMailbox(mailbox: string): Promise<void> {
    const running = this.syncingMailboxes.get(mailbox)
    if (running) return running  // <-- returns the same promise
    ...
}
```

The concurrency guard uses a `Map<string, Promise<void>>` and returns the running promise to concurrent callers. This
is an improvement over the `Set`-based skip pattern in the IMAP doc. However, if a filesystem change occurs _during_ a
sync, the watcher callback will join the in-progress sync (which won't see the new change), and the change won't
trigger another sync because `fs.watch` may have already fired. The result is a missed change that requires the next
API request or the next `fs.watch` event to be picked up.

Consider queuing a re-sync when a request arrives while a sync is already running, so the sync happens again after
the current one completes.

**5. EML generation uses a hardcoded, non-unique MIME boundary**
- **File**: `apps/api/src/lib/mail/mailfile.ts`, line 35

```typescript
`Content-Type: multipart/alternative; boundary="boundary-string"`
```

All generated EML messages use the literal string `"boundary-string"` as the MIME boundary. If the email body text
itself contains the string `--boundary-string`, it will be misinterpreted as a MIME boundary by any mail parser,
corrupting the message. RFC 2046 requires the boundary to be chosen such that it does not appear in the body.

Generate a unique boundary per message, e.g., `boundary_${crypto.randomUUID()}`.

**6. EML generation always emits empty BCC header**
- **File**: `apps/api/src/lib/mail/mailfile.ts`, lines 26-36

```typescript
const headers = [
    `From: ${formatAddresses(input.from)}`,
    `To: ${formatAddresses(input.to)}`,
    `CC: ${formatAddresses(input.cc)}`,
    `BCC: ${formatAddresses(input.bcc)}`,
    ...
]
```

Headers are always emitted, even when empty. This produces `BCC: ` and `CC: ` headers with empty values. More
importantly, BCC headers should _never_ appear in the stored/sent message -- BCC recipients are supposed to be
invisible to other recipients. A stored EML with a `BCC:` header leaks the BCC list if the file is accessed
externally (e.g., via Dovecot IMAP).

Only emit headers when they have values, and always strip BCC from stored content.

**7. `messageGet` swallows all errors silently**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 97-113

```typescript
async messageGet(messageId: string): Promise<Email | null> {
    try {
        ...
    } catch {
        return null
    }
}
```

The entire method is wrapped in a bare `catch` that returns `null`. Any error -- DB corruption, filesystem
permission issues, parsing bugs -- is silently converted to "message not found". This makes debugging extremely
difficult. At minimum, log the error. Better: only catch expected errors (ENOENT) and let others propagate.

**8. `messageDelete` has DB/filesystem inconsistency window**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 134-146

```typescript
this.db.deleteEmail(messageId)
await this.store.deleteMessage(email.mailbox, email.filename)
```

The DB record is deleted first (synchronous), then the file is deleted (async). If the file deletion fails (e.g.,
permission error, file already gone), the DB record is already removed but the file remains on disk. This orphaned
file will be re-discovered on the next sync and re-inserted into the DB. The SSE delete event was already emitted.

Reverse the order: delete the file first, then the DB record. Or handle the file deletion error by re-inserting the
DB record.

**9. `messageSetRead` / `messageSetFlagged` -- DB update happens even if rename fails**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 183-207

```typescript
async messageSetRead(messageId: string, read: boolean): Promise<void> {
    await this.renameFlag(messageId, {seen: read}, SSEventType.MAIL_READ_CHANGED)
    this.db.setRead(messageId, read)
}
```

Inside `renameFlag`, if `this.store.renameInCur()` throws, the exception propagates to the caller. But in
`messageSetRead`/`messageSetFlagged`, the DB update (`this.db.setRead` / `this.db.setFlagged`) is a separate call
after `renameFlag`. If `renameFlag` succeeds (including the `this.db.setFilename` inside it) but then the outer
`this.db.setRead` fails, the filename is updated in DB but the read flag is not. These should be in a single
transaction or the flag update should be inside `renameFlag`.

Actually, looking more carefully: `renameFlag` already calls `this.db.setFilename(messageId, newFilename)` at
line 203. Then `messageSetRead` calls `this.db.setRead(messageId, read)` at line 185. This is two separate DB writes
for what should be one atomic update. If the process crashes between them, the filename is updated but the flag is not.
Consolidate into a single DB update.

### Minor

**10. `createUniqueMessageId` has a microsecond-precision collision window**
- **File**: `apps/api/src/lib/mail/mailutils.ts`, lines 18-25

```typescript
const time = Math.floor(Date.now() / 1000)
const usec = (Date.now() % 1000) * 1000
```

Two calls to `Date.now()` are made, which could return different milliseconds, making the seconds and microseconds
components inconsistent (e.g., time=1000, usec from 999ms of the previous second). Capture `Date.now()` once:

```typescript
const now = Date.now()
const time = Math.floor(now / 1000)
const usec = (now % 1000) * 1000
```

**11. `canonicalMailbox` does not normalize custom folder names**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 21-24

```typescript
function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return ''
    return STANDARD_MAILBOXES.find(m => m.toLowerCase() === name.toLowerCase()) ?? name
}
```

For custom mailboxes (not in `STANDARD_MAILBOXES`), the input is returned as-is. If someone creates mailbox `Projects`
and later requests `projects`, the lookup is case-sensitive at the filesystem/DB level and will fail. This is
acceptable given the "fixed 6 mailboxes" design, but worth noting.

**12. `dirSize` fallback to DB size is misleading**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 52-54

```typescript
async size(): Promise<number> {
    return (await this.store.dirSize()) || this.db.size()
}
```

If `dirSize()` returns 0 (empty mailbox), the fallback `this.db.size()` is used, which sums the `size` column in the
DB. These measure different things -- `dirSize` is the actual disk usage (includes tmp files, DB files, etc.) while
`db.size()` is the sum of message sizes. The `||` operator treats 0 as falsy, so an empty Maildir falls through to
the DB sum. Use `??` instead of `||` and consider which metric is actually desired.

**13. `textShort` in DB stores full plaintext body**
- **File**: `apps/api/src/lib/mail/mail-parse.ts`, line 27

```typescript
textShort: parsedMail.text || '',
```

The field is named `textShort` but stores the entire plaintext body. For large emails, this means the full body is
duplicated in SQLite. Consider truncating to a reasonable preview length (e.g., 200 characters).

**14. `welcome.ts` uses hardcoded Exchange-style headers**
- **File**: `apps/api/src/lib/mail/welcome.ts`, lines 4-17

The welcome email template includes Exchange-specific headers (`Thread-Topic`, `Thread-Index`) and a hardcoded
`Message-ID` referencing `DU0PR01MB9407...eurprd01.prod.exchangelabs.com`. This is clearly copied from a real email
and should be cleaned up. The `Message-ID` should be generated dynamically, and Exchange-specific headers should be
removed.

**15. `sendMail` creates a new transport on every call**
- **File**: `apps/api/src/lib/mail/sender.ts`, lines 20-26, 51-52

```typescript
function createTransport(): Mail {
    return nodemailer.createTransport({ sendmail: true, ... });
}

export async function sendMail(options: SendMailOptions): Promise<boolean> {
    const transporter = createTransport();
    ...
}
```

A new nodemailer transport is created for every outgoing email. While `sendmail` transport is lightweight (spawns a
process), this prevents connection pooling if SMTP transport is used in the future. Consider caching the transport.

**16. `messageSend` returns `null` on error, losing error context**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 261-293

```typescript
} catch (error) {
    console.error('Error sending email:', error)
    return null
}
```

When sending fails, the draft has already been saved (line 262: `messageHandleDraft`), and the function returns `null`.
The caller (route) has no way to distinguish "send failed" from "send succeeded but returned null for some reason".
This should throw an `ApiError(502, ...)` so the client sees a proper error.

**17. Draft `id` and `EmailDraft` type handling**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 211-259

```typescript
const isNew = (email.id || '').trim() === ''
```

The `EmailDraft` type extends `Email` which has `id: string` (non-optional). Checking `email.id || ''` is defensive
but suggests the type is not accurate -- `id` should be `string | undefined` on `DraftInput` or the caller should
explicitly pass an empty string. The `DraftInput` type in `types/mail.ts` does not include `id`, so the route passes
`t.Any()` for the body, losing all type safety on the draft endpoint.

**18. `mailboxesList` only returns standard mailboxes that exist on disk**
- **File**: `apps/api/src/lib/mail/maildir.ts`, lines 58-66

The method checks `this.store.mailboxDirExists(name)` for each standard mailbox. If a standard mailbox directory
gets accidentally deleted (e.g., by external tool), it silently disappears from the list with no error. Consider
auto-recreating missing standard mailboxes during the list operation.

## Robustness

**Filesystem error handling**: Generally good. `moveNewToCur` catches ENOENT (line 88-89 of `maildir-store.ts`).
`syncMailbox` catches parse errors per-message (line 340-341 of `maildir.ts`). `deleteMessage` checks existence
before unlink. However, `readMessage` has no error handling, and `moveMessage` will throw on ENOENT without recovery.

**Database consistency**: SQLite with WAL mode provides good read concurrency. The `addEmail` method in `maildb.ts`
(lines 24-53) does an existence check then insert/update -- this is two queries when an `INSERT OR REPLACE` would
be atomic and faster.

**Process crash recovery**: If the process crashes during `deliverAtomic`, a partial file may remain in `tmp/`. The
IMAP doc mentions a `cleanStaleTmp()` method for files older than 36 hours, but this is not implemented. Stale
`tmp/` files are harmless but accumulate.

**Memory**: Full EML content is loaded into memory for parsing (`readMessage` returns string). For very large
attachments, this could be problematic. The mail-parser supports streaming but `simpleParser` is used with string
input.

## Test Coverage

**`mail.test.ts`** (343 lines): Good coverage of CRUD operations, draft lifecycle, cross-mailbox moves, error
cases (404s, 409s), and cross-user isolation. Tests use the actual HTTP API via `authedRequest`.

**`mail-imap.test.ts`** (583 lines): Excellent Maildir-specific coverage including:
- Maildir filename format validation
- Utility function unit tests (all helpers tested)
- Draft delivery with correct flags
- Flag rename operations (read, flagged)
- Simulated Dovecot scenarios (new file in cur/, new file in new/, flag rename, expunge, cross-mailbox move)
- Dovecot keyword preservation
- Case-insensitive mailbox lookup
- Move preserving flags
- Copy creating independent message
- Atomic delivery verification

**Missing test scenarios**:
- Concurrent sync operations (two syncs on the same mailbox)
- Large message handling (attachment-heavy)
- Malformed EML parsing (corrupted headers, missing fields)
- `messageGetAttachment` with invalid index (negative, out of range)
- `messageSend` in dev mode vs production mode
- `mailboxDeliver` with non-UTF-8 content
- Public delivery endpoint abuse (large body, binary content)
- Watcher-triggered sync (fs.watch callbacks)
- Draft update (saving over existing draft by ID)
- `size()` method accuracy
- Label operations (the `emailLabels` and `emailsToLabels` tables exist in schema but no code uses them)

## Recommendations

1. **Validate or remove `ownerId`** from mail routes. Either enforce `ownerId === user.id` or drop the parameter. The
   current state is a bug waiting to happen if someone starts using `params.ownerId` instead of `user`.

2. **Secure the delivery endpoint**. Add rate limiting, size limits, and consider requiring a shared secret or
   restricting to localhost. Add quota enforcement via `enforceFileUpload` or similar.

3. **Fix the EML boundary** to be unique per message. This is a correctness bug that will eventually corrupt a message.

4. **Strip BCC headers** from stored EML content. This is a privacy issue.

5. **Reverse delete order** in `messageDelete`: delete file first, then DB record.

6. **Consolidate flag updates** in `renameFlag` to include the flag boolean alongside the filename update in a single
   DB write.

7. **Implement `cleanStaleTmp()`** to clean up partial deliveries older than 36 hours, as planned in the IMAP doc.

8. **Truncate `textShort`** to a reasonable length (e.g., 200 chars) to avoid storing multi-MB plaintext bodies in the
   DB summary table.

9. **Add type safety to draft/send routes**. Replace `t.Any()` with a proper Elysia type definition for the draft
   body to get compile-time and runtime validation.

10. **Implement the label system** or remove the unused `emailLabels`/`emailsToLabels` tables from the schema. Dead
    schema is confusing.
