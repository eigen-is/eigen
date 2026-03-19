# Backend Mail Domain — Code Review

Reviewed: `apps/api/src/lib/mail/`, `apps/api/src/routes/mail.ts`, `apps/api/src/test/mail*.test.ts`

---

## Architecture Overview

The mail backend implements a Maildir++-compatible email system with six modules:

| Module               | File               | Responsibility                                                      |
|----------------------|--------------------|---------------------------------------------------------------------|
| **Maildir**          | `maildir.ts`       | Orchestrator: ties together store, DB, parser, SSE                  |
| **MaildirStore**     | `maildir-store.ts` | Filesystem operations on the Maildir structure                      |
| **MailDB**           | `maildb.ts`        | SQLite metadata cache (CRUD on `emails` table)                      |
| **parseEml**         | `mail-parse.ts`    | EML parsing via bundled mailparser, HTML sanitization via DOMPurify |
| **createEmlContent** | `mailfile.ts`      | EML generation from draft data                                      |
| **sender**           | `sender.ts`        | SMTP sending via nodemailer/sendmail                                |
| **Facade**           | `mail.ts`          | Thin `User -> Maildir` resolution layer for routes                  |

### Data flow

1. **Incoming mail**: `/mail/deliver/:to` (unauthenticated) -> `mailboxDeliver()` -> `MaildirStore.deliverAtomic()` (
   tmp -> new) -> `syncMailbox()` (new -> cur, parse, DB insert, SSE emit).
2. **Reading**: `mailboxGet()` -> `syncMailbox()` -> `MailDB.getAllEmails()`. Individual message: `messageGet()` -> DB
   lookup -> `readAndParse()` from cur/.
3. **Draft**: `messageHandleDraft()` -> `createEmlContent()` -> `MaildirStore.deliverToCur()` (tmp -> cur with D+S
   flags) -> parse -> DB insert.
4. **Send**: `messageSend()` -> `messageHandleDraft()` -> `draftToMailOptions()` -> nodemailer sendmail (or dev-mode
   log) -> `messageMove()` to Sent.
5. **Flags**: `messageSetRead()` / `messageSetFlagged()` -> rename file in cur/ via `rebuildFlagsSuffix()` -> DB
   update -> SSE emit.
6. **Sync**: `syncMailbox()` reconciles disk vs DB: moves new/ -> cur/, detects new files, flag renames, and deletions,
   emitting SSE for each change.

### Maildir filename format

```
{time}.M{usec}P{pid}Q{seq}.{hostname},S={size}:2,{FLAGS}
```

Flags: `D`(Draft), `F`(Flagged), `P`(Forwarded), `R`(Replied), `S`(Seen), `T`(Trashed). Dovecot lowercase keyword flags
are preserved during renames via `rebuildFlagsSuffix()`.

---

## Issues

### Critical

#### C1. The `/mail/deliver/:to` endpoint is unauthenticated and has no rate limiting or sender validation

**File**: `apps/api/src/routes/mail.ts`, line 28

```typescript
.post("/mail/deliver/:to", async ({params, body}) => await mailboxDeliver(params.to, body as ArrayBuffer), {
    parse: 'arrayBuffer',
    body: t.Any({maxLength: 25 * 1024 * 1024}),
})
```

This endpoint accepts arbitrary EML content from any caller without authentication. While it is intended for SMTP relay,
it currently:

