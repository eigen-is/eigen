# Frontend Review: Contacts App

**Scope:** `apps/contacts/`, `packages/lib/src/core/contacts/`
**Reviewed:** 2026-03-19

Files reviewed: 13 app source files (`apps/contacts/src/`), 5 library files (`packages/lib/src/core/contacts/`),
2 type files (`packages/lib/src/types/contact.ts`, `packages/lib/src/types/label.ts`),
1 upload utility (`packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx`).

---

## Architecture Overview

The contacts app is a classic list/detail layout built on TanStack Router and TanStack Query.

**Routing structure:**

- `/` redirects to `/book/all` (all contacts view)
- `/_auth` guards all authenticated routes via `beforeLoad` redirect
- `/_auth/$filterType/$filterId` -- main list+detail view with `contactId` in search params
- `/_auth/edit/$filterType/$filterId` -- edit form with `contactId` in search params
- `/_auth/new` -- new contact form

**Key components:**

- `ContactsSidebar` -- navigation (All, Frequent, Recent, label-based filtering), label management via `LabelManager`, "
  Create contact" button, storage usage
- `ContactsList` -- alphabetical grouped list with search, sort, multi-select, context menu, drag-and-drop support
- `ContactDetail` -- read-only contact display with avatar, labels, contact info, addresses, notes
- `ContactEdit` -- react-hook-form based edit form with avatar upload, dynamic email/phone/address arrays, label
  assignment, birthday picker

**Data flow:**

- All data hooks live in `packages/lib/src/core/contacts/hooks/` (contacts + labels)
- SSE handlers in `packages/lib/src/core/contacts/sse-handlers.ts` invalidate query cache on server events
- Avatar upload uses XHR via `uploadWithProgress` utility for progress tracking
- Label CRUD is wired through `LabelProvider` in `main.tsx`, exposing callbacks to the shared `LabelManager` UI
  component

**Self-contact:** The `eigenId` field on `Contact` links a contact to an Eigen user. The `hasMe` check in
`ContactsList` (line 146) prevents deleting the user's own contact record from the context menu.

---

## Critical Issues

### C1. Delete from toolbar has no confirmation -- immediate data loss

The toolbar delete button (`ContactDetailToolbar` line 55) calls `onDeleteClick` directly, which fires the delete
mutation and navigates away immediately. The `ContactDetail` component has a `DeleteDialog` (lines 296-304) and
`deleteDialogOpen` state (line 114), but `setDeleteDialogOpen(true)` is **never called anywhere**. The dialog is dead
code.

The context menu delete in `ContactsList` also has no confirmation dialog.

```typescript
// contact-detail.tsx:114 -- state declared but never set to true
const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

// contact-detail.tsx:296-304 -- dialog exists but can never open
<DeleteDialog
    open={deleteDialogOpen}
    ...
/>
```

File: `apps/contacts/src/components/contacts/contact-detail.tsx:55,114,296-304`
Impact: Single-click accidental deletes with no undo path. This is a data-loss risk since contacts are not soft-deleted.
Fix: Wire the toolbar's `onDeleteClick` to `setDeleteDialogOpen(true)` instead of calling the delete handler directly.
Add a confirmation dialog to the context menu delete as well.

---

### C2. Batch delete fires N parallel mutations with N navigations

The `onDelete` callback (line 128-129 of `_auth.$filterType.$filterId.tsx`) calls `handleDeleteContact` in a `for...of`
loop without `await`:

```typescript
onDelete={(selectedContacts) => {
    for (const c of selectedContacts) handleDeleteContact(c.id);
}}
```

`handleDeleteContact` is `async`, so all deletes fire simultaneously. Each call independently navigates away on success.
The race between parallel navigations and cache invalidations can produce stale UI or errors.

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:128-129`
Impact: Race condition on multi-select delete; multiple rapid navigations.
Fix: `await Promise.all(selectedContacts.map(c => deleteMutation.mutateAsync(c.id)))`, then navigate once.

---

### C3. Batch label toggle fires mutations in a tight loop with no error handling

The `onToggleLabel` callback (lines 131-147) calls `updateContactMutation.mutate()` (fire-and-forget, not `mutateAsync`)
in a loop. Each call fires independently with no `await`, no `Promise.all`, and no per-item error handling:

```typescript
updateContactMutation.mutate({
    ...c,
    labels: currentLabels.filter(id => id !== labelId)
} as Contact);
```

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:131-147`
Impact: Silent partial failures; mutation burst may overwhelm the API. User gets no feedback on which contacts failed.
Fix: Use `mutateAsync` with `Promise.allSettled`, report failures via toast.

