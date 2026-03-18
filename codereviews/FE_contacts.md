# Frontend Review: Contacts App

**Scope:** `apps/contacts/`, `packages/lib/src/core/contacts/`
**Reviewed:** 2026-03-18

Files reviewed: 13 app source files (`apps/contacts/src/`), 5 library files (`packages/lib/src/core/contacts/`),
1 type file (`packages/lib/src/types/contact.ts`), 1 upload utility (`packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx`).

---

## Critical Issues

**C1. Saving indicator never activates -- user gets no feedback during save**

`ContactEdit` instantiates its own `useAddContact()` and `useUpdateContact()` hooks (lines 84-85) and derives
`isLoading` from their `isPending` state (line 123). However, the actual mutation is performed by the *parent* route's
mutation instance via the `onSave` prop. Because TanStack Query mutation state is per-instance, the component's
`isPending` will always be `false` while a save is in progress. The "Saving..." button text (line 659) never appears, and
the Cancel/Save buttons remain enabled during the network request, allowing double-submission.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:84-85,123,658-659`
Impact: Users can double-submit the form. No visual save-in-progress feedback.
Fix: Remove the internal mutation hooks entirely. Use `form.formState.isSubmitting` (which tracks the `handleSubmit`
promise), or accept an `isPending` prop from the parent. Change `onSave` type from `(data: ContactFormValues) => void`
to `(data: ContactFormValues) => Promise<void>` (line 70) to match reality.
Status: Carried forward from previous review (I1), upgraded to Critical because it enables double-submission.

---

**C2. Avatar upload calls `setAvatar` twice with different values**

The `uploadWithProgress` utility resolves its promise with a `new Response(xhr.response, ...)` *after* calling the
`onSuccess` callback with `xhr.response` (the raw string). In `contact-edit.tsx`, the `onSuccess` callback (line 176-178)
calls `setAvatar(response)` with the raw XHR response string. Then lines 186-188 check `response.ok` on the
resolved `Response` object and call `setAvatar(await response.text())`. Since the `Response` body is constructed from
the same `xhr.response` string, `response.text()` returns the same value. But:
- `setAvatar` is called twice per successful upload, causing a redundant re-render.
- If the `onSuccess` callback or the XHR response format ever changes, the two paths diverge silently.
- The `Response` constructor wraps `xhr.response` (which for XHR is a string by default), so `response.text()` works,
  but the intent is unclear and fragile.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:166-194`
Impact: Double state update; fragile contract with upload utility.
Fix: Remove the `onSuccess` callback and handle the avatar URL solely via the resolved `Response`, or remove the
`response.ok` block and handle everything in `onSuccess`. One path, not two.
Status: Carried forward from previous review (I2), upgraded to Critical because the double-set is confirmed by reading
the `uploadWithProgress` source.

---

## Important Issues

**I1. Batch delete fires N parallel mutations with N navigations**