- Has no IP allowlist or shared-secret authentication
- Has no rate limiting (an attacker can flood any user's mailbox)
- Has no sender verification (anyone can forge any From: address)
- Accepts up to 25 MB per request with no aggregate quota check

**Why it matters**: In a production deployment, this is a spam and abuse vector. Any HTTP client can deliver arbitrary
messages to any user.

**Suggested fix**: Add at least one of: (a) an `X-Delivery-Secret` header check against a configured secret, (b) an IP
allowlist for the local SMTP relay, or (c) rate limiting per recipient. For now, document that this endpoint must be
firewalled from external access.

---

#### C2. The `ownerId` path parameter is accepted but never validated in mail routes

**File**: `apps/api/src/routes/mail.ts`, lines 33-133

Every authenticated mail route includes `:ownerId` in the URL path (e.g., `/mail/:ownerId/mailboxes`) but the parameter
is never read or validated. All routes pass `user` from the session directly to the facade:

```typescript
.get("/mail/:ownerId/mailboxes", async ({user}) => await mailboxesList(user), {auth: true})
```

The facade (`mail.ts`) resolves the Maildir from `user.id`, completely ignoring the URL's `ownerId`. Per CLAUDE.md: "
Every authenticated route must include `:ownerId` as the second path segment" and "Routes must validate that the caller
has access to the specified ownerId."

**Why it matters**: The cross-user isolation test (`mail.test.ts` line 326-339) reveals the consequence: Bob can POST to
Alice's ownerId URL and the request succeeds (status 200) because the route ignores ownerId and operates on Bob's own
Home. The test comments this away as "mailboxesList only returns standard mailboxes" but the underlying issue is that
the route should reject mismatched ownerId with 403. This also blocks future team-mail support where ownerId would
select a team Home.

**Suggested fix**: Validate `params.ownerId === user.id` at the top of each route handler (or in a shared guard). Return
403 for mismatched ownerId.

---

#### C3. `readMessage()` returns stale `file.size` from `Bun.file()` creation time, not from `text()` read time

**File**: `apps/api/src/lib/mail/maildir-store.ts`, lines 100-104

```typescript
async readMessage(mailbox: string, filename: string): Promise<{content: string, size: number}> {
    const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
    const file = this.storage.file(filePath)
    return {content: await file.text(), size: file.size}
}
```

`LocalFilesystem.file()` (local-filesystem.ts line 149-166) captures `bunFile.size` at object creation time as a plain
property (`size: bunFile.size`). If the file is modified between the `file()` call and the `text()` call, the size is
wrong. More practically, `BunFile.size` may return 0 for a file that was just written and not yet flushed. The parsed
email's `size` field in the DB could be 0 or stale.

**Why it matters**: Incorrect sizes propagate to the DB and are shown in the UI. The `,S=` hint in Maildir filenames is
the authoritative size; using `file.size` as a secondary source can conflict.

**Suggested fix**: Compute size from the content after reading:
`const content = await file.text(); return {content, size: Buffer.byteLength(content, 'utf-8')}`. Or use the size hint
from the filename.

---

### Important

#### I1. `messageSend()` silently returns `null` on SMTP failure, losing the draft

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 261-293

```typescript
async messageSend(mailToSend: EmailDraft): Promise<EmailDraft | null> {
    const mail = await this.messageHandleDraft(mailToSend)
    try {
        // ...
        if (sent) {
            await this.messageMove(mail.id, 'Sent')
            // ...
        }
    } catch (error) {
        console.error('Error sending email:', error)
        return null
    }
    return mail
}
```

When sending fails (both in production and dev mode if `draftToMailOptions` throws), the method returns `null`. But
`messageHandleDraft()` has already deleted the old draft (if updating) and created a new one. The caller in `mail.ts`
returns `null` to the route, which the frontend may interpret as success (no error status code is set).

**Why it matters**: The user thinks the email was sent (no error feedback) but it was not. The draft remains in Drafts
with a new ID, potentially confusing.

**Suggested fix**: On send failure, either (a) throw an `ApiError(500, 'Failed to send email')` so the frontend gets
error feedback, or (b) keep the draft in Drafts (it already is) but return it with a clear `sent: false` indicator.

---

#### I2. `sendMail()` swallows the SMTP error and returns `false`

**File**: `apps/api/src/lib/mail/sender.ts`, lines 51-78

```typescript
export async function sendMail(options: SendMailOptions): Promise<boolean> {
    // ...
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
}
```

The SMTP error (which may contain useful information like "relay access denied" or "mailbox full") is caught, logged to
console, and replaced with `false`. The caller in `messageSend()` checks `if (sent)` but cannot report the specific
error to the user.

**Why it matters**: Per CLAUDE.md: "Every mutation needs error feedback." SMTP errors should propagate to the user.

**Suggested fix**: Let the error propagate (remove the try/catch) or re-throw with a meaningful message.

---

#### I3. `createEmlContent()` does not encode non-ASCII headers (Subject, From name)

**File**: `apps/api/src/lib/mail/mailfile.ts`, lines 23-55

```typescript
const headers = [
    `From: ${formatAddresses(input.from)}`,
    `To: ${formatAddresses(input.to)}`,
    `CC: ${formatAddresses(input.cc)}`,
    `Subject: ${input.subject || ''}`,
    // ...
]
```

RFC 5322 requires that non-ASCII characters in headers be encoded using RFC 2047 (e.g., `=?UTF-8?B?...?=` or
`=?UTF-8?Q?...?=`). The current code writes raw UTF-8 into headers. This works for Eigen's own parser (which is lenient)
but will break when:

- Dovecot indexes the message (may misparse non-ASCII subjects)
- An IMAP client reads the message
- The EML is forwarded to an external recipient

**Why it matters**: Emails with non-English subjects or sender names will be garbled when accessed via IMAP or external
mail clients.

**Suggested fix**: Use RFC 2047 encoding for Subject, From name, To name, and CC name fields when they contain non-ASCII
characters. nodemailer's `mimelib` or a simple Base64 encoding helper would suffice.

---

#### I4. `createEmlContent()` always emits empty CC headers and missing Content-Transfer-Encoding

**File**: `apps/api/src/lib/mail/mailfile.ts`, lines 28-37

```typescript
const headers = [
    `From: ${formatAddresses(input.from)}`,
    `To: ${formatAddresses(input.to)}`,
    `CC: ${formatAddresses(input.cc)}`,   // emits "CC: " even when cc is undefined
    `Subject: ${input.subject || ''}`,
    // ...
]
```

When `input.cc` is undefined, `formatAddresses()` returns `''`, producing `CC: ` (empty header). Some mail servers and
parsers treat empty CC headers as malformed.

Additionally, the multipart body parts have `Content-Type` but no `Content-Transfer-Encoding` header. For 8-bit UTF-8
content, this should be `8bit` or `quoted-printable`. Without it, some MTAs may reject or mangle the content.

**Suggested fix**: Only include CC/BCC headers when they have values. Add `Content-Transfer-Encoding: 8bit` to each MIME
part.

---

#### I5. `messageGet()` silently swallows all exceptions

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 97-113

```typescript
async messageGet(messageId: string): Promise<Email | null> {
    try {
        const cached = this.db.getEmail(messageId)
        if (!cached) return null
        const parsed = await this.readAndParse(messageId, cached.mailbox, cached.filename)
        if (!parsed) return null
        // ...
        return {...parsed, ...cached} as Email
    } catch {
        return null
    }
}
```

The bare `catch` block converts all errors (disk I/O failures, database corruption, parsing bugs) into `null`, which the
route layer converts to a 404. This hides real errors and makes debugging difficult.

**Why it matters**: A corrupted database or filesystem permission error appears as "message not found" to the user, with
no server-side diagnostic beyond console warnings.

**Suggested fix**: Only catch expected errors (like ENOENT). Let unexpected errors propagate as 500s.

---

#### I6. `messageHandleDraft()` uses non-atomic delete-then-create for draft updates

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 210-258

When updating an existing draft:

1. Delete old file from disk (line 219)
2. Delete old record from DB (line 220)
3. Create new EML content (line 230)
4. Deliver to cur/ (line 242)
5. Parse and insert into DB (line 250)

If the process crashes between steps 2 and 4, the draft is lost. The old draft has been deleted from both disk and DB,
and the new one hasn't been written yet.

**Why it matters**: Draft loss during save is a data loss scenario for the user.

**Suggested fix**: Write the new draft first, then delete the old one. This way, a crash leaves the old draft intact.

---

#### I7. `sendMail()` creates a new transport on every call

**File**: `apps/api/src/lib/mail/sender.ts`, lines 20-26

```typescript
function createTransport(): Mail {
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail'
    });
}

export async function sendMail(options: SendMailOptions): Promise<boolean> {
    const transporter = createTransport();
    // ...
}
```

A new transport is created for every send operation. For the `sendmail` transport this spawns a new process each time,
which is acceptable but wasteful. If switched to SMTP transport later, this would create a new TCP connection per
message instead of reusing a connection pool.

**Suggested fix**: Create the transport once at module level or use a singleton pattern.

---

#### I8. The `size()` method on `Maildir` has incorrect fallback logic

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 52-54

```typescript
async size(): Promise<number> {
    return (await this.store.dirSize()) || this.db.size()
}
```

The `||` operator means: if `dirSize()` returns `0` (empty maildir with no messages), it falls through to
`this.db.size()`. But a maildir with no messages legitimately has size 0. The DB `size()` sums the `size` column from
`emails`, which could return a non-zero value from stale DB records, giving a wrong answer. Conversely, if `dirSize()`
succeeds with a positive value, the DB sum is never consulted -- which is the correct behavior.

**Suggested fix**: Use `??` instead of `||`, or always prefer `dirSize()` with DB as fallback only when `dirSize()`
returns `null`/`undefined`: `return (await this.store.dirSize()) ?? this.db.size()`.

---

#### I9. Sync concurrency guard uses a Map of Promises but does not coalesce waiters correctly

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 297-308

```typescript
async syncMailbox(mailbox: string): Promise<void> {
    const running = this.syncingMailboxes.get(mailbox)
    if (running) return running

    const promise = this.doSyncMailbox(mailbox)
    this.syncingMailboxes.set(mailbox, promise)
    try {
        await promise
    } finally {
        this.syncingMailboxes.delete(mailbox)
    }
}
```

When a sync is already running, `return running` causes the second caller to await the same promise. This is correct for
deduplication. However, there is a race window: after `syncingMailboxes.delete(mailbox)` in the `finally` block but
before the caller of `return running` has finished processing its result, a third call could start a new sync that
overlaps with the second caller's continuation. This is minor but worth noting.

More importantly, if `doSyncMailbox()` throws, the error propagates to all awaiters (both the original and any that
joined via `return running`). This is fine but means transient errors (e.g., a file locked by Dovecot) will fail all
concurrent requests for that mailbox.

---

### Minor

#### M1. `mailboxDir()` validation allows spaces and hyphens but not all RFC-valid characters

**File**: `apps/api/src/lib/mail/maildir-store.ts`, lines 163-169

```typescript
mailboxDir(mailbox: string): string {
    if (mailbox === '' || mailbox === 'INBOX') return this.basePath
    if (/[^a-zA-Z0-9._\- /]/.test(mailbox) || mailbox.includes('..')) {
        throw new Error(`Invalid mailbox name: ${mailbox}`)
    }
    return `${this.basePath}/.${mailbox.replace('/', '.')}`
}
```

The regex allows spaces and forward slashes in mailbox names, which could create directories with spaces. The forward
slash is converted to `.` (Maildir++ convention), but spaces in directory names are unusual for Maildir. Also, the error
thrown is a plain `Error`, not an `ApiError`, so it returns as a 500 instead of a 400.

**Suggested fix**: Use `ApiError(400, ...)` and consider restricting to `[a-zA-Z0-9._-]` (no spaces or slashes).

---

#### M2. `canonicalMailbox()` only handles case-insensitive matching for standard mailboxes

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 21-24

```typescript
function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return ''
    return STANDARD_MAILBOXES.find(m => m.toLowerCase() === name.toLowerCase()) ?? name
}
```

This is good for normalizing `sent` -> `Sent`, but for custom mailbox names, it passes through unchanged. If a user
creates a custom mailbox `Projects` and later requests `projects`, it won't be found. This is consistent behavior (
custom mailboxes are case-sensitive) but could confuse users.

