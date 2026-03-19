# FE Code Review: Contacts

## Summary

The Contacts frontend follows the project's layout patterns well (AppShell, ColumnLayout, Column) and correctly places
data hooks in `packages/lib`. However, it has a systemic problem: every mutation error is caught with `console.error`
and no `toast.error()` is ever shown to the user, violating CLAUDE.md's "every mutation needs error feedback" rule.
There are also hardcoded colors breaking dark mode, multiple `as Contact` type casts, missing `ownerId` in query keys,
and several `interface` declarations that should be `type`.

## Critical Issues

### 1. No user-visible error feedback on any mutation

- **Files**:
    - `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, line 45
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, line 83
    - `apps/contacts/src/routes/_auth.new.tsx`, line 52
    - `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 116, 180, 185
- **Issue**: Every error handler uses `console.error(...)` with no `toast.error()`. Users see no feedback when a
  contact save, delete, or avatar upload fails.
- **Why it matters**: CLAUDE.md explicitly requires "every mutation needs error feedback -- wrap `mutateAsync` in
  try/catch with `toast.error()`, or use the `onError` callback. Never swallow errors."
- **Suggested fix**: Replace all `console.error` in catch blocks with `toast.error("descriptive message")`. Import
  `toast` from `sonner` (the project's toast library).

### 2. Missing `ownerId` in query keys

- **File**: `packages/lib/src/core/contacts/hooks/use-contacts.ts`, lines 8-15
- **Issue**: `contactKeys` does not include `ownerId` anywhere in the key hierarchy. The keys are
  `['contacts', 'list']`, `['contacts', 'detail', id]`, etc. with no owner scoping.
- **Why it matters**: CLAUDE.md's Common Pitfalls section states: "Query keys must include `ownerId` for any
  owner-scoped data. Without it, switching between personal and team contexts serves stale cached data from the wrong
  owner." While contacts are currently personal-only, the cache would still be stale if the user logs out and logs in
  as a different user in the same browser session without a full page reload.
- **Suggested fix**: Add `ownerId` to the query key hierarchy, e.g.,
  `all: (ownerId: string) => ['contacts', ownerId] as const`.

- **File**: `packages/lib/src/core/contacts/hooks/use-labels.ts`, lines 8-14
- **Issue**: Same problem -- `labelKeys` has no `ownerId` scoping.

### 3. Hardcoded colors breaking dark mode

- **File**: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 215, 232
- **Issue**: `className="text-blue-600 hover:underline"` is used for email and phone links. This is a hardcoded Tailwind
  color that will not adapt to dark mode.
- **Why it matters**: CLAUDE.md requires "use theme tokens, not hardcoded colors."
- **Suggested fix**: Use `text-primary` or a theme-aware link color class.

- **File**: `apps/contacts/src/components/contacts/contact-detail.tsx`, line 191 and
  `apps/contacts/src/components/contacts/contact-edit.tsx`, line 307
- **Issue**: `color: '#fff'` is hardcoded as inline style for label badge text. On labels with light background
  colors, the white text may have poor contrast, and the hardcoded white ignores any dark-mode-aware theming.
- **Suggested fix**: Use a contrast-aware text color based on the label's background color, or use
  `text-primary-foreground`.

## Pattern Violations

### `interface` used instead of `type` for props

- **Files**:
    - `apps/contacts/src/routes/__root.tsx`, line 8: `interface MyRouterContext`
    - `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 23, 106: `interface ContactDetailToolbarProps`,
      `interface ContactDetailProps`
    - `apps/contacts/src/components/contacts/contacts-sidebar.tsx`, line 13: `interface ContactsSidebarProps`
    - `apps/contacts/src/components/contacts/contacts-list.tsx`, lines 27, 63: `interface ContactsListToolbarProps`,
      `interface ContactsListProps`
    - `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 56, 68: `interface ContactEditToolbarProps`,
      `interface ContactEditProps`
- **Issue**: CLAUDE.md requires "`type` over `interface` -- except when methods are needed." None of these interfaces
  have methods.
- **Suggested fix**: Convert all `interface` declarations to `type`.

### Multiple `as Contact` type casts

- **Files**:
    - `apps/contacts/src/routes/__root.tsx`, line 36
    - `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, lines 139, 144
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, line 62
- **Issue**: Spreading a contact and casting `as Contact` is needed because the `Contact` type has required fields
  (`email`, `phone`) that the spread may not guarantee. This is a type safety escape hatch.
- **Why it matters**: CLAUDE.md prohibits `as any` but the spirit of the rule also discourages unnecessary type casts.
  Eden Treaty provides end-to-end safety; these casts bypass it.
- **Suggested fix**: Ensure the mutation payload type matches what the API expects. The `useUpdateContact` hook
  destructures `{id, ...data}` from a `Contact`, so the input type should already be correct if the data is properly
  constructed.

### `as ContactFormValues & { avatar?: string | null }` cast

- **Files**:
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, line 48
    - `apps/contacts/src/routes/_auth.new.tsx`, line 30
- **Issue**: The `ContactFormValues` type (from zod schema) does not include `avatar`, so the cast adds it
  artificially. The `avatar` field is appended by the form component via local state, but never included in the zod
  schema.
- **Suggested fix**: Add `avatar` to the zod form schema so the type flows naturally without casting.

### Mutation hooks lack `onError` callbacks

- **File**: `packages/lib/src/core/contacts/hooks/use-contacts.ts` (all mutation hooks),
  `packages/lib/src/core/contacts/hooks/use-labels.ts` (all mutation hooks)
- **Issue**: None of the mutation hooks define `onError` callbacks. Per CLAUDE.md, every mutation needs error feedback.
- **Suggested fix**: Add `onError` callbacks to each mutation hook, or document that callers must use `mutateAsync`
  with try/catch + `toast.error()`.

## Security Concerns

### Avatar upload URL constructs path from potentially undefined user ID

- **File**: `apps/contacts/src/components/contacts/contact-edit.tsx`, line 166
- **Issue**: `getContactsAvatarUploadUrl(user?.id || '')` -- if `user` is somehow null, the URL will contain an empty
  string as the ownerId, making the request to `/contacts//avatar`. The route would likely 404, but the error is not
  shown to the user (only logged).
- **Why it matters**: Minor -- auth guard should prevent this, but defensive programming would be better.
- **Suggested fix**: Guard the upload handler with an early return if `!user`.

### No CSRF-like protection on avatar upload (XHR-based)

- **File**: `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 158-191
- **Issue**: The upload uses `uploadWithProgress` which makes an XHR request with `credentials: 'include'`. The
  `credentials` is sent as a header rather than the XHR credentials flag, which may not actually send cookies.
- **Why it matters**: If cookies are not sent, the upload will fail silently (auth failure). If they are sent via
  other means, this header is meaningless.
- **Suggested fix**: Verify that `uploadWithProgress` properly sends cookies. The `credentials: 'include'` should be
  an XHR option, not a header.

## Data Integrity

### Bulk delete in list fires multiple independent mutations

- **File**: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, lines 128-130
- **Issue**: `onDelete={(selectedContacts) => { for (const c of selectedContacts) handleDeleteContact(c.id); }}` --
  each delete is a separate `mutateAsync` call inside `handleDeleteContact`. If one fails, the others still proceed,
  and the `navigate` in the first successful delete redirects away.
- **Why it matters**: Partial deletes with no clear user feedback. The navigation happens on first success, not after
  all complete.
- **Suggested fix**: Await all deletes with `Promise.all()` or `Promise.allSettled()`, then navigate once.

### Bulk label toggle fires multiple independent mutations

- **File**: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, lines 131-147
- **Issue**: Each contact's label toggle calls `updateContactMutation.mutate(...)` (not `mutateAsync`). Multiple
  fire-and-forget mutations run concurrently with no coordination or error handling.
- **Why it matters**: Race conditions on cache invalidation; if any fail, no error feedback.
- **Suggested fix**: Use `mutateAsync` with `Promise.all`, add error handling.

### Same issue in `__root.tsx` label-by-drop handler

- **File**: `apps/contacts/src/routes/__root.tsx`, lines 30-39
- **Issue**: `handleAssignLabelByDrop` calls `updateContact.mutate(...)` in a loop without awaiting.
- **Suggested fix**: Same as above -- use `mutateAsync` + `Promise.all`.

### `addContactMutation.mutateAsync` return value cast

- **File**: `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, lines 64-73
- **Issue**: The result of `addContactMutation.mutateAsync(contactData)` is checked with
  `typeof result === 'object'` and cast `as Contact`. The API actually returns a string (the new contact ID), not a
  Contact object. So `typeof result === 'object'` is always false (a string is not an object), and the navigation to
  the new contact never happens.
- **Why it matters**: After creating a contact in the edit route, the user is not navigated to the new contact's
  detail view. The `newContact.id` branch is dead code.
- **Suggested fix**: The API returns a string ID. Use it directly:
  `const newId = result; navigate({...search: {contactId: newId}})`.

## Code Quality

### Duplicate empty contact template

- **Files**:
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, lines 112-120
    - `apps/contacts/src/routes/_auth.new.tsx`, lines 16-24
- **Issue**: The `emptyContact` object is defined identically in two files.
- **Suggested fix**: Extract to a shared constant.

### Duplicate save handler logic

- **Files**:
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, lines 46-85
    - `apps/contacts/src/routes/_auth.new.tsx`, lines 27-55
- **Issue**: Both routes have nearly identical `handleSave` functions with the same data transformation logic. The
  edit route has both add and update paths, making the new route redundant.
- **Suggested fix**: Consider merging the new and edit routes, or extracting the shared save logic.

### `format` imported from `date-fns` but used minimally

- **File**: `apps/contacts/src/components/contacts/contact-edit.tsx`, line 6
- **Issue**: `format` from `date-fns` is imported but only used once (line 619) to format the birthday field. The
  same could be done with native `Intl.DateTimeFormat` or a simpler helper.
- **Why it matters**: Minor bundle size concern.

### `deleteDialogOpen` state in `ContactDetail` is never set to `true`

- **File**: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 114, 296-304
- **Issue**: `deleteDialogOpen` starts as `false` and `setDeleteDialogOpen` is passed to `DeleteDialog` as
  `onOpenChange`, but nothing in the component ever calls `setDeleteDialogOpen(true)`. The delete button in the
  toolbar calls `onDeleteClick` directly (which is `handleDeleteContact`), bypassing the dialog entirely.
- **Why it matters**: The `DeleteDialog` component is rendered but can never be opened -- it is dead code. Contacts
  are deleted without confirmation.
- **Suggested fix**: Either remove the `DeleteDialog` and related state, or wire the delete button to open the dialog.

### Unused props in `ContactDetail`

- **File**: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 106-111, 113
- **Issue**: `filterType` and `filterId` are declared in `ContactDetailProps` and passed to the component but never
  used inside `ContactDetail` (the destructuring on line 113 only extracts `contact` and `onDelete`).
- **Suggested fix**: Remove unused props.

### Unused `sortBy` prop in `ContactsListToolbar`

- **File**: `apps/contacts/src/components/contacts/contacts-list.tsx`, line 34
- **Issue**: `sortBy` is destructured in the function signature but never used in the component.
- **Suggested fix**: Remove from destructuring.

### `ContactEdit` has unused `filterType` and `filterId` props

- **File**: `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 68-74, 76-80
- **Issue**: `filterType` and `filterId` are in the props type but the destructuring on line 78-80 only takes
  `contact`, `onSave`, and `onCancel`.
- **Suggested fix**: Remove unused props from the type and callers.

## Architecture

### `useContacts()` called in multiple places simultaneously

- **Files**:
    - `apps/contacts/src/routes/__root.tsx`, line 27
    - `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, line 31
    - `apps/contacts/src/components/contacts/contacts-list.tsx`, line 92
    - `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx`, line 41
- **Issue**: `useContacts()` is called in at least 4 places in the component tree at once. While TanStack Query
  deduplicates
  the actual network request, each call site independently processes the contact list. The root route fetches contacts
  to enable drag-and-drop label assignment, the list page fetches them for display, and the list component fetches
  them again internally.
- **Why it matters**: Redundant processing. The contact list could be passed down via props from a single fetch point
  or via React context.
- **Suggested fix**: Fetch contacts once at the route level and pass down as props. The `ContactsList` component
  already receives most data as props but fetches contacts internally too.

### "Frequent" and "Recent" sidebar links are non-functional

- **File**: `apps/contacts/src/components/contacts/contacts-sidebar.tsx`, lines 53-67
- **Issue**: The sidebar has links for "Frequent" and "Recent" contacts, but the `ContactsList` component
  (`contacts-list.tsx`, lines 94-103) only filters by `label` type. There is no logic to handle `book/frequent` or
  `book/recent` filters.
- **Why it matters**: Clicking these sidebar items shows all contacts, identical to "All contacts." The UI promises
  functionality that does not exist.
- **Suggested fix**: Either implement frequency/recency tracking and filtering, or remove these sidebar items until
  implemented.

### Label mutations in `main.tsx` lack error handling

- **File**: `apps/contacts/src/main.tsx`, lines 39-49
- **Issue**: The `onAddLabel`, `onUpdateLabel`, and `onDeleteLabel` callbacks call `mutateAsync` with `await` but have
  no try/catch. If the mutation fails, the error will propagate up to the `LabelProvider` which may not handle it.
- **Suggested fix**: Wrap each in try/catch with `toast.error()`.

## Positive Patterns

- **Proper use of `ColumnLayout` and `Column`** with `mobileColumn` switching based on selection state.
- **Auth guard** in `_auth.tsx` correctly redirects unauthenticated users.
- **Data hooks correctly placed** in `packages/lib/src/core/contacts/hooks/` per project convention.
- **SSE handlers** properly invalidate the right query keys for each event type.
- **Context menu, keyboard navigation, drag-and-drop, and list selection** all properly integrated using shared hooks.
- **Zod validation** for the contact form provides good client-side validation.
- **`EigenApp` provider stack** properly wraps the app.
- **Search and sort** functionality is well-implemented with `useMemo` for filtering/sorting.
- **`LabelProvider`** pattern cleanly separates label mutation concerns from the component tree.

## Recommendations

| Priority | Issue                                                             | Location                                                      |
|----------|-------------------------------------------------------------------|---------------------------------------------------------------|
| **P0**   | Add `toast.error()` to all mutation error handlers                | All routes + components                                       |
| **P0**   | Fix dead code: `addContactMutation` returns string, not Contact   | `_auth.edit.$filterType.$filterId.tsx:64-73`                  |
| **P1**   | Add `ownerId` to `contactKeys` and `labelKeys`                    | `use-contacts.ts`, `use-labels.ts`                            |
| **P1**   | Replace hardcoded `text-blue-600` with theme token                | `contact-detail.tsx:215,232`                                  |
| **P1**   | Fix bulk delete/label-toggle to use `Promise.all` + `mutateAsync` | `_auth.$filterType.$filterId.tsx:128-147`                     |
| **P1**   | Remove dead `DeleteDialog` or wire it up for confirmation         | `contact-detail.tsx:114,296-304`                              |
| **P1**   | Add error handling to label mutations in `main.tsx`               | `main.tsx:39-49`                                              |
| **P2**   | Convert `interface` to `type` for all props types                 | All component files                                           |
| **P2**   | Remove or implement "Frequent" and "Recent" filters               | `contacts-sidebar.tsx`, `contacts-list.tsx`                   |
| **P2**   | Extract shared `emptyContact` constant                            | `_auth.edit.$filterType.$filterId.tsx`, `_auth.new.tsx`       |
| **P2**   | Remove unused props (`filterType`, `filterId`, `sortBy`)          | `contact-detail.tsx`, `contact-edit.tsx`, `contacts-list.tsx` |
| **P2**   | Add `avatar` to zod form schema to eliminate cast                 | `contact-edit.tsx`                                            |
| **P2**   | Deduplicate `useContacts()` calls in component tree               | `__root.tsx`, route, list component                           |
