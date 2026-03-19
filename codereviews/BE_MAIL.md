# BE Code Review: Mail

## Summary

The mail backend is well-architected with a clean separation between filesystem operations (`MaildirStore`), database
operations (`MailDB`), email parsing (`mail-parse`), and orchestration (`Maildir`). The IMAP/Dovecot compatibility
refactor (documented in `docs/IMAP.md`) has been implemented thoroughly. The main concerns are: unsanitized
`params.id` interpolated into a `Content-Disposition` header, the unauthenticated delivery endpoint lacking IP
restrictions, missing `await` on the `handleNewDraftEmail` call from `handleReplyEmail`/`handleForwardEmail`, some
`as Email`/`as EmailSummary` casts that bypass type safety, and the `sendMail` function swallowing errors by returning
`false` instead of propagating.

## Critical Issues

### 1. Unsanitized `params.id` in Content-Disposition header (download route)

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, line 65
- **Issue**: `params.id` is interpolated directly into `Content-Disposition` header without sanitization:
  ```typescript
  set.headers['Content-Disposition'] = `attachment; filename="${params.id}.eml"`;
  ```
  A crafted `id` containing `"` or control characters could inject header content.
- **Why it matters**: Header injection can lead to response splitting or misleading filenames in downloads.
  CLAUDE.md explicitly requires: "Sanitize user-provided paths and filenames... Never interpolate raw user input
  into headers."
- **Suggested fix**: Sanitize `params.id` the same way the attachment filename is sanitized on line 147:
  ```typescript
  const safeId = params.id.replace(/[\x00-\x1f"\\]/g, '_');
  set.headers['Content-Disposition'] = `attachment; filename="${safeId}.eml"`;
  ```

### 2. Unauthenticated delivery endpoint has no IP restriction

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, lines 31-34
- **Issue**: The `POST /mail/deliver/:to` endpoint is unauthenticated. The comment acknowledges this with a TODO for
  IP allowlisting, but no restriction is in place. Anyone who can reach the API can deliver mail to any local user.
- **Why it matters**: An attacker could flood users with spam or phishing emails. In a Docker/public deployment this
  is directly exploitable.
- **Suggested fix**: At minimum, add an IP allowlist check (localhost-only) or require a shared secret header. This
  should be a pre-production blocker.

### 3. `sendMail` swallows errors, `messageSend` returns null on failure

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/sender.ts`, lines 71-78
- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 261-293
- **Issue**: `sendMail()` catches all errors and returns `false`. `messageSend()` catches that failure, logs it, and
  returns `null`. The draft is already moved to `Sent` before the error propagates (line 281). The caller (route) gets
  back `null` with a 200 status -- the client thinks something went wrong but the email was actually moved to Sent
  regardless.
- **Why it matters**: Silent failure. The user has no clear feedback that sending failed, and their draft has already
  been moved out of Drafts. CLAUDE.md: "Every mutation needs error feedback."
- **Suggested fix**: `sendMail()` should throw on failure rather than return `false`. `messageSend()` should only move
  to Sent after a confirmed successful send. If sending fails, the draft should remain in Drafts and the error should
  propagate as an `ApiError(502, "Failed to send email")`.

### 4. `messageGet` silently swallows all errors

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 97-113
- **Issue**: The entire `messageGet` method is wrapped in a `try { ... } catch { return null }` that suppresses all
  exceptions. If the database is corrupted, the filesystem is broken, or there's a programming error, the user sees
  a generic 404 (from the facade in `mail.ts` line 51-53).
- **Why it matters**: Debugging becomes extremely difficult. Legitimate errors (permission denied, disk full, parse
  bugs) are indistinguishable from "message not found."
- **Suggested fix**: Remove the blanket catch. Let real errors propagate. Only return `null` for the specific case
  where the message doesn't exist in the DB.

### 5. `readAndParse` silently swallows all errors

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 372-389
- **Issue**: Same pattern -- a bare `catch { return null }` that hides all errors.
- **Why it matters**: Same as above. A corrupted file, a permissions error, or a bug in the parser all silently
  become "message not found."
- **Suggested fix**: Log the error (at minimum) or only catch `ENOENT`-type errors.

## Pattern Violations

### Missing `ownerId` in query keys

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-mailboxes.ts`, lines 5-12
- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, lines 6-12
- **Issue**: Query keys (`mailboxKeys`, `emailKeys`) do not include `ownerId`. CLAUDE.md states: "Query keys must
  include `ownerId` for any owner-scoped data. Without it, switching between personal and team contexts serves stale
  cached data from the wrong owner."
