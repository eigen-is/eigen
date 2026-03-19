# Backend Review: Contacts

**Scope:** `apps/api/src/lib/contacts/`, `apps/api/src/routes/contacts.ts`, `apps/api/src/test/contacts.test.ts`
**Reviewed:** 2026-03-19

---

## Architecture Overview

The contacts domain is a compact backend module consisting of four files in `apps/api/src/lib/contacts/` and one route
file at `apps/api/src/routes/contacts.ts`. It manages per-user contact storage with a label (tag) system, avatar image
uploads, and a special self-contact ("me") tied to the authenticated user.

**Files:**

| File                                      | Purpose                                                                      |
|-------------------------------------------|------------------------------------------------------------------------------|
| `apps/api/src/lib/contacts/contacts.ts`   | `Contacts` class -- all business logic (CRUD, avatars, labels, self-contact) |
| `apps/api/src/lib/contacts/schema.ts`     | Drizzle ORM schema: `contacts`, `labels`, `contactsToLabels` junction table  |
| `apps/api/src/lib/contacts/db-config.ts`  | `CONTACTS_DB_CONFIG` with version 1 migration creating all three tables      |
| `apps/api/src/lib/contacts/sse-events.ts` | SSE event builders for contact and label CRUD notifications                  |
| `apps/api/src/routes/contacts.ts`         | Elysia router -- thin layer delegating to `Contacts` class methods           |
| `apps/api/src/test/contacts.test.ts`      | Integration tests for CRUD, cross-user isolation, spoofing, me endpoint      |

**Architecture compliance:** The domain follows the project's standard patterns well. The `Contacts` class is owned by
`Home` (instantiated in `UserHome` constructor at `apps/api/src/lib/home/user-home.ts:22`). Database access uses
`ManagedDatabase` via `home.getLocalDatabase()` with versioned migrations in `CONTACTS_DB_CONFIG`. Routes use
`{auth: true}` for all endpoints. SSE event builders follow the template pattern used by other domains.

**Data model:** Contacts are stored in a per-user SQLite database at `data/home/{userId}/eigen.contacts/contacts.db`.
The schema uses a hybrid approach: core fields (`firstName`, `lastName`, `eigenId`) are top-level columns, while
extended fields (`email`, `phone`, `company`, `jobTitle`, `address`, `birthday`, `notes`, `avatar`) are stored as a
JSON blob in the `data` column. Labels are a separate table with a many-to-many junction table.

**Self-contact:** On init, the `Contacts` class creates a contact entry for the authenticated user (the "me" contact),
identified by `eigenId` matching `user.id`. The `/me` endpoint returns this contact. Updating the self-contact also
syncs name and avatar to the auth database via `updateUser()`.

**Label system:** Four default labels (Family, Friends, Work, Important) are seeded on first init. Labels have a
name and color. The `contactsToLabels` junction table links contacts to labels with cascade deletes in both directions.

**Avatar handling:** Avatars are uploaded, resized to 512px WebP via `sharp`, and stored in
`{homeDir}/eigen.contacts/avatars/{uuid}.webp`. The URL pattern returned is
`contacts/{userId}/avatar/{filename}`. A cleanup routine on init removes orphaned avatar files.

---

## Critical Issues

No critical issues found. The core data paths are correct, authentication is enforced on all routes, and path traversal
is guarded.

---

## Important Issues

### 1. Avatar stored in JSON `data` contradicts schema type; dedicated `avatar` column is always NULL

**File:** `apps/api/src/lib/contacts/schema.ts:11-12`
**File:** `apps/api/src/lib/contacts/contacts.ts:29-44, 136-144, 177-184`

The schema declares `avatar` as both a dedicated column (line 11) and explicitly excludes it from the JSON `data` type:

```typescript
avatar: text('avatar'),
data: text('data', {mode: 'json'}).$type<Omit<Contact, 'id' | 'firstName' | 'lastName' | 'eigenId' | 'labels' | 'avatar'>>(),
```

Despite the type exclusion, `extractContactData` (line 40) includes `avatar` in the `data` JSON object. Neither
`addContact` nor `updateContact` ever sets the dedicated `avatar` column. When reading contacts back,
`getContactById` and `getContacts` spread the JSON `data` over the result, so the avatar value comes from the JSON
blob at runtime -- not the column.

**Impact:** The `avatar` column is always `NULL`. The TypeScript type for `data` says it does not contain `avatar`, but
at runtime it does. Any direct SQL query filtering or sorting by the `avatar` column would find nothing. The type
disagreement means TypeScript cannot catch bugs related to avatar data flow.