---

### C4. Same fire-and-forget pattern in drag-and-drop label assignment

`handleAssignLabelByDrop` (lines 30-39 of `__root.tsx`) calls `updateContact.mutate()` in a loop for each dropped
contact:

```typescript
const handleAssignLabelByDrop = (contactIds: string[], labelId: string) => {
    for (const id of contactIds) {
        const contact = contacts.find(c => c.id === id);
        if (contact) {
            // ...
            updateContact.mutate({...contact, labels: [...currentLabels, labelId]} as Contact);
        }
    }
};
```

File: `apps/contacts/src/routes/__root.tsx:30-39`
Impact: Same as C3 -- silent partial failures on drag-and-drop label assignment.
Fix: Same as C3.

---

## Important Issues

### I1. Label mutation hooks don't check `response.error` -- API errors silently swallowed

The contact mutation hooks (`useAddContact`, `useUpdateContact`, `useDeleteContact`) all check for API errors:

```typescript
if (response.error) throw new Error(String(response.error));
```

The label mutation hooks (`useAddLabel`, `useUpdateLabel`, `useDeleteLabel`) do **not** check `response.error`. They
return `response.data` regardless. When the API returns an error, these hooks resolve with `undefined` instead of
throwing, so the `onSuccess` handler runs (invalidating cache), and no error surfaces to the caller.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts:38-44,53-62,71-77`
Impact: Label create/update/delete failures are invisible to the user. Cache invalidation runs even on failure.
Fix: Add `if (response.error) throw new Error(String(response.error));` to all three label mutation hooks.

---

### I2. Label mutation callbacks in `main.tsx` have no error handling or user feedback

The `LabelProvider` callbacks in `main.tsx` (lines 39-49) use `mutateAsync` but have no try/catch and no toast:

```typescript
const onAddLabel = useCallback(async (labelData: Omit<Label, 'id'>) => {
    await addLabelMutation.mutateAsync(labelData);
}, [addLabelMutation]);
```

If a label mutation fails, the error propagates to `LabelProvider` which may or may not handle it. Combined with I1 (
errors not thrown), label failures are completely silent.

File: `apps/contacts/src/main.tsx:39-49`
Impact: No error feedback for label operations.
Fix: Wrap each `mutateAsync` call in try/catch with `toast.error()`. Per CLAUDE.md: "Every mutation needs error
feedback."

---

### I3. No toast notifications on any contact mutation

Successful contact creates, updates, deletes, and label changes produce zero toast feedback. The user only sees
navigation. The `handleDeleteContact` in `_auth.$filterType.$filterId.tsx` catches errors with `console.error` (line 45)
but never shows a toast. `handleSave` in `_auth.edit.$filterType.$filterId.tsx` (line 83) and `_auth.new.tsx` (line 52)
also only `console.error`.

File: Multiple route files
Impact: Users have no confirmation of successful operations and no visible error messages on failure. Per CLAUDE.md: "
Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`."
Fix: Add `toast.success()` on mutation completion and `toast.error()` in catch blocks across all mutation call sites.

---

### I4. `navigate()` called directly in render body (not in useEffect)

In `_auth.edit.$filterType.$filterId.tsx` lines 103-109, when `contactId` is set but the contact is not found,
`navigate()` is called during render:

```typescript
if (contactId && !contact) {
    navigate({
        to: '/$filterType/$filterId',
        params: {filterType, filterId},
        search: {},
    });
    return null;
}
```

This is a side effect during render, violating React's rules. Compare with `_auth.$filterType.$filterId.tsx:67-75` which
correctly uses `useEffect` for the same pattern.

File: `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:103-109`
Impact: "Cannot update a component while rendering a different component" warning in development; potential infinite
re-render.
Fix: Wrap the redirect in a `useEffect`, matching the pattern in the view route.

---

### I5. "Send email" dropdown shown for contacts with only empty-string emails

