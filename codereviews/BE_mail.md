# Backend Review: Mail (Maildir, IMAP, SMTP)

**Scope:** `apps/api/src/lib/mail/`, `apps/api/src/routes/mail.ts`
**Reviewed:** 2026-03-18

---

## Critical Issues

### 1. Mailbox name path traversal -- no sanitization on user-supplied mailbox names

- **File:** `apps/api/src/lib/mail/maildir-store.ts:163-166`
- **File:** `apps/api/src/routes/mail.ts:31,38`
- **Impact:** An authenticated user can read/create directories outside their Maildir.
- **Status:** New finding.

The `mailboxDir` method constructs a filesystem path from an unsanitized mailbox name:

```typescript
mailboxDir(mailbox: string): string {
    if (mailbox === '' || mailbox === 'INBOX') return this.basePath
    return `${this.basePath}/.${mailbox.replace('/', '.')}`
}
```

`String.replace('/', '.')` only replaces the **first** `/` -- subsequent slashes remain. A mailbox name
containing `..` can escape the Maildir directory. For example, a `mailboxCreate` call with mailbox
`x/../../other-user` would construct path `Maildir/.x.../../other-user`, which after `path.join` resolution
in `LocalFilesystem.getFilePath` becomes `eigen.mail/Maildir/.x./other-user` -- allowing creation of
directories outside the expected Maildir hierarchy.

The `mailboxGet` route uses wildcard params (`params['*']`) which can contain arbitrary path segments.
Combined with `canonicalMailbox` (maildir.ts:21-24) which passes unrecognized names through unchanged,
there is no validation layer between user input and filesystem operations.

**Fix:** Validate mailbox names against a strict pattern (e.g., `/^[A-Za-z0-9._-]+$/`) and reject names
containing `..`, `/`, or `\`. Apply this validation in `canonicalMailbox` or at the route level before any
filesystem operation.

---

### 2. Header injection in Content-Disposition on attachment download

- **File:** `apps/api/src/routes/mail.ts:129`
- **Impact:** HTTP response splitting / header injection.
- **Status:** New finding.

The attachment download endpoint interpolates `params.fileName` directly into an HTTP header:

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${params.fileName}"`;
```

A malicious filename containing `"` or `\r\n` characters could break out of the header value, injecting
arbitrary HTTP headers. For example, a filename like `evil"\r\nX-Injected: true` would corrupt the response.
The same issue exists on line 48 with `params.id` in the EML download, though message IDs are internally
generated and less likely to be attacker-controlled.

**Fix:** Sanitize the filename by removing or encoding `"`, `\r`, and `\n` characters. Ideally, use
RFC 5987 `filename*=UTF-8''...` encoding for non-ASCII filenames, or simply strip all non-safe characters.

---

### 3. Public delivery endpoint has no rate limiting, size limit, or auth

