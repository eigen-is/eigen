# Frontend Code Review: Mail App

## Summary

The mail frontend is a compact, well-structured email client consisting of 6 component files, 4 route files, and 4
shared hooks. It follows the project's architecture patterns (AppShell, ColumnLayout, data hooks in packages/lib,
SSE handlers) and avoids direct `useQuery`/`useMutation` usage in the app layer. However, the review identified a
critical XSS vulnerability in HTML email rendering, several important issues with cache invalidation and data
integrity, and a number of minor code quality concerns.

**Files reviewed:**

- `apps/mail/src/main.tsx`
- `apps/mail/src/routes/__root.tsx`
- `apps/mail/src/routes/_auth.tsx`
- `apps/mail/src/routes/index.tsx`
- `apps/mail/src/routes/login.tsx`
- `apps/mail/src/routes/_auth.$filterType.$filterId.tsx`
- `apps/mail/src/components/mail/email-sidebar.tsx`
- `apps/mail/src/components/mail/email-list.tsx`
- `apps/mail/src/components/mail/email-detail.tsx`
- `apps/mail/src/components/mail/email-draft.tsx`
- `apps/mail/src/components/mail/email-compose-button.tsx`
- `apps/mail/src/components/mail/email-context-menu.tsx`
- `apps/mail/css/globals.css`
- `packages/lib/src/core/mail/hooks/use-emails.ts`
- `packages/lib/src/core/mail/hooks/use-mailboxes.ts`
- `packages/lib/src/core/mail/hooks/use-draft.ts`
- `packages/lib/src/core/mail/sse-handlers.ts`
- `packages/lib/src/types/mail.ts`
- `packages/ui/src/components/layout/shadow-content.tsx`

---

## Architecture Compliance

| Rule                                                     | Status  | Notes                                                                    |
|----------------------------------------------------------|---------|--------------------------------------------------------------------------|
| No direct `useQuery`/`useMutation` in app code           | PASS    | All data access goes through `@workspace/lib/mail` hooks                 |
| Data hooks in `packages/lib/src/core/mail/hooks/`        | PASS    | `use-emails.ts`, `use-mailboxes.ts`, `use-draft.ts`                     |
| SSE handlers with proper invalidation                    | PARTIAL | `MAIL_SENT` handler is a no-op; draft mutations lack `onSuccess`         |
| AppShell + ColumnLayout                                  | PASS    | `__root.tsx` uses AppShell; route uses ColumnLayout with proper columns  |
| `_auth.tsx` guard                                        | PASS    | Redirects to `/login` when unauthenticated                               |
| `type` over `interface`                                  | PARTIAL | Multiple `interface` declarations in app code (see Minor section)        |
| No JSDoc                                                 | FAIL    | `email-draft.tsx` line 13-16 has a JSDoc block on `getEmailDraftStatus`  |
| English everywhere                                       | PASS    |                                                                          |
| Imports from `@workspace/lib` and `@workspace/ui`        | PASS    | No deep relative paths crossing package boundaries                       |

---

## Issues Found

### Critical

#### 1. XSS vulnerability in HTML email rendering

**File:** `packages/ui/src/components/layout/shadow-content.tsx`, line 51

The `ShadowContent` component renders email HTML by assigning raw HTML directly to a DOM element inside a closed
Shadow DOM. While Shadow DOM provides style isolation, it does **not** prevent script execution. A malicious email
containing `<script>`, `<img onerror="...">`, `<svg onload="...">`, or `<a href="javascript:...">` payloads will
execute in the context of the app, with full access to cookies, the DOM, and the Eden Treaty API client (which uses
`credentials: 'include'`).

**Impact:** Full account compromise. An attacker can send a crafted email that, when opened, steals the session,
reads all mail, or performs actions as the user.

**Used at:** `apps/mail/src/components/mail/email-detail.tsx`, line 265-269