The toolbar dropdown checks `contact.email && contact.email.length > 0` (line 67) before showing "Send email", but does
not check whether `email[0]` is non-empty. The form schema permits `z.string().length(0)`, so a contact can have
`email: [""]`. Clicking "Send email" calls `openWriteEmailTo("")`, navigating to mail compose with an empty recipient.

Similarly, the detail view renders empty `<a>` tags for empty-string email entries (lines 213-219).

File: `apps/contacts/src/components/contacts/contact-detail.tsx:67-73,213-219`
Impact: Broken "Send email" action; invisible but focusable empty links.
Fix: Filter out empty strings: `contact.email.filter(e => e.length > 0)`. Apply in both the toolbar guard and the detail
rendering.

---

### I6. Hardcoded `text-blue-600` color breaks dark mode

Two locations use `text-blue-600` for links:

```typescript
// contact-detail.tsx:215
<a className="text-blue-600 hover:underline" href={getMailComposeUrl(email)}>

// contact-detail.tsx:232
<a href={`tel:${phone}`} className="text-blue-600 hover:underline">
```

Per CLAUDE.md: "Use theme tokens, not hardcoded colors -- use `text-muted-foreground`, `bg-muted`, `border` etc. instead
of `text-gray-500`, `bg-blue-50`. Hardcoded colors break dark mode."

File: `apps/contacts/src/components/contacts/contact-detail.tsx:215,232`
Impact: Links are invisible or unreadable in dark mode.
Fix: Replace `text-blue-600` with `text-primary` or another theme token.

---

### I7. Query keys missing `ownerId` -- stale data when switching contexts

Neither `contactKeys` nor `labelKeys` include `ownerId`:

```typescript
export const contactKeys = {
    all: ['contacts'] as const,
    ...
};

export const labelKeys = {
    all: ['labels'] as const,
    ...
};
```

Per CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data. Without it, switching between personal and
team contexts serves stale cached data from the wrong owner."

Contacts are user-only today (no team contacts), but the missing `ownerId` in the query key means the cache is not
scoped. If contacts ever gains team support, this would be a critical bug. Even today, if a user logs out and another
logs in on the same browser session, they could see stale cached contacts from the previous user.

File: `packages/lib/src/core/contacts/hooks/use-contacts.ts:8-14`;
`packages/lib/src/core/contacts/hooks/use-labels.ts:8-14`
Impact: Potential stale data on user switch; architectural debt for team support.
Fix: Include `ownerId` in the query key hierarchy: `['contacts', ownerId, 'list']`.

---

## Minor Issues

### M1. `filterType` fallback inconsistency: `'filter'` vs `'book'`

`ContactDetailToolbar` falls back to `filterType || 'filter'` (lines 39, 84) and `ContactsList` defaults to
`filterType = 'filter'` (line 77). The index route and sidebar both use `'book'` as the default filter type. If
`filterType` is ever undefined, the edit link navigates to `/filter/all` which is not a recognized path.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:39,84`;
`apps/contacts/src/components/contacts/contacts-list.tsx:77`
Impact: Inconsistent URL paths.
Fix: Change all defaults to `'book'` to match the index route and sidebar.

---

### M2. `as Contact` type assertions used to bypass type checking in 6 places

Explicit `as Contact` casts appear in:
- `_auth.$filterType.$filterId.tsx:139,144` (label toggle)
- `_auth.edit.$filterType.$filterId.tsx:62` (update save)
- `_auth.edit.$filterType.$filterId.tsx:65` (add result cast)
- `_auth.new.tsx:30` (form data cast)
- `__root.tsx:36` (drag-and-drop label assignment)

These bypass the compiler's structural check, meaning if `Contact` gains a required field, these casts silently produce
incomplete objects.

File: Multiple (see above)
Impact: Type errors hidden at compile time.
Fix: Construct proper `Contact` objects or adjust mutation input types to accept `Partial<Contact>` where appropriate.

---

### M3. `labelKeys` root is `['labels']` instead of `['contacts', 'labels']`

The `contactKeys` root is `['contacts']`, following the domain-namespaced convention. But `labelKeys` uses `['labels']`
as its root. If another domain adds labels, query key collisions would cause cross-domain cache invalidation.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts:8-14`
Impact: Potential future query key collision across domains.
Fix: Change `all: ['labels']` to `all: ['contacts', 'labels']`.