- **Note**: Mail is personal-only (no team mail), so this is lower risk than other domains. But for consistency and
  future-proofing, `ownerId` should be part of the key structure.

### `as Email` / `as EmailSummary` casts bypass type safety

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/mail-parse.ts`, line 27
- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 110, 250, 258, 335
- **Issue**: Multiple `as Email` and `as EmailSummary` casts. The `parseEml` return type doesn't match `Email` (it
  sets `filename: ''`, has no `mailbox` set correctly, etc.), and the spread + cast on line 110 merges two
  different-shaped objects.
- **Why it matters**: CLAUDE.md: "Never use `as any`" -- while these aren't `as any`, they're unsafe casts that
  suppress type mismatches. If the `Email` type changes, these casts will silently produce invalid objects.
- **Suggested fix**: Define a proper return type for `parseEml` (e.g., `ParsedEmailContent`) and use explicit field
  mapping instead of spreads + casts.

### `body: t.Any()` on draft and send routes

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, lines 119, 125
- **Issue**: The draft and send routes accept `body: t.Object({mail: t.Any()})`. This bypasses Elysia's type
  validation entirely for the `mail` payload -- any JSON is accepted.
- **Why it matters**: Eden Treaty's end-to-end type safety is broken for these routes. Malformed input reaches the
  business logic without validation. This could cause crashes in `createEmlContent` or `parseEml` on unexpected
  data shapes.
- **Suggested fix**: Define a proper Elysia schema for `EmailDraft` input (at minimum: `subject`, `text`, `to`,
  `cc`, `bcc` fields with their expected shapes).

### `interface` usage in `__root.tsx`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/__root.tsx`, line 7
- **Issue**: Uses `interface MyRouterContext` instead of `type`.
- **Why it matters**: CLAUDE.md: "Always `type` over `interface` -- except when methods are needed." This is a data
  shape, not a class contract. Minor style violation.

## Security Concerns

### No input validation on mailbox name in routes

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, lines 42-53
- **Issue**: The `mailboxPath` URL parameter and `mailbox` body field are accepted as plain strings with no
  validation at the route level. Validation only happens deep in `MaildirStore.mailboxDir()` (line 165-166).
- **Why it matters**: Defense in depth. Route-level validation catches bad input early, provides clear error messages,
  and prevents accidental bypass if the store validation is ever changed.
- **Suggested fix**: Add `t.String({pattern: '^[a-zA-Z0-9._\\- /]*$'})` or similar to the route schemas, or add a
  shared validation function.

### Delivery endpoint `to` parameter not validated

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, line 31
- **Issue**: The `:to` parameter (email address) is passed directly to `getUserByEmail()`. While this won't cause
  SQL injection (Drizzle parameterizes queries), there's no format validation.
- **Suggested fix**: Validate that `params.to` looks like an email address before querying.