**Fix:** Either (a) remove the `avatar` column from the schema and the type exclusion, storing it only in the JSON blob,
or (b) populate the column during insert/update and remove it from `extractContactData`'s JSON output. Option (a) is
simpler since the column is unused.

### 2. `ownerId` route parameter is ignored -- no authorization scoping

**File:** `apps/api/src/routes/contacts.ts`, all routes
**File:** `apps/api/src/lib/contacts/contacts.ts:20-23`

Every route includes `:ownerId` in the path (e.g., `/contacts/:ownerId/contacts`), but no handler reads
`params.ownerId`.
The `getContacts(user)` helper at line 20-23 always resolves the Home for `user.id`:

```typescript
export async function getContacts(user: User) {
    const home = await getHome(user.id);
    return home.contacts;
}
```

A user can supply any `ownerId` in the URL and always gets their own data. This is confirmed by the test at
`contacts.test.ts:189-202` ("ownerId spoofing still returns Bob contacts for Bob token").

Per CLAUDE.md: "Every authenticated route must include `:ownerId` as the second path segment" and "Routes must validate
that the caller has access to the specified ownerId." Other domains (calendar, chat, drive) actually use
`params.ownerId`
to resolve the correct Home and validate access. The contacts domain does not.

**Impact:** Not a security vulnerability (data is not leaked to wrong users), but it breaks the architectural contract.
If contacts were ever extended to support team contacts, this would need to be rewritten. The `ownerId` parameter is
effectively decorative.

**Fix:** Change `getContacts` to accept `ownerId` and validate that the authenticated user has access to it, or document
that contacts are always user-scoped and explain the deviation.

### 3. Fire-and-forget `addContact` in `init()` -- missing `await`

**File:** `apps/api/src/lib/contacts/contacts.ts:89`

```typescript
if (reinder && reinder.id !== user.id) {
    this.addContact({           // <-- no await
        eigenId: reinder.id,
        // ...
    });
}
```

`addContact` is async (it performs database inserts and SSE emission). Without `await`, the promise is discarded. If the
insert fails, the error is silently swallowed. The `init()` method resolves before this contact is fully written, which
could cause a race if `getContacts()` is called immediately after.