**Recommendation:** Sanitize HTML before inserting it into the Shadow DOM. Use DOMPurify or the browser's
Sanitizer API. Also strip `<meta http-equiv="refresh">` tags which can auto-redirect the user. Consider adding
CSP headers as defense-in-depth.

---

### Important

#### 2. Mutable data outside React state

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx`, line 62-63

```typescript
const selectedEmailInData = emails.find(m => m.id === selectedEmail?.id);
if (selectedEmailInData) selectedEmailInData.isRead = true;
```

This directly mutates an object inside TanStack Query's cache. React Query expects cached data to be immutable.
This mutation happens on every render, silently marking the local cache entry as read even before the server
responds. This can cause:

- The "unread" styling to disappear before the mark-as-read API call succeeds
- Stale data if the mutation fails
- Inconsistency with other components reading the same cache entry

**Recommendation:** Remove this mutation. The `EmailDetail` component already calls `toggleMailRead` via
`useEffect` (line 141-146), which correctly goes through the mutation path. Let the query invalidation from
`onSuccess` handle the UI update.

#### 3. Draft mutations lack `onSuccess` cache invalidation

**File:** `packages/lib/src/core/mail/hooks/use-draft.ts`, lines 46-62

Both `useUpdateDraft` and `useSendDraft` have no `onSuccess` callback. After saving or sending a draft, the Drafts
mailbox list and the detail cache are not invalidated. The user must wait for SSE events (if they arrive) or
manually refresh to see changes. This is inconsistent with all other mail mutations (`useDeleteEmail`,
`useMoveEmail`, `useToggleReadEmail`) which perform immediate cache invalidation in their `onSuccess` handlers.

**Recommendation:** Add `onSuccess` callbacks that call `invalidateDraftUpdated` for draft saves, and invalidate
both the Drafts and Sent lists for sends.

#### 4. `MAIL_SENT` SSE handler is a no-op

**File:** `packages/lib/src/core/mail/sse-handlers.ts`, lines 60-61

```typescript
case SSEventType.MAIL_SENT:
    return true;
```

The handler returns `true` (claiming it handled the event) but does nothing. After sending an email, the Sent
mailbox and Drafts mailbox caches are never invalidated via SSE. Combined with issue #3, the Sent folder will not
update until the user navigates away and back.

**Recommendation:** Add invalidation for the Sent and Drafts lists, mailboxes, and home size.

#### 5. No email address validation before sending

**File:** `apps/mail/src/components/mail/email-draft.tsx`, lines 177-201

The send handler only checks that the `to` field is non-empty (line 181). There is no validation that the
addresses are syntactically valid email addresses. Invalid addresses like `foo`, `@bar`, or `hello world` will
be sent to the server. The `getEmailDraftStatus` function (lines 16-32) exists but its usage is commented out at
line 88.

Additionally, the `convertStringToEmailAddressArray` parser (lines 133-152) is fragile: it splits on `<` which
will break for addresses without angle brackets that contain spaces, and does not handle quoted display names
(e.g., `"Doe, John" <john@example.com>` splits incorrectly on the comma).

**Recommendation:** Add basic email validation (regex or use a validation library) before submission. Re-enable
and use `getEmailDraftStatus`. Consider using the same validation on Cc/Bcc fields.

#### 6. `error` prop accepted but never rendered in `EmailList`

**File:** `apps/mail/src/components/mail/email-list.tsx`, line 36 and 48-63

The `EmailList` component accepts an `error?: Error | null` prop but never uses it. When `useEmails` returns an
error, the list shows an empty state ("No emails found.") instead of an error message. The user has no way to
know that fetching failed.

**Recommendation:** Add an error state before the loading check that displays a user-visible error message.

#### 7. Unsafe `as any` type cast on API path

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts`, line 23

```typescript
const response = await (mailApi({ownerId}).mailbox as any)[path].get();
```

This bypasses Eden Treaty's type safety entirely. A typo in the path or a change in the API route structure will
not produce a compile-time error, only a runtime 404. This is the only place in the mail hooks that uses `as any`.