---

### M4. `form.watch()` called 6 times in render for dynamic arrays

The email, phone, and address sections each call `form.watch("email")`, `form.watch("phone")`, `form.watch("address")`
twice per render (once for `.map()`, once for `.length > 1`). Each `form.watch()` subscribes to field changes, and any
keystroke in any field triggers a full-form re-render.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:383,400,439,456,495,499`
Impact: Unnecessary full-form re-renders on every keystroke.
Fix: Use `useFieldArray` from react-hook-form for `email`, `phone`, and `address` arrays.

---

### M5. `formatPhoneNumber` is a no-op stub

The function at lines 127-129 of `contact-detail.tsx` returns the input unchanged with a TODO-style comment:

```typescript
const formatPhoneNumber = (phone: string) => {
    return phone; // You might want to add formatting logic here
};
```

File: `apps/contacts/src/components/contacts/contact-detail.tsx:127-129`
Impact: Dead code; misleading comment.
Fix: Remove the function and use the phone value directly, or implement formatting.

---

### M6. Redundant birthday formatting: double Date construction

Line 260 constructs `new Date(contact.birthday || '')` then calls `.toISOString()`, then passes that to `formatDate()`
which constructs another `new Date(dateString)`. If `contact.birthday` is an invalid date string,
`new Date(invalid).toISOString()` throws `RangeError`.

```typescript
{formatDate(new Date(contact.birthday || '').toISOString())}
```

File: `apps/contacts/src/components/contacts/contact-detail.tsx:260`
Impact: Potential runtime crash on malformed birthday data.
Fix: Pass `contact.birthday` directly to `formatDate()` and add validity check (`isNaN(date.getTime())`).

---

### M7. Hardcoded `en-US` locale for birthday formatting

`formatDate` on line 149 uses `new Intl.DateTimeFormat('en-US', ...)`. Other parts of the project could use different
locales. There is no shared date-formatting utility.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:149`
Impact: No i18n path; inconsistency with other apps.
Fix: Use `undefined` for the browser's default locale or extract a shared `formatDate` utility in `packages/lib`.

---

### M8. `emptyContact` object duplicated in two routes

The same `emptyContact: Contact` object appears in both `_auth.new.tsx:16-24` and
`_auth.edit.$filterType.$filterId.tsx:112-120` with identical shape:

```typescript
const emptyContact: Contact = {
    id: '',
    firstName: '',
    lastName: '',
    email: [''],
    phone: [''],
    address: [{}],
    labels: [],
};
```

File: `apps/contacts/src/routes/_auth.new.tsx:16-24`;
`apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:112-120`
Impact: Maintenance burden; risk of divergence.
Fix: Extract to a shared constant.

---

### M9. Avatar handling differs between new and edit save paths

In `_auth.new.tsx:37`, avatar is `formData.avatar || undefined` (falsy coercion -- empty string becomes `undefined`).
In `_auth.edit.$filterType.$filterId.tsx:55`, avatar is `formData.avatar ?? ''` (nullish coercion -- empty string kept).

File: `apps/contacts/src/routes/_auth.new.tsx:37`;
`apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:55`
Impact: Inconsistent avatar removal behavior between new and edit flows.
Fix: Use the same coercion in both paths.

---

### M10. `onSave` prop typed as `void` return but awaited as `Promise<void>`

`ContactEditProps.onSave` type (line 70) is `(data: ContactFormValues) => void`, but all callers return `Promise<void>`.
The `handleSubmit` does `await onSave(formData)` on line 114. TypeScript allows `await`-ing `void` without error, but
the type is misleading.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:70`
Impact: Misleading type signature.
Fix: Change to `(data: ContactFormValues) => Promise<void>`.

---

### M11. Unused `filterType`/`filterId` props in `ContactEdit` and `ContactDetail`

- `ContactEdit` declares `filterType` and `filterId` in `ContactEditProps` (lines 72-73) but they are destructured away
  and never used (line 79).
- `ContactDetail` declares `filterType` and `filterId` as optional props (lines 109-110) but does not use them.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:72-73,79`;
`apps/contacts/src/components/contacts/contact-detail.tsx:109-110,113`
Impact: Dead props; misleading interface.
Fix: Remove from both prop interfaces and call sites.

