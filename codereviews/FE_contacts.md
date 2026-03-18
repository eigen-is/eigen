# Frontend Code Review: Contacts App

## Summary

The Contacts app is a well-structured two-column list/detail layout with label management, drag-and-drop label
assignment, search, sorting, and avatar upload. It follows most Eigen patterns correctly. The main concerns are: Dutch
comments leaking into the label hooks, duplicated mutation hooks instantiated but unused in the edit form, some missing
error feedback for users, and a few avatar-upload edge cases.

Total files reviewed: 13 app source files, 5 packages/lib hook/handler files, 2 type files.

## Architecture Compliance

### Hooks usage -- PASS
All data fetching uses hooks from `packages/lib/src/core/contacts/hooks/` (`useContacts`, `useLabels`,
`useAddContact`, `useUpdateContact`, `useDeleteContact`, `useAddLabel`, `useUpdateLabel`, `useDeleteLabel`). No direct
`useQuery` / `useMutation` calls exist inside any `apps/contacts/` component.

### Query keys -- PASS
`contactKeys` and `labelKeys` in the hooks files follow the hierarchical pattern documented in CONTRIBUTING.md.
Invalidation functions are exported and reused by SSE handlers.

### SSE handlers -- PASS
`packages/lib/src/core/contacts/sse-handlers.ts` handles all six relevant event types and delegates to the exported
invalidation functions.

### Layout -- PASS
`AppShell`, `ColumnLayout`, `Column`, `Toolbar` are used correctly. The `mobileColumn` prop switches between `"list"`
and `"detail"` based on `contactId`, and `onBack` is wired for mobile navigation.

### Route guards -- PASS
`_auth.tsx` correctly redirects unauthenticated users. The index route redirects to `/$filterType/$filterId` with
defaults.

### Validation -- PARTIAL
The edit form uses `zod` + `react-hook-form` for validation. However, the validation schema is defined locally in
`contact-edit.tsx` rather than in `packages/lib/src/validation/`, so it cannot be reused on the backend.

## Issues Found

### Critical

None.

### Important

**I1. Unused mutation hooks in `contact-edit.tsx` (line 84-85)**
`ContactEdit` instantiates `useAddContact()` and `useUpdateContact()` internally, but the actual save logic is handled
by the `onSave` prop passed from the parent route. These hooks are only used for their `isPending` state (line 123),
but because `onSave` calls its own copy of the same mutations, the `isPending` state here will always be `false` during
an active save -- the pending state belongs to the parent's mutation instance, not this one. Result: the "Saving..."
button text on line 659 never appears.

File: `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 84-85, 123, 658-659.

Fix: Remove the internal mutation hooks. Instead, accept an `isLoading` prop from the parent, or let the parent's
`onSave` return a promise that the form awaits (which it already does), and use the form's own `isSubmitting` state.

**I2. Avatar upload double-response handling (lines 167-189)**
The `uploadWithProgress` helper's `onSuccess` callback on line 176-178 calls `setAvatar(response)` with the raw
response string. Then, lines 186-188 *also* check `response.ok` and call `setAvatar(responseData)`. If
`uploadWithProgress` calls `onSuccess` *and* returns the response object, `setAvatar` is called twice with potentially
different values (the raw string from the progress callback vs the parsed text body). If the helper already consumes
the body in its callback, the second `.text()` call may fail or return empty.

File: `apps/contacts/src/components/contacts/contact-edit.tsx`, lines 166-194.

Fix: Pick one response-handling path. Either handle the avatar URL in `onSuccess` and skip the `response.ok` branch,
or remove the `onSuccess` callback and handle everything via the response object.

**I3. Batch delete fires mutations without awaiting (line 129)**
In `_auth.$filterType.$filterId.tsx` line 129, the `onDelete` callback fires `handleDeleteContact` in a `for` loop
without `await`. Each call triggers a navigation attempt. With multiple selected contacts, this fires N parallel
mutations and N sequential navigations, which may produce race conditions.

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, line 129.

Fix: Collect all delete promises and `await Promise.all(...)`, then navigate once.

**I4. Batch label toggle fires mutations without awaiting (lines 132-147)**
Same pattern as I3. `updateContact.mutate()` (not `mutateAsync`) is called in a tight loop. With many selected
contacts, this produces a burst of parallel mutations with no error handling for individual failures.

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx`, lines 132-147.