---

#### M3. `welcome.ts` contains a hardcoded personal sender name and an embedded base64 GIF

**File**: `apps/api/src/lib/mail/welcome.ts`, lines 1-99+

The welcome email has `From: Reinder Nijhoff <reinder@${getDomain()}>` with a hardcoded personal name and an embedded
nyan.gif as a base64-encoded inline attachment. For a self-hosted product, the welcome sender should be configurable (
e.g., "Eigen" or the admin's name), and the embedded image adds significant code size to the source file.

---

#### M4. `maildb.ts` `addEmail()` uses SELECT + INSERT/UPDATE instead of UPSERT

**File**: `apps/api/src/lib/mail/maildb.ts`, lines 24-53

```typescript
addEmail(email: EmailSummary) {
    // ...
    const existing = this.db.select().from(schema.emails).where(eq(schema.emails.id, record.id)).get()
    if (existing) {
        const {id, ...rest} = record
        this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id)).run()
    } else {
        this.db.insert(schema.emails).values(record).run()
    }
}
```

This pattern is a non-atomic read-then-write. In SQLite with WAL mode and a single writer, this is safe, but it is two
statements where one would do. Drizzle supports `onConflictDoUpdate()` which is cleaner and marginally faster.

**Suggested fix**: Use `INSERT ... ON CONFLICT(id) DO UPDATE`.

---

#### M5. `parseEml()` collapses all whitespace in HTML bodies

**File**: `apps/api/src/lib/mail/mail-parse.ts`, lines 10-11

```typescript
parsedMail.html = DOMPurify.sanitize(parsedMail.html, {FORCE_BODY: true})
parsedMail.html = parsedMail.html.replace(/\s+/g, ' ').trim()
```

The `\s+` -> ` ` replacement collapses all whitespace including intentional newlines in `<pre>` blocks, `<code>` blocks,
and whitespace-sensitive CSS (`white-space: pre`). While HTML rendering is whitespace-agnostic in most contexts, this
can destroy preformatted content.

**Suggested fix**: Remove the whitespace collapsing or limit it to outside `<pre>` tags.

---

#### M6. `textShort` is stored as-is without truncation

**File**: `apps/api/src/lib/mail/mail-parse.ts`, line 26; `maildb.ts` line 33

```typescript
// mail-parse.ts
textShort: parsedMail.text || '',

// maildb.ts
textShort: String(email.textShort || ''),
```

`textShort` is intended as a preview snippet, but it stores the entire plaintext body. For large emails (100KB+ of
text), this wastes database space and makes list queries slower (all that text is loaded into memory for every
`getAllEmails()` call).

**Suggested fix**: Truncate to a reasonable length (e.g., 200 characters) in `parseEml()` or `addEmail()`.

---

#### M7. `Content-Disposition` header in download route uses `params.id` without full sanitization

**File**: `apps/api/src/routes/mail.ts`, line 48

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${params.id}.eml"`;
```

The `params.id` is a Maildir unique ID (e.g., `1709234567.M412345P9876.host`) which is generally safe, but per
CLAUDE.md: "Never interpolate raw user input into headers." The message ID comes from the URL path which is
user-controlled. A crafted ID like `test"\r\nX-Injected: yes` could inject headers.

**Why it matters**: HTTP header injection. Though Elysia likely strips newlines from header values, defense-in-depth
requires explicit sanitization.

**Suggested fix**: Apply the same sanitization used for attachment filenames:
`params.id.replace(/[\x00-\x1f"\\]/g, '_')`.

---

#### M8. `messageGetAttachment()` returns full attachment content in memory

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 122-132

The entire EML is parsed to extract one attachment. For a 25MB email with multiple attachments, this means parsing the
full message and loading all attachments into memory just to serve one.

**Suggested fix**: This is acceptable for a single-user system but worth noting for future optimization. A streaming
parser or cached attachment extraction would be more efficient.

---

#### M9. `mailboxesList()` does not include custom mailboxes

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 58-66

```typescript
async mailboxesList(): Promise<MaildirMailbox[]> {
    const mailboxes: MaildirMailbox[] = []
    for (const name of STANDARD_MAILBOXES) {
        if (await this.store.mailboxDirExists(name)) {
            mailboxes.push(this.getMailboxInfo(name))
        }
    }
    return mailboxes
}
```

Only the 6 standard mailboxes are returned. Custom mailboxes created via `mailboxCreate()` are invisible in the listing.
The IMAP doc explains this is by design (custom folders are IMAP-only), but the `mailboxCreate()` route exists and
succeeds, creating a directory that is then invisible.

**Suggested fix**: Either remove the `mailboxCreate()` route or include custom mailboxes in the listing.

---

#### M10. `emailLabels` and `emailsToLabels` tables exist in schema but are never used

**File**: `apps/api/src/lib/mail/schema.ts`, lines 22-35; `db-config.ts`, lines 38-46

The schema defines `email_labels` and `emails_to_labels` tables with a proper many-to-many relationship, but no code in
the mail backend reads or writes labels. There are no routes, no DB methods, and no UI for labels.

---

#### M11. `messageHandleDraft` writes `from` field unconditionally

**File**: `apps/api/src/lib/mail/maildir.ts`, lines 224-228

```typescript
email.from = {
    value: [{address: user.email, name: user.name}],
    html: user.email,
    text: user.email,
}
```

This overwrites any `from` field the client sends, which is correct for security (prevents spoofing). However, if the
user has multiple email addresses/aliases in the future, this would need to validate the `from` address against allowed
addresses rather than unconditionally overwriting.

---

## Strengths

1. **Clean module separation**: The split into MaildirStore (filesystem), MailDB (database), Maildir (orchestrator), and
   the facade layer is well-designed. Each layer has a single responsibility.

2. **Dovecot-compatible Maildir format**: The filename format (`{time}.M{usec}P{pid}Q{seq}.{host},S={size}:2,{FLAGS}`)
   follows the Maildir++ specification correctly. Flag preservation during renames (keeping Dovecot keyword flags) is a
   thoughtful detail.

3. **Atomic delivery**: The tmp/ -> new/ delivery path (`deliverAtomic`) and tmp/ -> cur/ path (`deliverToCur`) follow
   the Maildir spec's atomicity requirements.

4. **Robust sync engine**: `doSyncMailbox()` handles all four cases (new messages, flag changes, deletions, new/ -> cur/
   transitions) in a single pass. The reentrancy guard prevents duplicate syncs.

5. **Path traversal protection**: `MaildirStore.mailboxDir()` validates mailbox names against `..` and special
   characters. The underlying `LocalFilesystem.getFilePath()` provides a second layer of defense with
   `resolved.startsWith(baseDir)` checks.

6. **HTML sanitization**: Using DOMPurify for email HTML is essential and correctly applied. The `FORCE_BODY` option
   ensures the output is safe for embedding.

7. **Flag-in-filename architecture**: Storing flags in Maildir filenames (not just in the DB) means the DB is truly a
   rebuildable cache, which is the correct Maildir philosophy.

8. **Attachment filename sanitization**: The attachment download route (line 129-130) properly sanitizes the filename
   with `replace(/[\x00-\x1f"\\]/g, '_')`.

9. **fs.watch() integration**: The `watchMailboxes()` method enables near-instant detection of external changes (
   Dovecot, manual file operations), which is key for the dual-access model.

10. **Comprehensive IMAP compatibility doc**: The `IMAP.md` document is thorough, well-structured, and accurately
    reflects the implementation.

---

## Test Coverage Analysis

**Files**: `apps/api/src/test/mail.test.ts`, `apps/api/src/test/mail-imap.test.ts`

### What is well covered

- **Mailbox CRUD**: list, create, exists, duplicate detection, unknown mailbox 404
- **Draft lifecycle**: create, update, list, delete
- **Message operations**: get, move, copy, delete, mark read/unread, set flagged
- **Cross-mailbox moves**: source removal, target addition
- **Error handling**: non-existent mailbox, non-existent message, unknown recipient delivery
- **Path traversal**: `..`, `/`, control characters in mailbox names
- **Cross-user isolation**: ownerId spoofing attempt (though it reveals the validation gap in C2)
- **Maildir utilities**: `createUniqueMessageId`, `getMailIDfromFileName`, `parseFlagsFromFilename`,
  `buildMaildirFilename`, `rebuildFlagsSuffix`, `applyFlagsFromFilename` -- all well tested
- **Dovecot simulation**: external file placed in cur/, new/, flag renames by Dovecot, expunge by Dovecot, cross-mailbox
  move by Dovecot, keyword flag preservation, case-insensitive mailbox lookup

### What is not covered

- **Send flow**: No tests for `messageSend()` (neither dev-mode nor production SMTP). The send failure path (I1) is
  untested.
- **Attachment handling**: No tests for `messageGetAttachment()` or the attachment download route. No test with a
  multipart EML containing attachments.
- **EML generation**: No tests for `createEmlContent()`. No verification that generated EML round-trips through
  `parseEml()` correctly.
- **Welcome mail**: No test for the welcome email delivered on first initialization.
- **Concurrent sync**: No test for two simultaneous `syncMailbox()` calls on the same mailbox.
- **Large messages**: No test with messages near the 25MB limit.
- **Non-ASCII content**: No test with non-ASCII subject, sender name, or body content.
- **`/mail/deliver/:to` abuse**: No test for the delivery endpoint with malformed EML content, oversized payloads, or
  injection attempts.
- **SSE events**: No verification that SSE events are emitted correctly during operations.
- **`messageGetFile()` (download)**: No test for the raw EML download route.
- **Label system**: No tests (because labels are unimplemented).

---

## Summary of Priority Fixes

| ID | Severity  | One-line summary                                                         |
|----|-----------|--------------------------------------------------------------------------|
| C1 | Critical  | Unauthenticated delivery endpoint has no rate limiting or access control |
| C2 | Critical  | `ownerId` in URL is never validated -- any user can hit any ownerId      |
| C3 | Critical  | `readMessage()` may return stale/zero file size                          |
| I1 | Important | `messageSend()` silently returns null on failure, no error feedback      |
| I2 | Important | `sendMail()` swallows SMTP errors                                        |
| I3 | Important | EML headers not RFC 2047 encoded for non-ASCII                           |
| I4 | Important | Empty CC header emitted; missing Content-Transfer-Encoding               |
| I5 | Important | `messageGet()` swallows all exceptions as null                           |
| I6 | Important | Draft update deletes old before writing new (data loss window)           |
| I7 | Important | Transport created per-send instead of reused                             |
| I8 | Important | `size()` uses `\|\|` instead of `??`, wrong for zero                     |
| I9 | Important | Sync error propagates to all coalesced waiters                           |
| M1 | Minor     | `mailboxDir()` throws Error instead of ApiError                          |
| M5 | Minor     | HTML whitespace collapsing destroys `<pre>` content                      |
| M6 | Minor     | `textShort` stores entire body instead of truncated preview              |
| M7 | Minor     | Download route interpolates `params.id` into Content-Disposition         |

---

## Relevant Files

- `apps/api/src/lib/mail/maildir.ts` -- Orchestrator
- `apps/api/src/lib/mail/maildir-store.ts` -- Filesystem layer
- `apps/api/src/lib/mail/maildb.ts` -- Database layer
- `apps/api/src/lib/mail/mail-parse.ts` -- EML parser
- `apps/api/src/lib/mail/mailfile.ts` -- EML generator
- `apps/api/src/lib/mail/sender.ts` -- SMTP sending
- `apps/api/src/lib/mail/mailutils.ts` -- Filename/flag utilities
- `apps/api/src/lib/mail/welcome.ts` -- Welcome email template
- `apps/api/src/lib/mail/sse-events.ts` -- SSE event builders
- `apps/api/src/lib/mail/schema.ts` -- Drizzle schema
- `apps/api/src/lib/mail/db-config.ts` -- Migration config
- `apps/api/src/routes/mail.ts` -- Route definitions
- `apps/api/src/lib/core/constants.ts` -- STANDARD_MAILBOXES, PATHS
- `apps/api/src/lib/core/local-filesystem.ts` -- Filesystem abstraction with path traversal protection
- `packages/lib/src/types/mail.ts` -- Shared mail types
- `packages/lib/src/types/sse.ts` -- SSE event type definitions
- `apps/api/src/test/mail.test.ts` -- Integration tests
- `apps/api/src/test/mail-imap.test.ts` -- IMAP compatibility tests
- `docs/IMAP.md` -- Dovecot/Maildir compatibility design document