### `params.id` used as message lookup key without format validation

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/mail.ts`, lines 55-67
- **Issue**: `params.id` is used as a database lookup key and then interpolated into a filename. While the database
  lookup is parameterized, the filename usage (in `readAndParse` via `findFileByUniqueId`) could theoretically match
  an unintended file if the ID contains path-like characters.
- **Suggested fix**: Validate that `params.id` matches the expected Maildir unique ID format.

## Data Integrity

### Race condition in draft update (delete then create)

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 210-258
- **Issue**: `messageHandleDraft` deletes the old draft file and DB record, then creates a new one. If the process
  crashes between delete and create, the draft is lost.
- **Why it matters**: The IMAP doc acknowledges this ("Brief window where draft doesn't exist on disk is acceptable
  for single-user"). Still, a crash during save loses user data.
- **Mitigation**: For single-user self-hosted, this is acceptable. For multi-instance deployments, consider
  write-then-swap.

### `syncMailbox` race condition with concurrent Dovecot writes

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 297-368
- **Issue**: The sync reads the disk state, then the DB state, then compares. Between reading disk and acting on the
  comparison, Dovecot could rename or delete a file. The ENOENT catch in the new-message loop (line 340) handles one
  case, but flag-change and delete detection have no such protection.
- **Why it matters**: A flag change detected during sync could fail if the file is renamed again before the DB update.
  However, the next sync will self-correct.
- **Mitigation**: Acceptable for single-user. The self-correcting nature of scan-based sync means transient
  inconsistencies resolve on the next sync cycle.

### `readMessage` returns `file.size` which may differ from content length

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir-store.ts`, lines 100-104
- **Issue**: `file.size` is the on-disk size. After `file.text()`, the in-memory string size differs (due to UTF-8
  encoding). The `size` returned is the file size, which is correct for Maildir purposes, but `parseEml` receives
  this as the email size.
- **Why it matters**: Minor -- the size is used for display/quota, and file size is the right metric. No actual bug.

## Code Quality

### `messageSend` sends then moves -- order should be reversed

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 261-293
- **Issue**: The method calls `messageHandleDraft` first (saves the draft), then attempts to send. If sending
  succeeds, it moves the draft to Sent. But `messageHandleDraft` deletes the old draft and creates a new one first.
  If sending fails, the new draft stays in Drafts -- which is correct, but the user loses their original draft ID.
- **Suggested fix**: Separate draft-saving from send. The send flow should: (1) get the draft content, (2) send via
  SMTP, (3) only then move to Sent.

### Inconsistent error types

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, line 245
- **Issue**: `throw new Error(...)` instead of `throw new ApiError(500, ...)`. Other methods consistently use
  `ApiError`.
- **Suggested fix**: Use `ApiError(500, ...)` for consistency.

### `normalizeMailbox` in SSE handler maps `''` to `'inbox'`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/sse-handlers.ts`, line 15
- **Issue**: `const normalizeMailbox = (mailbox: string) => mailbox === '' ? 'inbox' : mailbox;` -- but the query
  keys use the mailbox path as passed to `useEmails()`, which receives it from the URL parameter. The INBOX path
  is `''` on the backend but the URL uses `inbox`. This normalization ensures SSE invalidation matches the query
  key. However, the `invalidateMailReceived` function hardcodes `'inbox'` (line 154 of `use-emails.ts`), which
  means it only invalidates the INBOX list, not other mailboxes where a message might arrive via external delivery.
- **Why it matters**: If Dovecot delivers mail to a folder other than INBOX (via sieve rules), the SSE event carries
  the actual mailbox name but `invalidateMailReceived` only refreshes `inbox`.
- **Suggested fix**: `invalidateMailReceived` should accept the mailbox from the event data.

### Dead/commented-out code in `email-sidebar.tsx`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-sidebar.tsx`, lines 193-224
- **Issue**: Large blocks of commented-out JSX for custom mailboxes and "new folder" button.
- **Suggested fix**: Remove dead code; it's in git history if needed later.