The `onDelete` callback (line 129 of `_auth.$filterType.$filterId.tsx`) calls `handleDeleteContact` in a `for...of`
loop. `handleDeleteContact` is `async` and calls `deleteMutation.mutateAsync` then `navigate`. Without `await` in the
loop, all deletes fire simultaneously, each triggering its own navigation. The race between parallel navigations and
cache invalidations can cause stale UI or errors.

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:128-129`
Impact: Race condition on multi-select delete; potentially multiple rapid navigations.
Fix: `await Promise.all(selectedContacts.map(c => deleteMutation.mutateAsync(c.id)))`, then navigate once.
Status: Carried forward from previous review (I3).

---

**I2. Batch label toggle fires mutations in a tight loop with no error handling**

The `onToggleLabel` callback (lines 131-147) calls `updateContactMutation.mutate()` (not `mutateAsync`) in a loop.
Each call fires independently with no `await`, no `Promise.all`, and no per-item error handling. If any individual
update fails, the user has no indication which contacts failed.

File: `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:131-147`
Impact: Silent partial failures; mutation burst may overwhelm the API.
Fix: Use `mutateAsync` with `Promise.allSettled`, report failures.
Status: Carried forward from previous review (I4).

---

**I3. Same fire-and-forget pattern in `__root.tsx` drag-and-drop label assignment**

`handleAssignLabelByDrop` (lines 30-39 of `__root.tsx`) calls `updateContact.mutate()` in a loop for each dropped
contact, with the same no-await, no-error-handling pattern as I2.

File: `apps/contacts/src/routes/__root.tsx:30-39`
Impact: Same as I2 -- silent partial failures on drag-and-drop label assignment.
Fix: Same as I2.
Status: **New finding.** The previous review missed this identical pattern in the root route.

---

**I4. `navigate()` called directly in render body (not in useEffect)**

In `_auth.edit.$filterType.$filterId.tsx` lines 103-109, when `contactId` is set but the contact is not found,
`navigate()` is called directly during render (not inside a `useEffect`). This is a side effect during render, which
violates React's rules and can trigger "Cannot update a component while rendering a different component" warnings in
development.

File: `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:103-109`
Impact: React warning in development; potential infinite re-render loop if navigation triggers re-render before
returning `null`.
Fix: Wrap the redirect in a `useEffect`, matching the pattern already used in `_auth.$filterType.$filterId.tsx:67-75`.
Status: **New finding.**

---

**I5. Delete from toolbar has no confirmation dialog**

The toolbar delete button (`ContactDetailToolbar` line 55) calls `onDeleteClick` directly, which immediately fires
the delete mutation and navigates away. The `ContactDetail` component *has* a `DeleteDialog` (lines 296-304) and
`deleteDialogOpen` state (line 114), but nothing ever sets `deleteDialogOpen` to `true`. The dialog is dead code, and
deletes happen without confirmation.

The context menu delete in `ContactsList` also has no confirmation.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:55,114,296-304`
Impact: Accidental single-click deletes with no undo path.
Fix: Wire the toolbar delete button to set `deleteDialogOpen = true` instead of calling `onDeleteClick` directly.
Status: Partly in previous review (M5 noted dead dialog), upgraded to Important because the missing confirmation
is a data-loss risk.

---

**I6. "Send email" dropdown shown for contacts with only empty-string emails**

The toolbar dropdown checks `contact.email && contact.email.length > 0` (line 67) before showing "Send email", but
does not check whether `email[0]` is a non-empty string. Since the form allows saving `[""]` (the schema permits
`z.string().length(0)`), a contact can have `email: [""]`, and clicking "Send email" calls
`openWriteEmailTo("")` which navigates to the mail compose URL with an empty recipient.

Similarly, the detail view renders empty `<a>` tags for empty-string email entries (lines 213-219).

File: `apps/contacts/src/components/contacts/contact-detail.tsx:67-73,213-219`
Impact: Broken "Send email" action; invisible but focusable empty links.
Fix: Filter out empty strings: `contact.email.filter(e => e.length > 0)`. Apply in both the toolbar dropdown guard
and the detail email list rendering.
Status: Expanded from previous review (M4), upgraded to Important because it causes a broken mail compose action.

---

**I7. Dutch comment violates English-everywhere rule**

`packages/lib/src/core/contacts/hooks/use-labels.ts` line 7 reads:
```
// Definieer query keys voor hergebruik
```
This should be English per CLAUDE.md.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts:7`
Impact: Code style violation.
Fix: Replace with `// Query keys for reuse` or remove (the code is self-documenting per project rules).
Status: Carried forward from previous review (I5).

---

## Minor Issues

**M1. `filterType` fallback inconsistency: `'filter'` vs `'book'`**

