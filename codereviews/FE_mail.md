# Frontend Review: Mail App

**Scope:** `apps/mail/`, `packages/lib/src/core/mail/`
**Reviewed:** 2026-03-19

Files reviewed: 8 app source files (`apps/mail/src/`), 6 library files (`packages/lib/src/core/mail/`),
1 type file (`packages/lib/src/types/mail.ts`), 1 API client (`packages/lib/src/core/api.ts`).

---

## Architecture Overview

The mail app is a compact but full-featured email client built around a two-column layout (list + detail/compose).

**Routing**: TanStack Router with file-based routes. `/_auth` guard redirects unauthenticated users. The index route
redirects to `/box/inbox`. The main route `/_auth/$filterType/$filterId` handles all mailbox views, email detail, and
compose mode via URL search params (`mailId`, `mode`, `to`).

**Mailbox navigation**: The sidebar (`email-sidebar.tsx`) renders standard mailboxes (Inbox, Drafts, Sent, Spam, Trash,
Archive) derived from API data with fallback defaults. Mailboxes are mapped to `/box/{path}` URLs. Drag-and-drop
between sidebar items is supported via `DroppableSidebarItem`.

**Message list**: `email-list.tsx` renders a filtered, sorted list with client-side search (subject/from/preview text).
Supports keyboard navigation (`useKeyboardListNavigation`), multi-select (`useListSelection`), drag (`useListDrag`),
and right-click context menu.

**Message detail**: `email-detail.tsx` renders the full email with HTML via `ShadowContent` (Shadow DOM isolation),
expandable To/Cc/Bcc details, and an attachment download grid. Automatically marks emails as read via `useEffect`.

**Compose/Draft**: `email-draft.tsx` uses uncontrolled inputs (refs) for To/Cc/Bcc/Subject/Body. Contact autosuggest
is provided on address fields. A `useMemo`-wrapped `getCurrentDraft` reads current values from refs on submit. Focus is
auto-managed based on which fields are empty.

**Reply/Forward**: Built in the main route (`_auth.$filterType.$filterId.tsx`) as `handleReplyEmail`,
`handleReplyAllEmail`, `handleForwardEmail`. These fetch the source email, construct a `DraftInput`, and call
`handleNewDraftEmail` which saves via `useUpdateDraft` then navigates to the draft.

**Data layer**: Hooks in `packages/lib/src/core/mail/hooks/` -- `useMailboxes`, `useEmails`, `useEmail`,
`useEmailById`, `useDeleteEmail`, `useMoveEmail`, `useToggleReadEmail`, `useToggleFlaggedEmail`, `useUpdateDraft`,
`useSendDraft`. SSE handler in `sse-handlers.ts` covers 7 event types.

---

## Critical Issues

### 1. Missing `await` on `handleNewDraftEmail` in reply/forward handlers

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:167,186,199`

```typescript
const handleReplyEmail = async (emailId: string) => {
    const email = await getEmailById(emailId);
    if (!email) { toast.error("Could not load email"); return; }
    handleNewDraftEmail(createDraftEmail({  // <-- no await
        to: email.replyTo || email.from,
        ...
    }));
};
```

`handleNewDraftEmail` (line 114) is async -- it calls `updateDraft.mutateAsync` and then navigates to the draft. Without
`await`, the calling function returns immediately. Since `handleReplyEmail` itself is async and called from event
handlers, the unawaited promise means:

- Any error from the draft save is silently lost (no catch, no error feedback)
- The caller has no way to know the operation completed
- If the caller had any post-call logic, it would execute before the draft is saved

Per CLAUDE.md: "Always `await` async calls -- missing `await` is the #1 bug class in this codebase."

All three handlers are affected: `handleReplyEmail` (line 167), `handleReplyAllEmail` (line 186),
`handleForwardEmail` (line 199).

**Impact:** Silent error swallowing on reply/forward draft creation. Violates the project's most critical rule.

**Fix:** Add `await` before all three `handleNewDraftEmail(...)` calls.

**Status:** New finding.

---

### 2. Toolbar send button bypasses form validation and sends stale cache data

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:228`