**Impact:** Silent failure of seed data insertion. The Reinder contact is dev convenience (see Minor Issue #8), so the
practical impact is low, but the pattern violates the project's critical rule: "Always `await` async calls."

**Fix:** `await this.addContact({...})`.

### 4. Fire-and-forget `cleanupAvatarImages` in `init()` -- missing `await`

**File:** `apps/api/src/lib/contacts/contacts.ts:106`

```typescript
this.cleanupAvatarImages();    // <-- no await
```

`cleanupAvatarImages` is async -- it lists avatar files, fetches all contacts, compares them, and deletes orphans.
Without
`await`, the cleanup runs concurrently with whatever happens after init. If a new avatar is uploaded before cleanup
finishes, the cleanup could delete it: it reads the contacts list (which may not yet reference the new avatar URL) and
removes any file not referenced.

**Impact:** Race condition between cleanup and avatar uploads. Errors during cleanup are silently lost.

**Fix:** `await this.cleanupAvatarImages()`.

### 5. No uniqueness constraint on `eigenId` column

**File:** `apps/api/src/lib/contacts/schema.ts:10`
**File:** `apps/api/src/lib/contacts/db-config.ts:15`

The `eigenId` column has no UNIQUE constraint or index. The `getMe()` method at line 368 queries
`.where(eq(schema.contacts.eigenId, user.id)).get()` which returns the first match arbitrarily. If duplicate contacts
with the same `eigenId` exist (possible under race conditions in `addYourself`, or if a user manually adds a contact
with someone else's eigenId), the behavior is undefined.

Additionally, without an index on `eigenId`, the `getMe()` query performs a full table scan on every call.

**Impact:** Potential data integrity issue (duplicate self-contacts). Performance degrades linearly with contact count
for the `/me` endpoint.

**Fix:** Add a unique index on `eigenId` for non-empty values in the migration:
`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_eigenId ON contacts(eigenId) WHERE eigenId != ''`.

---

## Minor Issues

### 6. `deleteLabel` explicitly deletes junction rows that cascade-delete already handles

**File:** `apps/api/src/lib/contacts/contacts.ts:233-236`

```typescript
await this.db.delete(schema.labels).where(eq(schema.labels.id, id));
await this.db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.labelId, id));
```

The schema defines `ON DELETE CASCADE` on `contactsToLabels.labelId`. With `PRAGMA foreign_keys = ON` (set by
`ManagedDatabase`), deleting the label automatically cascades to the junction table. The second delete statement
operates on an already-empty set. It is harmless but misleading -- a reader might think the cascade is not working.

**Fix:** Remove the redundant delete of `contactsToLabels`.

### 7. `updateLabel` has a pointless try/catch

**File:** `apps/api/src/lib/contacts/contacts.ts:213-231`

The `catch` block at line 228-230 catches an error and immediately re-throws it without logging, wrapping, or
transforming. This is dead code that adds nesting without value.

**Fix:** Remove the try/catch.

### 8. Hardcoded developer contact seeded in `init()`

**File:** `apps/api/src/lib/contacts/contacts.ts:86-103`

Every new user gets a "Reinder Nijhoff" contact hardcoded into the init sequence. The code also contains a Dutch
comment on line 86: `// add reinder, zodat het een beetje gezellig is` (English: "add reinder, to make it a bit cozy").

Per CLAUDE.md: "English everywhere -- code, comments, docs." This seed data is developer convenience that should not
ship to production. The `getDomain()` lookup is fragile -- on instances where `reinder@{domain}` does not exist, it
quietly does nothing, but the pattern is unexpected.

**Fix:** Remove the hardcoded contact seeding, or move it to a clearly-marked dev/seed utility. Translate the comment
to English if it remains.

### 9. N+1 query pattern in `getContacts()` and `getContactById()`

**File:** `apps/api/src/lib/contacts/contacts.ts:245-250, 271-277`

For each contact, a separate query fetches label associations from the junction table. With N contacts, `getContacts()`
executes N+1 queries. For local SQLite with small contact lists, this is acceptable. For users with hundreds of
contacts,
a single JOIN query would be more efficient:

```sql
SELECT c.*, GROUP_CONCAT(cl.labelId) as labelIds
FROM contacts c LEFT JOIN contacts_to_labels cl ON c.id = cl.contactId
GROUP BY c.id
```

### 10. `downloadAvatar` returns `null` but route sends 200 with image/webp headers

**File:** `apps/api/src/routes/contacts.ts:96-106`
**File:** `apps/api/src/lib/contacts/contacts.ts:318-327`

When the avatar file does not exist, `downloadAvatar` returns `null`. The route handler then executes:

```typescript
set.headers['Content-Type'] = 'image/webp';
return new Response(data);  // data is null
```

This sends an empty 200 response with `Content-Type: image/webp`. The `catch` block only handles thrown exceptions,
not the `null` return path.

**Fix:** Check for `null` before creating the Response and return 404:

```typescript
const data = await (await getContacts(user)).downloadAvatar(params.filename);
if (!data) { set.status = 404; return null; }
```

### 11. No input validation on email, phone, birthday, or label color

**File:** `apps/api/src/routes/contacts.ts:15-35`

The route schemas accept any string for `email` (no email format check), `phone` (no phone format), `birthday` (no date
format), and `color` on `LabelSchema` (no hex color validation). While contacts are personal data and lax validation is
often acceptable, basic format checks would prevent garbage data.

### 12. `ContactSchema` accepts `id` and `eigenId` in the body for both create and update

**File:** `apps/api/src/routes/contacts.ts:16, 28`

The same `ContactSchema` is used for POST (create) and PUT (update). It includes `id: t.Optional(t.String())` and
`eigenId: t.Optional(t.String())`. For creates, `addContact` ignores the supplied `id` (generates its own UUID) and
uses `eigenId` from the body -- meaning a client could set `eigenId` to any user's ID, creating a contact that appears
to be linked to another user. For updates, `id` comes from URL params, and `eigenId` is not updated (the `updateContact`
method does not set `eigenId` in the UPDATE query). The body `id` is silently discarded in both cases.

Using separate schemas for create vs update, and restricting `eigenId` to server-set values, would be cleaner.

### 13. `updateContact` returns void; inconsistent with `updateLabel`

**File:** `apps/api/src/lib/contacts/contacts.ts:165-190`

`updateLabel` queries and returns the updated label entity. `updateContact` returns `void`. The PUT response for
contacts is an empty body; the PUT response for labels is the updated entity. This API inconsistency may confuse
frontend developers.

### 14. Spread type cast in `getContactById` / `getContacts` is overly broad

**File:** `apps/api/src/lib/contacts/contacts.ts:262, 289`

```typescript
...data as Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>,
```

The cast does not exclude `eigenId`. If the JSON `data` blob contained an `eigenId` field, it would overwrite the
`eigenId` from the line above. In practice, `extractContactData` builds the data object by explicitly listing fields
(lines 33-40) and does not include `eigenId`, so no runtime overwrite occurs. But the cast is broader than necessary --
it should also exclude `eigenId` to match the schema's type definition.

### 15. No transaction wrapping for multi-step writes

**File:** `apps/api/src/lib/contacts/contacts.ts:136-147, 177-188`

`addContact` and `updateContact` each perform a write to `contacts` followed by `setContactLabels` (which deletes then
inserts into `contactsToLabels`). These are not wrapped in a transaction. A crash between the contact write and the
label write leaves the database in an inconsistent state. For local SQLite the probability is low, but wrapping in
`this.db.transaction(async (tx) => { ... })` would be correct.

### 16. `size()` only counts avatar files, not the database

**File:** `apps/api/src/lib/contacts/contacts.ts:109-117`

The `size()` method sums only avatar file sizes. It does not include `contacts.db` itself. This method is used by the
quota system (`enforceAvatarUpload` at `apps/api/src/lib/config/enforcement.ts:47`) to check `mailAndContactsMax`.
The quota check slightly undercounts actual disk usage.

---

## Strengths

1. **Path traversal defense in `downloadAvatar`:** Line 319 explicitly rejects filenames containing `/`, `\`, or `..`
   before passing to `LocalFilesystem`. This is a two-layer defense (the filesystem class also validates paths), which
   is the correct approach per CLAUDE.md.

2. **Self-contact protection:** `deleteContact` checks `await this.you(id)` and throws `ApiError(400)` if the user
   tries to delete their own contact. `updateContact` syncs name/avatar changes to the auth database (with proper
   `await`) and ensures the user's primary email is always present.

3. **Clean SSE event system:** The `sse-events.ts` file uses a template pattern with type-safe event type narrowing.
   All six event types (contact created/updated/deleted, label created/updated/deleted) have consistent notification
   formatting.

4. **Cross-user data isolation:** Contacts are stored in per-user SQLite databases. The `getContacts(user)` helper
   always resolves via `user.id`, making it impossible for one user to access another's contacts through the API.

5. **Quota enforcement on avatar upload:** The route calls `enforceAvatarUpload(user.id, body.file.size)` before
   processing the upload, preventing quota abuse.

6. **Idempotent delete:** Deleting a non-existent contact returns 200 (confirmed by test at line 96-100), which is
   correct REST semantics.

---

## Test Coverage Analysis

**File:** `apps/api/src/test/contacts.test.ts`

The test suite covers the following scenarios well:

| Scenario                                    | Coverage                                                     |
|---------------------------------------------|--------------------------------------------------------------|
| Contact CRUD (create, read, update, delete) | Covered                                                      |
| Whitespace trimming on names                | Covered (creates with `'  Charlie  '`, verifies `'Charlie'`) |
| Label CRUD                                  | Covered                                                      |
| Cross-user isolation                        | Covered (Alice and Bob have no overlapping contact IDs)      |
| ownerId spoofing                            | Covered (Bob with Alice's ownerId still gets Bob's data)     |
| Me endpoint                                 | Covered (returns eigenId matching authenticated user)        |
| Self-delete prevention                      | Covered (400 response with error message)                    |
| Idempotent delete                           | Covered                                                      |

**Missing test coverage:**

- Avatar upload and download (including the null/404 edge case)
- Label-contact associations through the API (assigning labels to contacts, then verifying)
- Invalid input handling (non-existent contact IDs, malformed data)
- Path traversal attempts on avatar download
- The `size()` method
- Concurrent operations / race conditions
- Empty string fields vs. missing fields in contact creation
- `eigenId` spoofing (setting eigenId to another user's ID in a create request)

---

## Summary

The contacts domain is a clean, compact module that follows Eigen's architectural patterns correctly. The main issues
are: (1) the `avatar` column/JSON type mismatch, (2) the ignored `ownerId` parameter breaking the architectural
contract, (3) two missing `await` calls in `init()`, and (4) missing uniqueness on `eigenId`. None of these are
security vulnerabilities in the current code, but they represent data integrity risks and architectural debt. Test
coverage is solid for the happy path but lacks edge case testing around avatars, input validation, and error conditions.