`ContactDetailToolbar` falls back to `filterType || 'filter'` (lines 39, 84) and `ContactsList` defaults to
`filterType = 'filter'` (line 77). The index route and sidebar both use `'book'` as the default filter type. If
`filterType` is ever undefined/missing, the edit link navigates to `/filter/all` which is not a recognized filter
path in the sidebar, and the filtering logic in `ContactsList` only handles `'label'` -- everything else shows all
contacts. Functionally this works but creates inconsistent URLs.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:39,84`;
`apps/contacts/src/components/contacts/contacts-list.tsx:77`
Impact: Inconsistent URL paths; potential confusion if `filterType` routing is extended later.
Fix: Change all defaults to `'book'` to match the index route and sidebar.
Status: Carried forward from previous review (M2).

---

**M2. `as Contact` type assertions used to bypass type checking in 6 places**

Explicit `as Contact` casts appear in:
- `_auth.$filterType.$filterId.tsx:139,144` (label toggle)
- `_auth.edit.$filterType.$filterId.tsx:62` (update save)
- `_auth.edit.$filterType.$filterId.tsx:65` (add result cast)
- `_auth.new.tsx:30` (form data cast)
- `__root.tsx:36` (drag-and-drop label assignment)

These bypass the compiler's structural check, meaning if the `Contact` type gains a required field, these casts
will silently produce incomplete objects.

File: Multiple (see above)
Impact: Type errors hidden at compile time; bugs surface only at runtime.
Fix: Construct proper `Contact` objects or use `Partial<Contact>` where appropriate. For the mutation calls, the
mutation function already types its parameter as `Contact`, so the spread should satisfy the type without a cast
if all required fields are present.
Status: Carried forward from previous review (M6), with additional locations identified.

---

**M3. `as any` casts in label hooks disable type safety**

`use-labels.ts` lines 40 and 57 cast the API request body to `any`:
- `contactsApi({ownerId}).labels.post(labelData as any)` (line 40)
- `contactsApi({ownerId}).labels({id: updatedLabel.id}).put({...} as any)` (line 57)

This bypasses Eden Treaty's type-safe API client, which is one of the key architectural benefits of the Elysia+Eden
stack.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts:40,57`
Impact: API payload mismatches not caught at compile time.
Fix: Fix the types to match the API route definitions, or adjust the API route types if they are overly strict.
Status: Carried forward from previous review (M8).

---

**M4. `labelKeys` root is `['labels']` instead of `['contacts', 'labels']`**

The `contactKeys` root is `['contacts']`, following the domain-namespaced convention used by `driveKeys: ['drive']`,
etc. But `labelKeys` uses `['labels']` as its root. If another domain (e.g., mail or drive) adds labels, query key
collisions would cause cross-domain cache invalidation. Labels are a contacts-domain concept and should be namespaced
under `['contacts', 'labels']`.

File: `packages/lib/src/core/contacts/hooks/use-labels.ts:8-14`
Impact: Potential future query key collision across domains.
Fix: Change `all: ['labels']` to `all: ['contacts', 'labels']`.
Status: **New finding.**

---

**M5. `form.watch()` called 6 times in render for dynamic arrays**

The email, phone, and address sections each call `form.watch("email")`, `form.watch("phone")`, and
`form.watch("address")` twice per render (once for `.map()`, once for `.length > 1`). Each `form.watch()` call
subscribes to field changes and triggers re-renders of the entire `ContactEdit` component. With 6 subscriptions to
3 array fields, any keystroke in any field re-renders the full form.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:389,406,445,462,501,505`
Impact: Unnecessary full-form re-renders on every keystroke.
Fix: Use `useFieldArray` from react-hook-form for `email`, `phone`, and `address` arrays. This provides `fields`,
`append`, `remove` methods and only re-renders the affected array section.
Status: **New finding.**

---

**M6. `formatPhoneNumber` is a no-op stub with a TODO comment**

The function at lines 127-129 of `contact-detail.tsx` returns the input unchanged, with a `// You might want to add
formatting logic here` comment. Either implement phone formatting or remove the wrapper and use the raw value directly.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:127-129`
Impact: Dead code; misleading comment.
Fix: Remove the function and use the phone value directly in the template.
Status: Carried forward from previous review (M3).

---

**M7. Hardcoded `en-US` locale for birthday formatting**