**Recommendation:** If the Elysia route uses a wildcard (`/*`), use the Eden Treaty wildcard accessor or
restructure the API to use a query parameter instead of a path segment.

#### 8. Sequential operations where parallel would be faster

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx`

Multiple handlers process items sequentially with `for...of` + `await`:

- `handleDeleteEmailsByIds` (line 127): deletes emails one at a time
- `handleMoveEmailsToFolderByIds` (line 136): moves emails one at a time
- `handleArchiveEmailsByIds` (line 144): archives emails one at a time
- `handleReportSpamByIds` (line 153): reports spam one at a time
- `handleMoveByDrop` in `__root.tsx` (line 31): moves emails one at a time

For bulk operations, this is N sequential network round-trips. Each operation also triggers its own cache
invalidation, causing N refetches.

**Recommendation:** Use `Promise.all` or implement batch API endpoints. At minimum, defer cache invalidation
until all operations complete.

---

### Minor

#### 9. `useMemo` dependency array missing `isLoading` and `error` in sidebar

**File:** `apps/mail/src/components/mail/email-sidebar.tsx`, line 146

```typescript
}, [mailboxes]);
```

The memoized value also depends on `isLoading` and `error` (used at line 134 to decide whether to show
`defaultMailboxes`), but these are not in the dependency array. If the loading state changes but the `mailboxes`
reference doesn't, the memo will return stale data.

**Recommendation:** Change to `}, [mailboxes, isLoading, error]);`

#### 10. `interface` used instead of `type` (8 instances)

Per project rules, `type` is preferred over `interface`. The following files use `interface`:

- `apps/mail/src/routes/__root.tsx:7` -- `interface MyRouterContext`
- `apps/mail/src/components/mail/email-sidebar.tsx:85` -- `interface AppSidebarProps`
- `apps/mail/src/components/mail/email-compose-button.tsx:8` -- `interface EmailComposeButtonProps`
- `apps/mail/src/components/mail/email-context-menu.tsx:15` -- `interface EmailContextMenuProps`
- `apps/mail/src/components/mail/email-detail.tsx:16` -- `interface EmailDetailToolbarProps`
- `apps/mail/src/components/mail/email-detail.tsx:108` -- `interface EmailDetailProps`
- `apps/mail/src/components/mail/email-list.tsx:13` -- `interface EmailListToolbarProps`
- `apps/mail/src/components/mail/email-list.tsx:30` -- `interface EmailListProps`
- `apps/mail/src/components/mail/email-draft.tsx:60` -- `interface EmailDraftProps`

Note: `interface` in `routeTree.gen.ts` and `main.tsx` (module augmentation) is correct since `interface` is
required for declaration merging.

#### 11. JSDoc comment violates project rules

**File:** `apps/mail/src/components/mail/email-draft.tsx`, lines 13-16

The `getEmailDraftStatus` function has a JSDoc block. CLAUDE.md explicitly states "No JSDoc -- code should be
self-documenting, minimal comments."

#### 12. Missing React `key` props in `formatContactObject`

**File:** `apps/mail/src/components/mail/email-detail.tsx`, line 186-188

Fragments inside `.map()` lack a `key` prop. React will issue a console warning. Use
`<React.Fragment key={address.address}>` or `<span key={...}>`.

#### 13. Dead/commented-out code

**File:** `apps/mail/src/components/mail/email-sidebar.tsx`, lines 194-224

Roughly 30 lines of commented-out code for custom mailboxes and a "New Folder" button. This should either be
implemented or removed. Similarly, `getEmailDraftStatus` in `email-draft.tsx` is defined (lines 16-32) but its
usage is commented out at line 88.

#### 14. `useToggleFlaggedEmail` hook exported but unused

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts`, lines 112-129

The `useToggleFlaggedEmail` hook is defined and exported but never imported anywhere in the mail app. It is either
dead code or planned functionality that was never wired up (no "star" or "flag" toggle exists in the UI).