- **File:** `apps/api/src/routes/mail.ts:28`
- **File:** `apps/api/src/lib/mail/mail.ts:32-39`
- **Impact:** Mailbox flooding, disk exhaustion, spoofed mail delivery.
- **Status:** Carried from previous review (critical #2). Confirmed still present.

`POST /mail/deliver/:to` accepts arbitrary EML content from unauthenticated callers with zero protections:
no rate limiting, no body size limit, no sender verification, no spam filtering, no quota enforcement.
An attacker can flood any user's mailbox with multi-MB messages until disk fills.

The `to` parameter is used directly as an email address to look up a user via `getUserByEmail`
(user.ts:6-8). While this does not allow injection (the lookup is via Drizzle ORM `eq()` which
parameterizes the query), the endpoint itself is fully open.

Additionally, `new TextDecoder().decode(new Uint8Array(file))` on line 38 of mail.ts will silently replace
non-UTF-8 bytes with U+FFFD, potentially corrupting binary MIME parts in the delivered EML.

**Fix:** Add rate limiting per IP, a body size limit (e.g., 25MB), and quota enforcement via
`enforceFileUpload`. Consider restricting to localhost or requiring a shared secret for production MTA
integration. Accept the body as a raw buffer and write it directly to disk rather than decoding to
UTF-8 string.

---

### 4. BCC headers persisted in stored EML files

- **File:** `apps/api/src/lib/mail/mailfile.ts:26-36`
- **Impact:** BCC recipient list leaked to IMAP clients or anyone reading the Maildir on disk.
- **Status:** Carried from previous review (important #6). Severity elevated to critical because this is a privacy violation per RFC 5322.

`createEmlContent` always emits all headers including `BCC:`:

```typescript
const headers = [
    `From: ${formatAddresses(input.from)}`,
    `To: ${formatAddresses(input.to)}`,
    `CC: ${formatAddresses(input.cc)}`,
    `BCC: ${formatAddresses(input.bcc)}`,
    ...
]
```

Even when empty, a `BCC: ` header is emitted. When BCC values are present, they are persisted in the
EML file stored in Sent/Drafts. Any IMAP client (e.g., Dovecot serving these files) will expose the
BCC recipients to the user and potentially to other mail clients that forward the raw source.

Per RFC 5322 section 3.6.3, the BCC field should be removed from the message before delivery.

**Fix:** Only emit CC/BCC headers when they have values. Never persist BCC in the stored EML --
use BCC only in the SMTP envelope, not the message headers.

---

## Important Issues

### 5. EML generation uses hardcoded MIME boundary

- **File:** `apps/api/src/lib/mail/mailfile.ts:35`
- **Impact:** Message corruption when body contains the boundary string.
- **Status:** Carried from previous review (important #5). Confirmed, line reference verified.

All generated EML messages use the literal boundary `"boundary-string"`. If the email body text
or HTML contains the string `--boundary-string`, any conforming mail parser will misinterpret it as
a MIME part delimiter, corrupting the message body. RFC 2046 section 5.1.1 requires the boundary
to not appear in the encapsulated content.

**Fix:** Generate a unique boundary per message: `boundary_${crypto.randomUUID().replace(/-/g, '')}`.

---

### 6. `messageDelete` deletes DB record before file -- inconsistency on failure

- **File:** `apps/api/src/lib/mail/maildir.ts:134-146`
- **Impact:** Orphaned files on disk; phantom delete SSE events.
- **Status:** Carried from previous review (important #8). Confirmed at exact lines.

```typescript
this.db.deleteEmail(messageId)           // line 138 - sync, DB record gone
await this.store.deleteMessage(...)      // line 139 - async, may fail
```

If `store.deleteMessage` fails (permission error, disk I/O), the DB record is already gone and the SSE
delete event has been emitted. The orphaned file will be re-discovered on next `syncMailbox` and
re-inserted, creating a ghost message. Note: `messageMove` (line 157-159) correctly does file-first,
then DB -- only `messageDelete` has the wrong order.

**Fix:** Reverse the order: delete file first, then DB record. If the file is already gone (ENOENT),
proceed with DB cleanup.

---

### 7. Non-atomic flag updates -- `renameFlag` + `setRead`/`setFlagged` are separate DB writes

- **File:** `apps/api/src/lib/mail/maildir.ts:183-207`
- **Impact:** Inconsistent DB state on crash between the two writes.
- **Status:** Carried from previous review (important #9). Analysis deepened.

`messageSetRead` calls `renameFlag` which does: (1) filesystem rename, (2) `db.setFilename`. Then
`messageSetRead` does (3) `db.setRead`. Steps 2 and 3 are separate synchronous DB writes with no
transaction. If the process crashes after step 2 but before step 3, the filename in DB reflects the
new flag state but the `isRead` column does not.

The `updateFlags` method in maildb.ts (line 94-96) already supports setting multiple flags and
filename in a single write -- it is used by `syncMailbox` but not by `renameFlag`.

**Fix:** Have `renameFlag` accept the flag column update and perform a single DB write using
`db.updateFlags`, or wrap steps 2-3 in a SQLite transaction.

---

### 8. `messageGet` and `readAndParse` silently swallow all errors

- **File:** `apps/api/src/lib/mail/maildir.ts:97-113` and `372-388`
- **Impact:** Debugging difficulty; masks real errors as "not found".
- **Status:** Carried from previous review (important #7). Confirmed both methods have bare catch blocks.

Both `messageGet` (line 111) and `readAndParse` (line 386) have bare `catch` blocks that return `null`,
converting any error (filesystem permission, corrupted DB, parsing bug) into a silent "message not found".
The facade in mail.ts:48-52 then converts `null` to a 404 `ApiError`, making real errors
indistinguishable from missing messages.

**Fix:** Log the error in the catch block. Better: only catch `ENOENT`/expected errors and let others
propagate so they surface as 500s with stack traces.

---

### 9. `ownerId` URL parameter ignored in all mail routes

- **File:** `apps/api/src/routes/mail.ts:30-132`
- **File:** `apps/api/src/lib/mail/mail.ts:7-10`
- **Impact:** Misleading API contract; risk of future regression.
- **Status:** Carried from previous review (critical #1). Downgraded to important -- no data leak exists.

All authenticated routes include `:ownerId` in the URL but every handler passes `user` (from session)
to the facade, which resolves `Home` from `user.id`. The `ownerId` parameter is entirely cosmetic.

The test at mail.test.ts:326-340 proves this: Bob calls `POST /mail/${alice.id}/mailbox` and the
mailbox is created in Bob's account. The test title says "ownerId spoofing does not let Bob write
mailboxes into Alice account" -- this is correct behavior but misleading API design.

**Fix:** Either validate `ownerId === user.id` and reject mismatches with 403, or remove `:ownerId`
from mail routes entirely. Other domain routes (drive, calendar) use ownerId for team/org access, but
mail is strictly personal -- the parameter serves no purpose here.

---

### 10. `syncMailbox` coalescing can miss filesystem changes during sync

- **File:** `apps/api/src/lib/mail/maildir.ts:297-308`
- **Impact:** Delivered messages not visible until next sync trigger.
- **Status:** Carried from previous review (important #4). Confirmed.

The concurrency guard returns the in-progress promise to concurrent callers:

```typescript
const running = this.syncingMailboxes.get(mailbox)
if (running) return running
```

If `fs.watch` fires during an active sync, the watcher callback joins the running sync (which has
already scanned the directory and won't see the new file). The change is missed until the next
API request or `fs.watch` event.

**Fix:** Track whether a re-sync was requested during execution. After `doSyncMailbox` completes, if
a re-sync was requested, run again.

---

### 11. `addEmail` uses SELECT-then-INSERT/UPDATE instead of upsert

- **File:** `apps/api/src/lib/mail/maildb.ts:24-53`
- **Impact:** Non-atomic; unnecessary round-trip; potential race condition.
- **Status:** New finding.

```typescript
const existing = this.db.select().from(schema.emails).where(eq(schema.emails.id, record.id)).get()
if (existing) {
    this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id)).run()
} else {
    this.db.insert(schema.emails).values(record).run()
}
```

This is two queries where SQLite's `INSERT OR REPLACE` (or Drizzle's
`.onConflictDoUpdate()`) would be atomic and faster. Under concurrent syncs, two callers could
both see the email as missing and both attempt inserts, causing a constraint violation on the
primary key.

**Fix:** Use `db.insert(schema.emails).values(record).onConflictDoUpdate(...)`.

---

### 12. HTML sanitization does not block CSS-based tracking

- **File:** `apps/api/src/lib/mail/mail-parse.ts:10`
- **Impact:** Email open tracking and potential data exfiltration via CSS.
- **Status:** New finding.

`DOMPurify.sanitize(parsedMail.html, {FORCE_BODY: true})` strips scripts and event handlers but
allows CSS by default. A malicious sender can embed `background-image: url('https://tracker.example/pixel.gif')`
in inline styles or `<style>` blocks to track when a recipient opens the email. CSS `url()` values
can also be used for data exfiltration in some contexts.

**Fix:** Add `FORBID_TAGS: ['style']` and `FORBID_ATTR: ['style']` to the DOMPurify config, or use
`ALLOWED_ATTR` / `ALLOWED_TAGS` allowlists. Alternatively, strip all external URL references from CSS.

---

## Minor Issues

### 13. `createUniqueMessageId` calls `Date.now()` twice

- **File:** `apps/api/src/lib/mail/mailutils.ts:19-20`
- **Impact:** Seconds and microseconds component can be inconsistent.
- **Status:** Carried from previous review (minor #10). Confirmed at exact lines.

```typescript
const time = Math.floor(Date.now() / 1000)
const usec = (Date.now() % 1000) * 1000
```

If the two `Date.now()` calls span a second boundary, `time` and `usec` will be from different
seconds (e.g., time=1000 from 999999ms, usec=0 from 1000000ms).

**Fix:** Capture `Date.now()` once: `const now = Date.now()`.

---

### 14. `size()` method uses `||` instead of `??` -- treats 0 as falsy

- **File:** `apps/api/src/lib/mail/maildir.ts:52-54`
- **Impact:** Returns DB-derived size for empty Maildirs instead of actual disk size.
- **Status:** Carried from previous review (minor #12). Confirmed.

```typescript
async size(): Promise<number> {
    return (await this.store.dirSize()) || this.db.size()
}
```

`dirSize()` returning 0 (empty maildir) triggers the fallback to `this.db.size()`, which
computes a different metric (sum of message `size` columns vs actual disk usage).

**Fix:** Use `??` instead of `||`. Also: `this.store.dirSize()` calls
`this.storage.dirSize(ROOT)` which traverses the entire `eigen.mail/` directory tree -- this
includes `mail.db` and WAL files, not just message files. Clarify which metric is intended.

---

### 15. `textShort` stores full plaintext body in DB

- **File:** `apps/api/src/lib/mail/mail-parse.ts:27`
- **Impact:** Database bloat; full body returned in every mailbox listing.
- **Status:** Carried from previous review (minor #13). Additional impact identified.

`textShort: parsedMail.text || ''` stores the entire plaintext body. The `getAllEmails` method
(maildb.ts:98-100) selects all columns, so every `mailboxGet` request returns the full text of
every message in the mailbox -- wasteful for list views.

**Fix:** Truncate to a reasonable preview length (e.g., 200 chars) at parse time. Or select
specific columns in `getAllEmails` to exclude `textShort` for list queries.

---

### 16. `welcome.ts` contains hardcoded Exchange headers and Message-ID

- **File:** `apps/api/src/lib/mail/welcome.ts:7-11`
- **Impact:** Unprofessional; references external Exchange infrastructure.
- **Status:** Carried from previous review (minor #14). Confirmed.

The welcome email contains `Thread-Topic`, `Thread-Index`, and a `Message-ID` referencing
`DU0PR01MB9407.eurprd01.prod.exchangelabs.com`. Also hardcodes `Content-Language: nl-NL` and
`Accept-Language: nl-NL, en-US`.

**Fix:** Generate `Message-ID` dynamically using `createUniqueMessageId()@eigen.local`. Remove
Exchange-specific headers and hardcoded language preferences.

---

### 17. Draft/send routes use `t.Any()` -- no runtime validation

- **File:** `apps/api/src/routes/mail.ts:99,103`
- **Impact:** No type safety or input validation on draft/send payloads.
- **Status:** Carried from previous review (minor #17). Confirmed.

```typescript
.put("/mail/:ownerId/message/draft", ..., { body: t.Object({mail: t.Any()}) })
.post("/mail/:ownerId/message/send", ..., { body: t.Object({mail: t.Any()}) })
```

The `DraftInput` type exists in `packages/lib/src/types/mail.ts:95-101` but is not used for
runtime validation. Any JSON payload is accepted and cast to `EmailDraft`.

**Fix:** Define an Elysia type schema matching `DraftInput` for runtime validation.

---

### 18. `messageSend` returns `null` on failure -- swallows error

- **File:** `apps/api/src/lib/mail/maildir.ts:288-291`
- **Impact:** Client receives 200 with null body instead of an error status.
- **Status:** Carried from previous review (minor #16). Confirmed.

When `sendMail` throws or returns false, the draft has already been saved to Drafts (line 262)
and the catch block returns `null`. The route returns this `null` as a 200 response with no
indication of failure.

**Fix:** Throw `ApiError(502, 'Failed to send email')` instead of returning `null`.

---

### 19. `sendMail` creates a new nodemailer transport on every call

- **File:** `apps/api/src/lib/mail/sender.ts:51-52`
- **Impact:** Minor overhead; prevents connection pooling for future SMTP support.
- **Status:** Carried from previous review (minor #15). Confirmed.

Currently uses `sendmail` transport (spawns `/usr/sbin/sendmail`) which makes this low-impact.
If SMTP transport is added later, this becomes a connection leak.

**Fix:** Create the transport once at module level or use a lazy singleton.

---

### 20. `messageGetAttachment` does not validate negative index

- **File:** `apps/api/src/lib/mail/maildir.ts:127`
- **File:** `apps/api/src/routes/mail.ts:130`
- **Impact:** Unexpected behavior with negative array index.
- **Status:** New finding.

The route converts `params.index` to a number via `Number(params.index)`. A negative index
like `-1` passes the `index >= parsed.attachments.length` check but
`parsed.attachments[-1]` returns `undefined` in JavaScript, so the route returns `null`.
While not exploitable, it should return a proper 400 error.

**Fix:** Add `index < 0` to the bounds check, or validate at the route level with
`t.Number({ minimum: 0 })`.

---

### 21. Unused label tables in schema

- **File:** `apps/api/src/lib/mail/schema.ts:22-35`
- **File:** `apps/api/src/lib/mail/db-config.ts:31-46`
- **Impact:** Dead code; confusing for maintainers.
- **Status:** Carried from previous review (recommendation #10). Confirmed.

`emailLabels` and `emailsToLabels` tables are defined in both the Drizzle schema and the SQL
migration but no code reads from or writes to them. The `DEFAULT_LABELS` constant in
`constants.ts:35-40` suggests labels were planned but never implemented.

**Fix:** Implement the label system or remove the dead schema and migration SQL.

---

### 22. `mailboxesList` excludes custom mailboxes

- **File:** `apps/api/src/lib/mail/maildir.ts:58-66`
- **Impact:** Custom mailboxes created via `mailboxCreate` are invisible in the list.
- **Status:** Carried from previous review (minor #18). Analysis refined.

```typescript
async mailboxesList(): Promise<MaildirMailbox[]> {
    for (const name of STANDARD_MAILBOXES) {
        if (await this.store.mailboxDirExists(name)) {
            mailboxes.push(this.getMailboxInfo(name))
        }
    }
    return mailboxes
}
```

Only `STANDARD_MAILBOXES` are checked. Any custom mailbox created via `mailboxCreate` (which
the test suite does: `Projects`, `Duplicate`, etc.) will never appear in `mailboxesList`. The
`mailbox-exists` endpoint can verify them individually, but they are invisible in the UI list.

**Fix:** Also scan for `.`-prefixed directories in the Maildir root that are not in
`STANDARD_MAILBOXES`.

---

## Observations

**Architecture compliance:** The mail domain follows project patterns well. Domain logic in
`lib/mail/maildir.ts`, thin facade in `mail.ts`, routes in `routes/mail.ts`, schema + db-config
pair, SSE events with notification templates. Uses `type` over `interface`, no JSDoc, English
throughout.

**Maildir compliance:** The implementation correctly follows Maildir++ conventions: `tmp/new/cur/`
directory structure, dot-prefixed subfolder naming (`.Sent`, `.Drafts`), `maildirfolder` marker
files, `subscriptions` file, atomic delivery via tmp-then-rename, Maildir filename format
(`uniqueId,S=size:2,FLAGS`), and Dovecot keyword flag preservation (lowercase letters after
standard uppercase flags).

**Test coverage:** Two test files totaling ~920 lines provide strong coverage of CRUD operations,
draft lifecycle, cross-mailbox moves, error cases, Maildir filename utilities, Dovecot
interop scenarios (external file placement, flag changes, expunge, cross-mailbox move), keyword
preservation, case-insensitive lookup, copy semantics, and atomic delivery verification.

**Missing test coverage:**
- Path traversal in mailbox names
- Concurrent sync operations
- Malformed EML parsing (corrupted headers, truncated content)
- `messageGetAttachment` with out-of-range or negative index
- `messageSend` error paths (sendmail failure, dev mode)
- Public delivery with non-UTF-8 binary content
- Draft update (overwriting existing draft by ID)
- `size()` method correctness

**Robustness notes:**
- `moveNewToCur` correctly catches ENOENT (maildir-store.ts:88-89)
- `syncMailbox` catches per-message parse errors (maildir.ts:340-341)
- `deleteMessage` checks file existence before unlink (maildir-store.ts:127)
- `readMessage` has no error handling and will throw on ENOENT
- `moveMessage` will throw on ENOENT without recovery
- Full EML content loaded into memory for parsing -- no streaming for large messages
- No `cleanStaleTmp()` implementation for cleaning up partial deliveries in `tmp/`
- `DOMPurify` is correctly applied for XSS prevention on HTML email bodies