`formatDate` on line 149 uses `new Intl.DateTimeFormat('en-US', ...)`. Other apps in the project use `'en'`. There is
no shared date-formatting utility.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:149`
Impact: Inconsistency across apps; no i18n path.
Fix: Extract a shared `formatDate` utility in `packages/lib` or use the browser's default locale via `undefined`.
Status: Carried forward from previous review (M1).

---

**M8. Redundant birthday formatting: double Date construction**

Line 260 constructs `new Date(contact.birthday || '')` then calls `.toISOString()` on it, then passes that to
`formatDate()` which constructs another `new Date(dateString)`. This is `new Date(new Date(x).toISOString())` --
redundant. Also, if `contact.birthday` is an invalid date string, `new Date(invalid).toISOString()` throws a
`RangeError`.

File: `apps/contacts/src/components/contacts/contact-detail.tsx:260`
Impact: Potential runtime crash on malformed birthday data.
Fix: Pass `contact.birthday` directly to `formatDate()` (which already handles `undefined`), and add a validity check
inside `formatDate` (`isNaN(date.getTime())`).
Status: **New finding.**

---

**M9. `emptyContact` object duplicated in two routes**

The same `emptyContact: Contact` object with identical shape is defined in both `_auth.new.tsx:16-24` and
`_auth.edit.$filterType.$filterId.tsx:112-120`. Any change to the empty contact shape must be made in both places.

File: `apps/contacts/src/routes/_auth.new.tsx:16-24`;
`apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:112-120`
Impact: Maintenance burden; risk of the two falling out of sync.
Fix: Extract to a shared constant, e.g. `const EMPTY_CONTACT: Contact = { ... }` in a shared location.
Status: **New finding.**

---

**M10. Avatar handling differs between new and edit save paths**

In `_auth.new.tsx:37`, avatar is `formData.avatar || undefined` (falsy coercion -- empty string becomes `undefined`).
In `_auth.edit.$filterType.$filterId.tsx:55`, avatar is `formData.avatar ?? ''` (nullish coercion -- empty string
is kept as `''`). This means:
- New contact: removing an avatar sets `avatar: undefined` (field omitted).
- Edit contact: removing an avatar sets `avatar: ''` (empty string sent to API).

The API may handle these differently.

File: `apps/contacts/src/routes/_auth.new.tsx:37`;
`apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:55`
Impact: Inconsistent avatar removal behavior between new and edit flows.
Fix: Use the same coercion in both paths. If the API expects an empty string for "no avatar", use `?? ''` in both.
If it expects `undefined`/omission, use `|| undefined` in both.
Status: **New finding.**

---

**M11. `onSave` prop typed as `void` return but awaited as `Promise<void>`**

The `ContactEditProps.onSave` type (line 70) is `(data: ContactFormValues) => void`, but all callers
(`_auth.new.tsx:27`, `_auth.edit.$filterType.$filterId.tsx:46`) return `Promise<void>`. The `handleSubmit` in
`contact-edit.tsx:108` does `await onSave(formData)`. TypeScript allows `await`-ing `void`, but the type signature
is misleading and `await` on a non-promise is a no-op, which could mask bugs if the parent's `handleSave` were
changed to be synchronous.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:70`
Impact: Misleading type; potential future bug if callers change.
Fix: Change type to `(data: ContactFormValues) => Promise<void>`.
Status: **New finding.**

---

**M12. Unused props in `ContactEdit` and `ContactDetail`**

- `ContactEdit` declares `filterType` and `filterId` in `ContactEditProps` (lines 72-73) but destructures them away
  (line 76-79 omits them). These props are passed from both parent routes but never used.
- `ContactDetail` declares `filterType` and `filterId` as optional props (lines 109-110) and receives them from the
  parent (lines 156-157) but does not destructure them.

File: `apps/contacts/src/components/contacts/contact-edit.tsx:72-73,76-79`;
`apps/contacts/src/components/contacts/contact-detail.tsx:109-110,113`
Impact: Dead props; misleading interface.
Fix: Remove `filterType` and `filterId` from both prop interfaces and call sites.
Status: **New finding.**

---

**M13. Search does not cover phone, company, or notes**