```typescript
<EmailDraftToolbar
    onSend={() => handleSendEmail(selectedEmail as EmailDraftType)}
    ...
/>
```

The toolbar's Send button calls `handleSendEmail(selectedEmail as EmailDraftType)` which passes the `selectedEmail`
object from `useEmail(mailId)` -- the cached version. Meanwhile, the user is editing the draft via uncontrolled inputs
(refs in `email-draft.tsx`). The form's own submit handler (`email-draft.tsx:161`) correctly reads current values from
refs via `getCurrentDraft()`, but the toolbar bypasses this entirely.

This means: if the user types new text in the To field, changes the subject, or writes body text, clicking the toolbar
Send button sends the **original cached draft**, not the edited version. Only pressing Enter on the form submits
the current values.

Additionally, for a brand-new compose (no existing draft), `selectedEmail` is `null`, so
`handleSendEmail(null as EmailDraftType)` calls `sendDraft.mutateAsync(null)` which will fail on the server.

**Impact:** Toolbar Send sends stale data, discarding user edits. For new compose, it crashes.

**Fix:** The toolbar's `onSend` should trigger the draft form's submit (e.g., via a shared ref to the form, or by
having `EmailDraft` expose a submit method). Alternatively, consolidate to a single send path that always reads from
refs.

**Status:** New finding.

---

### 3. Mutation handlers lack error feedback -- multiple `mutateAsync` calls without try/catch

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:85-112`

```typescript
const handleDeleteEmail = async (mail: Email) => {
    if (mail.mailbox === 'Trash') {
        setPendingDeleteMail(mail); setDeleteDialogOpen(true);
    } else {
        await deleteMail.mutateAsync(mail);  // no try/catch
        navigateToList();  // runs only on success... but unhandled rejection on failure
    }
};

const handleSendEmail = async (mail: EmailDraftType) => {
    await sendDraft.mutateAsync(mail);  // no try/catch
    navigateToList();
};
```

Per CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`, or use the
`onError` callback. Never swallow errors."

The following handlers all use `mutateAsync` without try/catch or onError:

- `handleDeleteEmail` (line 90)
- `confirmDeleteEmail` (line 97)
- `handleMoveEmail` (line 105)
- `handleSendEmail` (line 110)
- `handleNewDraftEmail` (line 115)

If any mutation fails, the promise rejection is unhandled. The user sees no error toast and the navigation to list
does not execute (the error propagates as an unhandled rejection).

**Impact:** No user-visible error feedback on any mutation failure. Unhandled promise rejections.

**Fix:** Wrap each `mutateAsync` call in try/catch with `toast.error()`, or add `onError` callbacks to the mutation
hooks.