---

### M12. Search does not cover phone, company, or notes

The search filter (lines 112-120 of `contacts-list.tsx`) only matches `firstName`, `lastName`, and `email`. A user
cannot find a contact by phone number or company name.

File: `apps/contacts/src/components/contacts/contacts-list.tsx:112-120`
Impact: Reduced discoverability.
Fix: Extend the filter to include `contact.phone`, `contact.company`.

---

### M13. `indexOf` called per contact inside grouped render loop -- O(n^2)

Line 194 calls `searchedContacts.indexOf(contact)` for every rendered contact. `indexOf` is O(n), making the overall
render O(n^2).

```typescript
const flatIndex = searchedContacts.indexOf(contact);
```

File: `apps/contacts/src/components/contacts/contacts-list.tsx:194`
Impact: Quadratic rendering cost; noticeable with large contact lists.
Fix: Pre-build an `id -> flatIndex` Map in the `useMemo` that produces `groupedContacts`.

---

### M14. `contact.email[0]` empty string passed to `UserItem`

In `contacts-list.tsx` line 216, `UserItem` receives `contact.email[0]` guarded only by `contact.email.length > 0`. If
`email` is `[""]`, this passes an empty string.

File: `apps/contacts/src/components/contacts/contacts-list.tsx:216`
Impact: Potential empty email display or broken avatar resolution.
Fix: Use `contact.email.find(e => e.length > 0)`.

---

### M15. `credentials: 'include'` passed as HTTP header is a no-op

The avatar upload passes `headers: { 'credentials': 'include' }` (line 168-170 of `contact-edit.tsx`), but:

1. `credentials` is a Fetch API option, not an HTTP header.
2. The `uploadWithProgress` utility receives headers as `_headers` and the header-setting code is commented out (lines
   28-30).
3. Cookie auth works via `xhr.withCredentials = true` (line 24), not via a `credentials` header.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:168-170`;
`packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx:20,28-30`
Impact: Dead code; misleading to future readers.
Fix: Remove the `headers` object from the `uploadWithProgress` call.

---

### M16. Hardcoded `color: '#fff'` on label badges

Label badges in both `contact-detail.tsx` (line 191) and `contact-edit.tsx` (line 307) use `style={{color: '#fff'}}`.
This assumes all label background colors have sufficient contrast with white text, which is not guaranteed for
light-colored labels.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:191`;
`apps/contacts/src/components/contacts/contact-edit.tsx:307`
Impact: Potentially unreadable labels with light background colors.
Fix: Compute text color based on label background luminance, or use a shared label badge component.

---

## Observations

These are not bugs but patterns worth noting for future improvement.

**O1. "Frequent" and "Recent" sidebar items are non-functional.**
The sidebar links route to `book/frequent` and `book/recent` (lines 57, 65 of `contacts-sidebar.tsx`), but
`ContactsList` only filters by `label` type (lines 97-100). The `book` filter type with these IDs shows all contacts
unfiltered. Either implement frequency/recency tracking or remove the sidebar items.

**O2. No unsaved-changes guard on the edit form.**
Navigating away from the edit form with unsaved changes silently discards them. No `beforeunload` handler or router
blocker is in place.

**O3. No optimistic updates.**
All mutations wait for server response + cache invalidation before the UI updates. For label toggles and deletes, the
user sees a brief stale state.

**O4. Form validation schema lives in the app, not in `packages/lib/src/validation/`.**
The `formSchema` in `contact-edit.tsx:27-52` cannot be reused by the backend for server-side validation. Per project
conventions, shared validation schemas belong in `packages/lib/src/validation/`.

**O5. `jobTitle` only shown in detail view when `company` is also present.**
Line 179 checks `contact.jobTitle && contact.company` -- a contact with a job title but no company will not display the
job title.

**O6. Contact `address` only checks first entry for emptiness.**
Line 266 checks `Object.keys(contact.address[0]).length > 0` but if the first address is empty and subsequent ones are
not, the entire address section is hidden.

**O7. `useContacts()` is called 4 times in the authenticated app tree.**
- `AuthenticatedContactsRoot` in `__root.tsx:27`
- `ContactsRoute` in `_auth.$filterType.$filterId.tsx:31`
- `EditContactRoute` in `_auth.edit.$filterType.$filterId.tsx:41`
- `ContactsList` in `contacts-list.tsx:92`