**I5. Dutch comment in label hooks (line 8)**
`packages/lib/src/core/contacts/hooks/use-labels.ts` line 8 reads:
```
// Definieer query keys voor hergebruik
```
This violates the "English everywhere" rule in CLAUDE.md.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts`, line 8.

### Minor

**M1. Hardcoded `en-US` locale for birthday formatting**
`contact-detail.tsx` line 149 hardcodes `'en-US'` for `Intl.DateTimeFormat`. The calendar app uses just `'en'`, and
there is no shared date-formatting utility. Consider unifying date formatting across apps.

File: `apps/contacts/src/components/contacts/contact-detail.tsx`, line 149.

**M2. `filterType` fallback inconsistency: `'filter'` vs `'book'`**
`contact-detail.tsx` lines 39, 84 fall back to `filterType || 'filter'`, while the app's index route and sidebar use
`'book'` as the default filter type. A broken link could route users to a `/filter/all` path that shows no contacts.

File: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 39, 84.

**M3. `formatPhoneNumber` is a no-op stub**
The function on line 127-129 of `contact-detail.tsx` returns the raw string with a `// You might want to add formatting
logic here` comment. This is dead code.

File: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 127-129.

**M4. Empty-email entries render as clickable links**
The email validation schema allows `z.string().length(0)`, meaning the form can submit `[""]`. The detail view then
renders an empty `<a>` tag that is visually invisible but receives focus and click events.

File: `apps/contacts/src/components/contacts/contact-edit.tsx`, line 32 (schema);
`apps/contacts/src/components/contacts/contact-detail.tsx`, lines 213-219 (render).

**M5. DeleteDialog in `contact-detail.tsx` is declared but never triggered**
The `ContactDetail` component has a `deleteDialogOpen` state and a `DeleteDialog` component (lines 114, 296-304), but
nothing sets `deleteDialogOpen` to `true`. The actual delete button is on the toolbar, which calls `onDeleteClick`
directly without confirmation. The dialog is dead code.

File: `apps/contacts/src/components/contacts/contact-detail.tsx`, lines 114, 296-304.

**M6. `as Contact` type assertions bypass type checking**
Multiple places cast data with `as Contact` (e.g., `_auth.$filterType.$filterId.tsx` lines 139, 142;
`_auth.edit.$filterType.$filterId.tsx` line 60). This suppresses type errors that would catch missing fields.

**M7. Form validation schema allows saving contacts with no email**
`formSchema` requires `z.array(z.string().email().or(z.string().length(0)))` for email, but does not enforce that at
least one valid email is present. The `FormLabel` marks email as required with a `*`, but the schema does not enforce it.

File: `apps/contacts/src/components/contacts/contact-edit.tsx`, line 32.

**M8. `useLabels()` as any cast**
`use-labels.ts` lines 40 and 57 use `as any` casts on the API request body, which disables type safety for the label
create/update payloads.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts`, lines 40, 57.

## UX/UI Quality

**Good:**
- Alphabetical grouping with letter headers is a nice touch.
- Context menu supports multi-select with label toggle.
- Keyboard navigation and drag-and-drop for label assignment work well.
- Loading and error states are properly handled in the list and sidebar.
- Avatar upload with progress indicator and remove option.
- Print support via toolbar.

**Needs attention:**
- No toast notification on successful contact save, delete, or label change -- the user only sees navigation.
- No optimistic updates -- after save, the user waits for the query cache to invalidate and refetch.
- The edit form has no unsaved-changes warning; navigating away silently discards edits.
- The "Frequent" and "Recent" sidebar items (lines 53-67 of `contacts-sidebar.tsx`) route to `book/frequent` and
  `book/recent`, but there is no server-side or client-side logic to actually filter by frequency or recency. These
  likely show the full contact list.

## Recommendations

1. **Move the form schema** to `packages/lib/src/validation/contact.ts` so it can be shared with the backend.
2. **Fix the `isPending` tracking** in `contact-edit.tsx` by removing the unused mutation hooks and relying on
   `form.formState.isSubmitting` or a prop from the parent.
3. **Add toast notifications** for successful saves and deletes using the shared Toaster.
4. **Add unsaved-changes guard** on the edit form, using `beforeLoad` or a `window.onbeforeunload` handler.
5. **Implement "Frequent" and "Recent" filtering** or remove the sidebar items to avoid misleading the user.
6. **Fix the batch delete/label-toggle race conditions** by collecting promises and awaiting them.
7. **Translate the Dutch comment** in `use-labels.ts`.
8. **Clean up dead code**: the `deleteDialogOpen` state in `ContactDetail`, the `formatPhoneNumber` stub.