The search filter (lines 112-120 of `contacts-list.tsx`) only matches against `firstName`, `lastName`, and `email`.
Searching for a phone number, company name, or notes content returns no results.

File: `apps/contacts/src/components/contacts/contacts-list.tsx:112-120`
Impact: Users cannot find contacts by phone number or company.
Fix: Extend the filter to include `contact.phone`, `contact.company`, and optionally `contact.notes`.
Status: **New finding.**

---

**M14. `indexOf` called per contact inside grouped render loop -- O(n^2)**

Line 194 of `contacts-list.tsx` calls `searchedContacts.indexOf(contact)` for every contact rendered inside the
grouped loop. `indexOf` is O(n) by reference comparison, and it runs once per contact, making the overall render
O(n^2). For large contact lists (1000+), this causes measurable render lag.

File: `apps/contacts/src/components/contacts/contacts-list.tsx:194`
Impact: Quadratic rendering cost; noticeable with large contact lists.
Fix: Pre-build an `id -> flatIndex` `Map` in the `useMemo` that produces `groupedContacts`, then do a constant-time
lookup during render.
Status: **New finding.**

---

**M15. `contact.email[0]` empty string shown in `UserItem` email slot**

In `contacts-list.tsx` line 216, the `UserItem` receives `contact.email[0]` as the email prop, guarded by
`contact.email && contact.email.length > 0`. But if `email` is `[""]`, this passes an empty string to `UserItem`,
which may render an empty email line or a broken avatar resolution.

File: `apps/contacts/src/components/contacts/contacts-list.tsx:216`
Impact: Potential empty email display in list items.
Fix: Add `&& contact.email[0].length > 0` or use `contact.email.find(e => e.length > 0)`.
Status: **New finding.**

---

## Observations

These are not bugs but patterns worth noting for future improvement.

**O1. "Frequent" and "Recent" sidebar items are non-functional.**
The sidebar links route to `book/frequent` and `book/recent` (lines 57, 65 of `contacts-sidebar.tsx`), but
`ContactsList` only filters by `label` type (line 97-100). The `book` filter type with these IDs shows all contacts
unfiltered. Either implement frequency/recency tracking or remove the sidebar items to avoid misleading users.

**O2. No toast notifications on any mutation.**
Successful contact saves, deletes, and label changes give no toast feedback. The user only sees navigation. Other Eigen
apps (e.g., Drive) show toasts on mutations.

**O3. No unsaved-changes guard on the edit form.**
Navigating away from the edit form with unsaved changes silently discards them. No `beforeunload` handler or router
blocker is in place.

**O4. No optimistic updates.**
All mutations wait for server response + cache invalidation before the UI updates. For label toggles and deletes, the
user sees a brief stale state.

**O5. Form validation schema lives in the app, not in `packages/lib/src/validation/`.**
The `formSchema` in `contact-edit.tsx:27-52` cannot be reused by the backend for server-side validation. Per project
conventions, shared validation schemas belong in `packages/lib/src/validation/`.

**O6. `jobTitle` only shown in detail view when `company` is also present.**
Line 179 checks `contact.jobTitle && contact.company` -- a contact with a job title but no company will not display
the job title in the detail view.

**O7. Contact `address` only checks first entry for emptiness.**
Line 266 checks `Object.keys(contact.address[0]).length > 0` but if the first address is empty and subsequent ones
are not, the entire address section is hidden.

**O8. Print uses `data-document` on the detail view only.**
The `data-document="contact-detail"` attribute (line 161) is only on the `ContactDetail` component. Printing the
contact list view falls back to `window.print()` which prints the entire page including sidebar and chrome.

**O9. `useContacts()` is called 3 times in the authenticated app tree.**
- `AuthenticatedContactsRoot` in `__root.tsx:27`
- `ContactsRoute` in `_auth.$filterType.$filterId.tsx:31`
- `ContactsList` in `contacts-list.tsx:92`

TanStack Query deduplicates the network request, but each instance creates a separate subscription and re-renders
its subtree on data changes. The root-level call (for drag-and-drop label assignment) is the most expensive since
it re-renders the entire app tree.