TanStack Query deduplicates the network request, but each instance creates a separate subscription. The root-level
call (for drag-and-drop label assignment) re-renders the entire app tree on data changes.

**O8. Print uses `data-document` on the detail view only.**
The `data-document="contact-detail"` attribute (line 161) is only on `ContactDetail`. Printing the contact list view
falls back to `window.print()` which prints the entire page.

---

## Strengths

1. **Clean list/detail layout.** The `ColumnLayout` + `Column` pattern is used correctly, with proper `mobileColumn`
   switching based on `contactId` presence and `onBack` for mobile navigation.

2. **Proper auth guard.** The `_auth.tsx` route uses `beforeLoad` to redirect unauthenticated users, following the
   project convention.

3. **Self-contact protection.** The `hasMe` check in `ContactsList` prevents users from accidentally deleting their own
   contact record via context menu.

4. **Drag-and-drop label assignment.** The `useListDrag` + `LabelManager` integration allows drag-and-drop label
   assignment from the list to the sidebar, which is a polished UX touch.

5. **SSE integration is complete.** All six event types (contact + label CRUD) have handlers that properly invalidate
   the relevant query keys.

6. **Alphabetical grouping.** The contact list groups contacts by first letter with section headers, adapting to the
   sort field (first name vs last name).

7. **Multi-select with keyboard navigation.** `useListSelection` and `useKeyboardListNavigation` provide full
   multi-select and keyboard support, matching other Eigen apps.

8. **Form save indicator works correctly.** Despite the `onSave` type mismatch (M10), `form.formState.isSubmitting`
   correctly tracks the async save because react-hook-form tracks the promise returned by the `handleSubmit` callback.
   The "Saving..." button text and disabled state function as intended.

---

## Coverage Analysis

| Feature                   | Status                                           |
|---------------------------|--------------------------------------------------|
| Contact CRUD              | Functional, but missing error feedback (I3)      |
| Label CRUD                | Functional, but errors swallowed (I1, I2)        |
| Avatar upload             | Works, minor dead code (M15)                     |
| Search                    | Works for name/email only (M12)                  |
| Sort                      | Works (first name / last name)                   |
| Label filtering           | Works                                            |
| Frequent/Recent filtering | Not implemented (O1)                             |
| Multi-select              | Works                                            |
| Drag-and-drop labels      | Works, fire-and-forget errors (C4)               |
| Context menu              | Works, missing delete confirmation               |
| Keyboard navigation       | Works                                            |
| SSE real-time updates     | Complete                                         |
| Delete confirmation       | **Broken** -- dialog exists but never opens (C1) |
| Toast feedback            | **Missing** entirely (I3)                        |
| Dark mode                 | Broken for links (I6)                            |
| Mobile responsive         | Correct `ColumnLayout` usage                     |

---

## Key Files

| File                                                            | Description                              |
|-----------------------------------------------------------------|------------------------------------------|
| `apps/contacts/src/main.tsx`                                    | App entry, LabelProvider wiring          |
| `apps/contacts/src/routes/__root.tsx`                           | Root layout, drag-and-drop label handler |
| `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`      | Main list+detail route                   |
| `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx` | Edit contact route                       |
| `apps/contacts/src/routes/_auth.new.tsx`                        | New contact route                        |
| `apps/contacts/src/components/contacts/contact-detail.tsx`      | Detail view + toolbar                    |
| `apps/contacts/src/components/contacts/contact-edit.tsx`        | Edit form + avatar upload                |
| `apps/contacts/src/components/contacts/contacts-list.tsx`       | Contact list + context menu              |
| `apps/contacts/src/components/contacts/contacts-sidebar.tsx`    | Sidebar navigation                       |
| `packages/lib/src/core/contacts/hooks/use-contacts.ts`          | Contact query/mutation hooks             |
| `packages/lib/src/core/contacts/hooks/use-labels.ts`            | Label query/mutation hooks               |
| `packages/lib/src/core/contacts/sse-handlers.ts`                | SSE event handlers                       |
| `packages/lib/src/types/contact.ts`                             | Contact type definition                  |
| `packages/lib/src/types/label.ts`                               | Label type definition                    |