**Status:** Previously partially identified (issue #2 in prior review, re-assessed). The prior review focused on the
draft functions swallowing errors; those are now fixed (errors propagate from `updateDraftEmail`/`sendDraftEmail`). But
the calling code in the route still does not catch them.

---

## Important Issues

### 4. `MAIL_SENT` SSE handler does not invalidate Sent or Drafts email lists

**File:** `packages/lib/src/core/mail/sse-handlers.ts:60-63`

```typescript
case SSEventType.MAIL_SENT:
    invalidateMailboxes(queryClient);
    invalidateHomeSize(queryClient);
    return true;
```

This invalidates mailbox counts and home size, but does not invalidate `emailKeys.list('Sent')` or
`emailKeys.list('Drafts')`. After sending an email, the Sent folder's email list and the Drafts folder's email list
remain stale until the user navigates away and back (or the 1-minute staleTime expires).

Compare with `MAIL_DRAFT_UPDATED` (line 54-57) which correctly calls `invalidateDraftUpdated` (invalidating both
the detail and Drafts list).

**Impact:** Sent folder does not show newly sent emails via SSE. Drafts folder does not remove sent drafts via SSE.

**Fix:** Add `queryClient.invalidateQueries({queryKey: emailKeys.list('Sent')})` and
`queryClient.invalidateQueries({queryKey: emailKeys.list('Drafts')})` to the `MAIL_SENT` case.

**Status:** Partially fixed from prior review (issue #5). The handler now does some invalidation but still misses the
email list queries.

---

### 5. `useEmails` returns `Email[]` but server sends `EmailSummary[]`

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts:20-22`

```typescript
queryFn: async (): Promise<Email[]> => {
    const response = await mailApi({ownerId}).mailbox({mailboxPath: mailboxPath.toLowerCase()}).get();
    return (response.data || []) as Email[];
},
```

The list endpoint returns `EmailSummary` objects (id, subject, fromShort, textShort, date, isRead, etc.) -- not full
`Email` objects with parsed body fields (html, text, attachments, headers, etc.). The `as Email[]` cast tells
TypeScript that fields like `html`, `text`, and `attachments` exist, but they are `undefined` at runtime.

This has downstream consequences: `displayEmails` in the route (line 65-67) is typed as `Email[]` but actually contains
`EmailSummary[]`. The `EmailList` component prop is correctly typed as `EmailSummary[]` (line 31), so the mismatch is
papered over at the component boundary.

**Impact:** Type safety loss. Any code that accesses `Email`-specific fields on list items will get `undefined` without
a type error.

**Fix:** Change the return type to `EmailSummary[]` and update the `emailKeys.list` type accordingly.

**Status:** Previously identified (issue #10 in prior review). Confirmed still present.

---

### 6. Query keys do not include `ownerId`

**Files:**

- `packages/lib/src/core/mail/hooks/use-mailboxes.ts:5-12`
- `packages/lib/src/core/mail/hooks/use-emails.ts:6-12`

```typescript
export const mailboxKeys = {
    all: ['mailboxes'] as const,
    lists: () => [...mailboxKeys.all, 'list'] as const,
    ...
};

export const emailKeys = {
    all: ['emails'] as const,
    lists: () => [...emailKeys.all, 'list'] as const,
    ...
};
```

Per CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data. Without it, switching between personal and
team contexts serves stale cached data from the wrong owner."

While the mail app is currently user-only (no team mail), the query key structure should follow the project-wide pattern
for consistency and future-proofing.

**Impact:** Low currently (mail has no team context), but violates the established pattern.

**Fix:** Add `ownerId` to the key hierarchy: `['emails', ownerId, ...]`.

**Status:** New finding.

---

### 7. Subject prefix stacking on repeated reply/forward

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:169,188,200`

```typescript
subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
// ...
subject: `FW: ${email.subject}`,
```

Reply checks for `RE:` prefix to avoid stacking, but the check is case-sensitive (`startsWith('RE:')`) and does not
handle `Re:`, `re:`, or `Fwd:`. Forward always prepends `FW:` without any check, so forwarding a forwarded email
produces `FW: FW: FW: Original Subject`.

**Impact:** Cosmetic. Subject lines degrade with each reply/forward cycle.

**Fix:** Use a case-insensitive regex like `/^(RE|FW|Fwd):\s*/i` to strip existing prefixes before prepending.

**Status:** Previously identified (issue #9 in prior review). Confirmed still present.

---

### 8. Mobile compose has no back button

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:281`

```typescript
<Column id="detail" width="flex" onBack={isDraft ? undefined : navigateToList} toolbar={detailToolbar}>
```

When `isDraft` is true, `onBack` is `undefined`, so the `Column` component does not render the mobile back arrow.
On mobile, a user who opens compose or edits a draft has no way to return to the email list except via browser back
or deleting the draft.

**Impact:** Mobile UX trap. Users cannot cancel composition without deleting.

**Fix:** Provide `onBack={navigateToList}` for drafts too, or add a cancel/back button to `EmailDraftToolbar`.

**Status:** Previously identified (issue #14 in prior review). Confirmed still present.

---

### 9. `user!` non-null assertions can crash if auth is not yet resolved

**Files:**

- `apps/mail/src/components/mail/email-draft.tsx:88` -- `auth.user!.name`, `auth.user!.email`
- `apps/mail/src/components/mail/email-context-menu.tsx:124` -- `user!.id`
- `apps/mail/src/components/mail/email-detail.tsx:294` -- `user!.id`

These non-null assertions assume the user object is always available. The components are rendered inside `_auth` guard,
so `user` should be present, but TanStack Query's auth check is async -- there can be brief moments during
hydration/re-auth where `user` is null. A crash here unmounts the entire mail app.

**Impact:** Potential runtime crash during auth transitions.

**Fix:** Add null guards: `user?.id ?? ''` or early-return when user is null.

**Status:** Previously identified for email-draft (issue #11 in prior review). Now extended to context-menu and detail.

---

### 10. No email address validation before sending

**File:** `apps/mail/src/components/mail/email-draft.tsx:161-186`

The send handler (line 165) only checks that the `to` field is non-empty. Invalid addresses like `foo`, `@bar`, or
`hello world` are sent to the server. The `getEmailDraftStatus` function (lines 16-32) exists but is not used for
validation.

The `convertStringToEmailAddressArray` parser (line 117-136) splits on `<` which breaks for plain addresses with
spaces, and splits on `,` which breaks for quoted display names like `"Doe, John" <john@example.com>`.

**Impact:** Invalid addresses sent to server. The address parser can produce malformed address objects.

**Fix:** Add basic email format validation. Consider using the shared validation infrastructure in
`packages/lib/src/validation/`.

**Status:** Previously identified (issue #13 in prior review). Confirmed still present.

---

### 11. `error` prop accepted but never rendered in `EmailList`

**File:** `apps/mail/src/components/mail/email-list.tsx:36,48-63`

```typescript
interface EmailListProps {
    error?: Error | null;  // accepted
    ...
}

export function EmailList({ ... error ... }: EmailListProps) {
    // error is destructured but never used in JSX
```

When `useEmails` returns an error, the component shows "No emails found." instead of an error message.

**Impact:** Users have no way to distinguish between an empty mailbox and a failed fetch.

**Fix:** Add an error state rendering before the loading check.

**Status:** Previously identified (issue #12 in prior review). Confirmed still present.

---

### 12. `useMemo` dependency array missing `isLoading` and `error` in sidebar

**File:** `apps/mail/src/components/mail/email-sidebar.tsx:146`

```typescript
const standardMailboxList = useMemo(() => {
    // ...
    const displayMailboxes = isLoading || error ? defaultMailboxes : processedMailboxes;
    // ...
}, [mailboxes]);  // missing: isLoading, error
```

The memo body reads `isLoading` and `error` (line 134) but these are not in the dependency array. If `isLoading`
transitions from true to false while the `mailboxes` reference stays the same (e.g., empty array both times), the memo
returns stale `defaultMailboxes` instead of the processed list.

**Fix:** Change to `[mailboxes, isLoading, error]`.

**Status:** Previously identified (issue #9 in prior review). Confirmed still present.

---

## Minor Issues

### 13. `interface` used instead of `type` (9 instances)

Per CLAUDE.md, `type` is preferred over `interface`. The following use `interface`:

- `apps/mail/src/routes/__root.tsx:7` -- `MyRouterContext`
- `apps/mail/src/components/mail/email-sidebar.tsx:85` -- `AppSidebarProps`
- `apps/mail/src/components/mail/email-compose-button.tsx:8` -- `EmailComposeButtonProps`
- `apps/mail/src/components/mail/email-context-menu.tsx:16` -- `EmailContextMenuProps`
- `apps/mail/src/components/mail/email-detail.tsx:17` -- `EmailDetailToolbarProps`
- `apps/mail/src/components/mail/email-detail.tsx:109` -- `EmailDetailProps`
- `apps/mail/src/components/mail/email-list.tsx:13` -- `EmailListToolbarProps`
- `apps/mail/src/components/mail/email-list.tsx:30` -- `EmailListProps`
- `apps/mail/src/components/mail/email-draft.tsx:60` -- `EmailDraftProps`

Note: `interface` in `routeTree.gen.ts` (auto-generated) and `main.tsx` (declaration merging) is correct.

**Status:** Previously identified. Confirmed still present.

### 14. JSDoc comment violates project rules

**File:** `apps/mail/src/components/mail/email-draft.tsx:12-15`

```typescript
/**
 * Checks the status of an email draft
 * @param draft The email draft to check
 * @returns Object with sendable and saveable status
 */
```

CLAUDE.md: "No JSDoc -- code should be self-documenting."

**Status:** Previously identified. Confirmed still present.

### 15. Missing React `key` props in `formatContactObject`

**File:** `apps/mail/src/components/mail/email-detail.tsx:188-190`

```typescript
return contact.value.map((address, idx, arr) => (
    <><MailLink ... />{idx < arr.length - 1 ? ', ' : ''}</>
));
```

The fragment returned from `.map()` has no `key` prop. React logs a warning in development.

**Fix:** Use `<React.Fragment key={address.address || idx}>`.

**Status:** Previously identified. Confirmed still present.

### 16. Dead/commented-out code

- `apps/mail/src/components/mail/email-sidebar.tsx:194-224` -- ~30 lines of commented-out custom mailboxes and
  "New Folder" button
- `apps/mail/src/components/mail/email-draft.tsx:16-32` -- `getEmailDraftStatus` defined but never called

**Status:** Previously identified. Confirmed still present.

### 17. `useToggleFlaggedEmail` hook exported but unused

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts:110-127`

Defined and exported but never imported in the mail app. No flag/star toggle exists in the UI.

**Status:** Previously identified. Confirmed still present.

### 18. Hardcoded `'unknown@example.com'` fallback

**File:** `apps/mail/src/components/mail/email-detail.tsx:160`

```typescript
const fromEmail = firstFrom?.address || 'unknown@example.com';
```

This fallback appears clickable via `UserItem` and `MailLink`. A user might attempt to reply to it.

**Fix:** Use an empty string or hide the email display when the address is unknown.

**Status:** Previously identified. Confirmed still present.

### 19. Inconsistent variable naming: `isEmailsError`

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:59`

```typescript
const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
```

`isEmailsError` uses the `is` prefix (boolean convention) but holds an `Error | null` object.

**Fix:** Rename to `emailsError`.

**Status:** Previously identified. Confirmed still present.

### 20. Sequential bulk operations cause N round-trips

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:130-158`, `apps/mail/src/routes/__root.tsx:30-34`

All bulk handlers use sequential `for...of await` loops. Each operation triggers its own API call and cache
invalidation. Deleting 10 emails causes 10 API calls, 10 list invalidations, and 10 refetches.

**Fix:** Use `Promise.all` for parallel execution, or implement batch API endpoints.

**Status:** Previously identified. Confirmed still present.

### 21. `ShadowContent` renders `innerHTML` without client-side sanitization

**File:** `apps/mail/src/components/mail/email-detail.tsx:267-271` (via `ShadowContent`)

Server-side DOMPurify sanitization exists (`apps/api/src/lib/mail/mail-parse.ts`), so this is safe for the current
mail code path. However, `ShadowContent` as a shared component has no self-defense.

**Impact:** Low for mail. Architecturally fragile for the shared component.

**Status:** Previously identified. Downgraded to minor after confirming server sanitization.

### 22. `needsToShowTo`/`needsToShowCc`/`needsToShowBcc` uses `> 1` threshold

**File:** `apps/mail/src/components/mail/email-detail.tsx:162-164`

The expandable details section only appears when there are 2+ addresses. A single To address is not shown in the
expanded view, meaning the user cannot see who the email was addressed to in a structured format (only in the
potentially truncated summary).

**Status:** Previously identified. Confirmed still present.

### 23. `as Record<string, any>` in mailbox query key factory

**File:** `packages/lib/src/core/mail/hooks/use-mailboxes.ts:8`

```typescript
list: (filters: Record<string, any>) => [...mailboxKeys.lists(), {filters}] as const,
```

Uses `any` in the type signature. Per CLAUDE.md: "Never use `as any`." The `list()` factory accepts `any`-typed
filters but is never actually called with arguments (only `lists()` is used in `useMailboxes` and
`invalidateMailboxes`). This is dead code with a type violation.

**Status:** New finding.

### 24. Route path constructed via string interpolation

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:208`

```typescript
navigate({
    to: `/_auth/${filterType}/${filterId}`,
    ...
});
```

All other navigation calls in the same file use `Route.fullPath` with `params` (e.g., lines 71-74, 78-82, 117-121).
This one constructs the path via template literal. While functionally equivalent, it bypasses TanStack Router's type
checking and is inconsistent with the rest of the file.

**Fix:** Use `Route.fullPath` with `params: {filterType, filterId}` for consistency.

**Status:** New finding.

---

## Resolved Issues (from prior review)

The following issues from the previous review have been fixed:

1. **Broken download/attachment URLs** (prior #1) -- `getMailMessageDownloadUrl` and `getMailAttachmentUrl` now include
   the `ownerId` parameter. Call sites in `email-context-menu.tsx:124` and `email-detail.tsx:294` pass `user!.id`.

2. **Draft mutations silently swallow errors** (prior #2) -- `updateDraftEmail` and `sendDraftEmail` in
   `use-draft.ts` no longer have try/catch wrappers. Errors now propagate to the mutation layer. (However, the
   calling code still lacks error handling -- see issue #3 above.)

3. **Direct mutation of TanStack Query cache** (prior #3) -- Line 64-67 now uses immutable `.map()` to create a new
   array with the `isRead` flag set, rather than mutating the cached object in place.

4. **Draft mutations lack `onSuccess` cache invalidation** (prior #4) -- Both `useUpdateDraft` and `useSendDraft` now
   have `onSuccess` callbacks that invalidate the Drafts list, detail queries, mailboxes, and home size.

5. **Reply ignores `Reply-To` header** (prior #7) -- `handleReplyEmail` (line 168) now uses
   `email.replyTo || email.from`. `handleReplyAllEmail` (line 183) uses `(email.replyTo || email.from)?.value`.

6. **Reply All omits original To recipients** (prior #8) -- `handleReplyAllEmail` now includes `toValues` from
   `email.to` and filters out the current user's address (lines 180-185).

7. **`as any` on mailbox API path** (prior #10) -- Removed. The API call now uses
   `mailApi({ownerId}).mailbox({mailboxPath: ...}).get()` with proper Eden Treaty typing.

8. **EmailDraft mutates props during render** (prior #11) -- The `from` and `to` overrides are now inside a `useMemo`
   that creates a new object via spread (lines 83-93), no longer mutating the prop.

---

## Observations

- The overall architecture follows project conventions: AppShell, ColumnLayout, data hooks in `packages/lib`, SSE
  handlers, auth guard, and sidebar pattern.
- The mail app is compact (~6 components, 4 routes, 3 hook files + SSE handler) but handles a wide range of
  functionality: mailbox listing, email detail, compose, reply/reply-all/forward, context menu, keyboard navigation,
  drag-and-drop between mailboxes, multi-select, and mobile responsive layout.
- Client-side search (filter by subject/from/preview on loaded data) works for small mailboxes but will not scale.
  No server-side search endpoint exists.
- No virtualization on the email list -- large mailboxes render all items to the DOM.
- The compose flow is text-only (no rich text editor, no attachment upload).
- Date formatting mixes `date-fns` (English-only format strings) and native `toLocaleDateString`/`toLocaleTimeString`
  (locale-aware). Inconsistent but functional.
- `useEmail` uses `staleTime: Infinity` -- individual email content is never refetched once cached. Appropriate since
  email content is immutable, but draft edits from another tab would not propagate.
- The `MailLink` component properly uses `import.meta.env.VITE_APP_MAIL_URL` for cross-app email compose links.
- Several significant fixes have been made since the prior review, particularly around URL builders, cache mutation,
  draft hooks, and reply-to handling. The remaining issues are concentrated around error handling, the toolbar/form
  send-path divergence, and various minor cleanup items.
