# BE Code Review: Contacts

## Summary

The Contacts backend is a relatively compact domain with a clear structure following the project's Home singleton
pattern. However, it has two missing `await` calls (the #1 bug class per CLAUDE.md), an N+1 query problem, a
non-English comment, a race condition in avatar cleanup, and several data integrity concerns around label deletion
ordering and eigenId mutability.

## Critical Issues

### 1. Missing `await` on `addContact` in `init()`

- **File**: `apps/api/src/lib/contacts/contacts.ts`, line 89
- **Issue**: `this.addContact({...})` is called without `await`. `addContact` is `async` and returns a `Promise`.
  Without `await`, the method fires and forgets -- any database error is silently swallowed, and the contact may not
  exist when subsequent code expects it.
- **Why it matters**: CLAUDE.md explicitly states missing `await` is the #1 bug class. The bare Promise is truthy, so
  any conditional check on the result would silently pass.
- **Suggested fix**: Add `await` before `this.addContact({...})`.

### 2. Missing `await` on `cleanupAvatarImages` in `init()`

- **File**: `apps/api/src/lib/contacts/contacts.ts`, line 106
- **Issue**: `this.cleanupAvatarImages()` is `async` but called without `await`. The cleanup runs in the background
  with no error handling, and if it fails (e.g., filesystem error), the error is silently lost.
- **Why it matters**: Same #1 bug class. Orphaned avatar files accumulate, and filesystem errors go undetected.
- **Suggested fix**: Add `await` before `this.cleanupAvatarImages()`.

### 3. `deleteLabel` deletes label row before junction rows -- cascade may already handle it

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 234-237
- **Issue**: The method first deletes the label from `schema.labels`, then explicitly deletes from
  `schema.contactsToLabels`. Since the junction table has `ON DELETE CASCADE` on the `labelId` foreign key (see
  `schema.ts` line 29), the cascade should already delete junction rows when the label is deleted. The explicit second
  delete is redundant but harmless. However, if `foreign_keys` pragma were ever off, the junction rows would be
  orphaned after the label row delete (the explicit delete would still run, but if it failed between the two, data
  would be inconsistent). More critically, this ordering means if the second delete fails, the label is already gone
  but the caller sees an error -- there's no transaction wrapping.
- **Why it matters**: Data consistency depends on cascade behavior. Without an explicit transaction, partial failure
  leaves inconsistent state.
- **Suggested fix**: Either rely on the cascade (remove the explicit junction delete) or wrap both deletes in a
  transaction. Ideally, delete junction rows first, then the label.

## Pattern Violations

### Non-English comment

- **File**: `apps/api/src/lib/contacts/contacts.ts`, line 86
- **Issue**: Comment `// add reinder, zodat het een beetje gezellig is` is in Dutch.
- **Why it matters**: CLAUDE.md requires English everywhere.
- **Suggested fix**: Translate to English, e.g., `// seed Reinder as a default contact`.

### Hardcoded developer seed data

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 87-103
- **Issue**: The `init()` method hardcodes `reinder@{domain}` as a seeded contact with a fixed name. This is
  developer-specific logic that will confuse other users or deployments.
- **Why it matters**: Every new user gets a "Reinder Nijhoff" contact added automatically, which is inappropriate for
  production.
- **Suggested fix**: Remove the hardcoded seed contact or make it configurable via server settings.

### Unnecessary try/catch rethrow

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 214-231
- **Issue**: `updateLabel` wraps its body in `try { ... } catch (error) { throw error; }`, which is a no-op pattern.
- **Why it matters**: Dead code noise.
- **Suggested fix**: Remove the try/catch wrapper.

## Security Concerns

### Avatar filename validation is good but could be stricter

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 319-321
- **Issue**: `downloadAvatar` validates against `/`, `\`, and `..`, which is good. However, it does not check for
  null bytes or other control characters that could be problematic on some filesystems.
- **Why it matters**: CLAUDE.md requires sanitizing against control characters.
- **Suggested fix**: Add a check for control characters: `if (/[\x00-\x1f]/.test(filename)) return null;`

### No input validation on label `color` field

- **File**: `apps/api/src/routes/contacts.ts`, lines 31-35
- **Issue**: The `LabelSchema` accepts any string for `color`. A malicious user could inject arbitrary strings
  (including very long ones or scripts) that will be stored and later rendered in the frontend via `style` attributes.
- **Why it matters**: While not a direct XSS vector (React sanitizes `style` objects), excessively long values could
  cause storage or rendering issues. A color format validation would be a defense-in-depth measure.
- **Suggested fix**: Validate `color` matches a hex color pattern: `t.String({ pattern: '^#[0-9a-fA-F]{6}$' })`.

### No length limits on contact fields

- **File**: `apps/api/src/routes/contacts.ts`, lines 15-29
- **Issue**: The `ContactSchema` has no `maxLength` constraints on `firstName`, `lastName`, `company`, `jobTitle`,
  `notes`, etc. A malicious user could submit megabytes of data in a single field.
- **Why it matters**: Storage abuse and potential denial of service on the per-user SQLite database.
- **Suggested fix**: Add `maxLength` constraints to string fields in the schema.

### Avatar upload accepts any image MIME type without server-side verification

- **File**: `apps/api/src/routes/contacts.ts`, line 94
- **Issue**: The route uses `t.File({format: 'image/*'})` which relies on the client-reported MIME type. The actual
  file content is processed by `generateImagePreview` (which uses sharp), so a non-image file would fail there, but
  the error message would be generic.
- **Why it matters**: Minor -- sharp provides implicit validation, but explicit MIME verification before processing
  would be more robust.

## Data Integrity

### N+1 query in `getContacts()`

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 267-295
- **Issue**: For every contact, a separate query fetches label relations. With N contacts, this results in N+1 queries.
- **Why it matters**: Performance degrades linearly with contact count. While SQLite is fast for local queries, this
  is still an unnecessary overhead pattern.
- **Suggested fix**: Fetch all `contactsToLabels` rows in a single query and group them in memory, or use a JOIN.

### N+1 query in `getContactById()`

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 240-265
- **Issue**: Same pattern as above -- separate query for label relations per contact. Less impactful since it's a
  single contact, but inconsistent with best practices.

### `setContactLabels` does not validate label IDs exist

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 119-130
- **Issue**: The method inserts junction rows without verifying that the provided `labelId` values correspond to
  existing labels. The foreign key constraint will cause a database error, but the error message will be cryptic.
- **Why it matters**: Poor error messages for invalid label IDs.
- **Suggested fix**: Validate label IDs exist before inserting, or catch the FK violation and throw a descriptive
  `ApiError`.

### No transaction wrapping for multi-step mutations

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 132-151 (`addContact`), 165-191 (`updateContact`)
- **Issue**: `addContact` inserts the contact row and then sets labels in separate queries. `updateContact` updates
  the contact row and then sets labels. If the label-setting step fails, the contact row is already committed.
- **Why it matters**: Partial state on failure.
- **Suggested fix**: Wrap contact + label operations in a SQLite transaction.

### `cleanupAvatarImages` races with concurrent uploads

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 334-344
- **Issue**: The cleanup reads all contacts, then deletes avatar files not referenced by any contact. If a user
  uploads an avatar and updates their contact concurrently, the cleanup could delete the newly uploaded avatar before
  the contact update completes.
- **Why it matters**: Uploaded avatars could be lost.
- **Suggested fix**: Only clean up avatars older than a threshold (e.g., 1 hour), or run cleanup after contact saves
  rather than during init and upload.

### `updateLabel` fetches the updated label but never uses it

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 223-227
- **Issue**: After updating, the method queries the updated label (`updatedLabel`) but the return value is only used
  to return from the function. However, the route handler (`PUT /contacts/:ownerId/labels/:id`) does `return await
  ...updateLabel(...)`, so this is actually used. No bug, but the intermediate variable is unnecessary -- could
  return the query result directly.

## Code Quality

### `avatar` stored both in `data` JSON and as a top-level column

- **File**: `apps/api/src/lib/contacts/schema.ts`, line 11 vs line 12
- **Issue**: The `contacts` table has an `avatar` top-level column AND the `data` JSON column's type excludes
  `avatar` from its type but `extractContactData` (line 29-44) puts `avatar` into `data`. Meanwhile the schema has a
  separate `avatar` column that is never written to during `addContact` or `updateContact`.
- **Why it matters**: The `avatar` column in the schema is dead -- data is stored in the JSON `data` column. The
  schema column wastes space and causes confusion.
- **Suggested fix**: Remove the `avatar` column from the schema, or move avatar storage to the dedicated column and
  exclude it from the JSON blob consistently.

### Inconsistent use of `async` on synchronous Drizzle calls

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 245-250, 272-277
- **Issue**: The label relations query uses synchronous `.all()` but is called with `await` in `getContactById` (line
  245 uses `const labelRelations = this.db.select(...)...all()` without await but inside an async function). In
  `getContacts`, same pattern. Drizzle's synchronous SQLite driver returns results directly from `.all()`, so the
  `await` on the contact query (line 241, 268) is also a no-op for sync drivers. This inconsistency is confusing.
- **Why it matters**: Code readability -- reader cannot tell which calls are sync vs async.

### `getMe` mixes sync and async calls

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 366-375
- **Issue**: `this.db.select()...get()` on line 368 is called synchronously (no `await`), then `this.getContactById`
  is called with `await`. The sync call works because Bun's SQLite driver is synchronous, but the pattern is
  inconsistent.

## Architecture

### `getContacts()` top-level function vs `Contacts` class method naming collision

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 20-23 vs 267
- **Issue**: There is a top-level `getContacts(user)` function that returns `home.contacts` (the `Contacts` instance),
  and the `Contacts` class has a method also called `getContacts()` that returns the contact list. This naming is
  confusing -- `getContacts(user)` returns the service, not the contacts.
- **Suggested fix**: Rename the top-level function to `getContactsService(user)` or similar.

### `extractContactData` returns redundant structures

- **File**: `apps/api/src/lib/contacts/contacts.ts`, lines 29-45
- **Issue**: Returns `{data, contactData, labels}` where `contactData` is the full contact minus labels, and `data`
  is a subset of `contactData`. The caller uses different parts in different places. This indirection makes it hard to
  understand what fields end up where.
- **Suggested fix**: Simplify the extraction to clearly separate "schema columns" from "JSON blob fields".

## Positive Patterns

- **SSE events are properly emitted** for all CRUD operations on both contacts and labels.
- **`requireSelf`** access control is applied consistently on every route.
- **Avatar upload** correctly uses `generateImagePreview` to resize and convert to WebP, preventing storage of
  arbitrarily large images.
- **`enforceAvatarUpload`** quota enforcement is applied before processing.
- **Path traversal prevention** in `downloadAvatar` is present and correct for the common cases.
- **ManagedDatabase** pattern is correctly used via `getLocalDatabase`.
- **Proper SSE builder pattern** with templates for all event types.

## Recommendations

| Priority | Issue                                                           | Location                                |
|----------|-----------------------------------------------------------------|-----------------------------------------|
| **P0**   | Add `await` to `this.addContact(...)` in `init()`               | `contacts.ts:89`                        |
| **P0**   | Add `await` to `this.cleanupAvatarImages()` in `init()`         | `contacts.ts:106`                       |
| **P1**   | Fix N+1 query in `getContacts()`                                | `contacts.ts:267-295`                   |
| **P1**   | Remove hardcoded "Reinder" seed contact or make configurable    | `contacts.ts:87-103`                    |
| **P1**   | Add field length limits to `ContactSchema` and `LabelSchema`    | `routes/contacts.ts`                    |
| **P1**   | Wrap multi-step mutations in transactions                       | `contacts.ts:132-151, 165-191, 233-238` |
| **P1**   | Fix avatar column duplication (dead schema column vs JSON blob) | `schema.ts:11`                          |
| **P2**   | Translate Dutch comment to English                              | `contacts.ts:86`                        |
| **P2**   | Validate label color format in route schema                     | `routes/contacts.ts:34`                 |
| **P2**   | Add control character check to avatar filename validation       | `contacts.ts:319`                       |
| **P2**   | Remove unnecessary try/catch in `updateLabel`                   | `contacts.ts:214-231`                   |
| **P2**   | Fix race condition in `cleanupAvatarImages`                     | `contacts.ts:334-344`                   |
| **P2**   | Rename top-level `getContacts()` to avoid naming confusion      | `contacts.ts:20-23`                     |