#### 15. Content-Disposition header injection in API route

**File:** `apps/api/src/routes/mail.ts`, line 129

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${params.fileName}"`;
```

The filename is taken directly from the URL parameter without sanitization. While the route parameter comes from
`encodeURIComponent` on the client side, a direct API request with a crafted filename containing `"` or newlines
could inject headers. Use proper RFC 5987 encoding or strip dangerous characters server-side.

Similarly at line 48 with `params.id`.

#### 16. Hardcoded `'unknown@example.com'` fallback

**File:** `apps/mail/src/components/mail/email-detail.tsx`, line 158

```typescript
const fromEmail = firstFrom?.address || 'unknown@example.com';
```

This fallback is misleading -- `example.com` is a real reserved domain but the address appears clickable via
`UserItem`. A user might attempt to reply to this fake address. Consider using a clearly fake placeholder or
hiding the email display entirely when unknown.

#### 17. Inconsistent variable naming

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx`, line 57

```typescript
const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
```

The error variable is named `isEmailsError` (boolean-like prefix `is`) but it is actually an `Error | null`
object. This is misleading. Should be `emailsError`.

---

## UX/UI Quality

| Aspect                       | Assessment                                                                               |
|------------------------------|------------------------------------------------------------------------------------------|
| Loading states               | Good -- EigenLoader shown for mailbox list and email list                                |
| Error states                 | Poor -- `error` prop accepted but never displayed (issue #6)                             |
| Empty states                 | Good -- "No emails found" and "Select an email to view details" messages shown           |
| Mobile responsiveness        | Good -- ColumnLayout with `mobileColumn` switch; sidebar collapses properly              |
| Keyboard navigation          | Good -- `useKeyboardListNavigation` wired up on the email list                           |
| Drag and drop                | Good -- `useListDrag` and `DroppableSidebarItem` for moving emails between folders       |
| Context menu                 | Good -- right-click menu with reply, forward, archive, spam, delete, move, download      |
| Delete confirmation          | Good -- permanent delete (from Trash) requires confirmation dialog; soft delete does not  |
| Compose flow                 | Adequate -- basic To/Cc/Bcc/Subject/Body; no rich text editor, no attachment support     |
| Contact autosuggest          | Good -- uses `ContactAutosuggest` component for address fields                           |
| Mark-as-read                 | Good -- automatic on open via `useEffect` with dedup ref                                 |
| Reply/Forward                | Adequate -- text-only quoting; no HTML quote preservation                                |
| Print                        | Present in toolbar dropdown via `printDocument()`                                        |
| Search                       | Client-side only (filters already-loaded emails by subject/from/text); no server search  |

---

## Recommendations

1. **Immediately** add HTML sanitization to `ShadowContent` (or create a mail-specific wrapper that sanitizes
   before passing to `ShadowContent`). This is the most pressing security concern.

2. **Add `onSuccess` handlers** to `useUpdateDraft` and `useSendDraft`, and implement proper invalidation in the
   `MAIL_SENT` SSE handler. This will fix the stale UI after send/save operations.

3. **Remove the direct cache mutation** at `_auth.$filterType.$filterId.tsx:62-63`. The existing
   `toggleMailRead` mechanism handles this correctly.

4. **Add error state rendering** to `EmailList` so users know when fetching fails.

5. **Add basic email validation** before sending. Re-enable and use `getEmailDraftStatus` or implement equivalent
   validation inline.

6. **Consider batch API endpoints** for bulk operations (delete, move, archive, spam) to avoid N sequential
   round-trips and N cache invalidations.

7. **Clean up dead code** -- remove commented-out sidebar sections, unused `getEmailDraftStatus`, and either
   wire up `useToggleFlaggedEmail` or remove it.

8. **Convert `interface` to `type`** across all component files to match project conventions.

9. **Fix the `useMemo` dependency array** in `email-sidebar.tsx` to include `isLoading` and `error`.

10. **Add `key` props** to the mapped fragments in `formatContactObject`.