### `welcome.ts` is unreadable at 35K tokens

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/welcome.ts`
- **Issue**: The file is extremely large (exceeded the 25K token read limit). It likely contains an inlined HTML
  template.
- **Suggested fix**: Move the welcome email template to a separate file (e.g., a `.html` template) and load it at
  runtime, or at least compress/simplify the template.

## Architecture

### Clean module separation (positive)

The split between `MaildirStore` (filesystem), `MailDB` (database), `Maildir` (orchestrator), and `mail.ts` (facade)
follows the project's established patterns well. Each module has a single responsibility.

### `fs.watch` setup happens during `init()` before directories may exist

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir-store.ts`, lines 141-156
- **Issue**: `watchMailboxes()` is called from `Maildir.init()` (line 49 of `maildir.ts`). For a brand new user,
  `createStandardMailboxes` just ran, so directories exist. But the `try/catch` on line 151 silently swallows errors
  for directories that don't exist. If a mailbox directory is created later (e.g., via `mailboxCreate`), no watcher
  is added for it.
- **Why it matters**: Custom mailboxes created after init won't be watched. Since Eigen only shows 6 standard
  mailboxes, this is mostly fine, but it's an implicit assumption.

### `canonicalMailbox()` does case-insensitive matching against `STANDARD_MAILBOXES`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mail/maildir.ts`, lines 21-24
- **Issue**: This normalizes user input (`mailboxGet('sent')` -> `'Sent'`), which is correct. However, non-standard
  mailbox names pass through un-normalized, meaning custom mailboxes are case-sensitive.
- **Why it matters**: Minor inconsistency. Standard mailboxes are case-insensitive, custom ones are case-sensitive.

## Positive Patterns

- **Maildir compatibility**: The implementation follows the IMAP.md plan closely. Standard Maildir++ filenames,
  atomic `tmp/` -> `new/` delivery, flag-in-filename, `maildirfolder` markers, and subscriptions file are all
  correctly implemented.
- **Sync-based design**: The `syncMailbox()` implementation handles all four cases (new messages, flag changes,
  deletions, `new/` -> `cur/` moves) with proper ENOENT handling for race conditions with Dovecot.
- **Good test coverage**: Both `mail.test.ts` and `mail-imap.test.ts` cover CRUD, mailbox operations, path
  traversal defense, cross-user isolation, and Dovecot simulation (external file writes, flag renames, expunges).
- **SSE events**: All mutations emit appropriate SSE events for real-time frontend updates.
- **Path traversal protection**: `mailboxDir()` validates mailbox names against `..`, special characters, and path
  separators. Tests verify this.
- **Attachment filename sanitization**: The attachment download route properly sanitizes `params.fileName` in the
  `Content-Disposition` header (line 147).

## Recommendations

| Priority | Issue                                                                            | Location                                |
|----------|----------------------------------------------------------------------------------|-----------------------------------------|
| P0       | Sanitize `params.id` in Content-Disposition header                               | `routes/mail.ts:65`                     |
| P0       | Add IP restriction / auth to delivery endpoint                                   | `routes/mail.ts:31-34`                  |
| P1       | Fix `sendMail` error handling -- propagate errors, don't move to Sent on failure | `sender.ts:71`, `maildir.ts:261`        |
| P1       | Add proper Elysia schema validation for draft/send `mail` payload                | `routes/mail.ts:119,125`                |
| P1       | Remove blanket `catch` in `messageGet` and `readAndParse`                        | `maildir.ts:111,386`                    |
| P1       | Add `ownerId` to mail query keys for consistency                                 | `use-mailboxes.ts:5`, `use-emails.ts:6` |
| P2       | Fix `invalidateMailReceived` to accept mailbox from SSE event                    | `use-emails.ts:153`                     |
| P2       | Replace `as Email`/`as EmailSummary` casts with proper type mapping              | `mail-parse.ts:27`, `maildir.ts:110`    |
| P2       | Use `ApiError` consistently (not bare `Error`)                                   | `maildir.ts:245`                        |
| P2       | Add route-level validation for mailbox names                                     | `routes/mail.ts`                        |
| P2       | Extract welcome email template from `welcome.ts`                                 | `welcome.ts`                            |
| P2       | Remove dead/commented-out code                                                   | `email-sidebar.tsx:193-224`             |
