# Frontend Review: Mail App

**Scope:** `apps/mail/`, `packages/lib/src/core/mail/`
**Reviewed:** 2026-03-18

## Critical Issues

### 1. Broken download and attachment URLs -- missing ownerId segment

**File:** `packages/lib/src/core/api.ts:94-95`

The URL builder functions for message download and attachment download omit the required `/:ownerId/` path segment:

```typescript
export const getMailMessageDownloadUrl = (messageId: string) => `${API_HOST}/mail/message/download/${messageId}`;
export const getMailAttachmentUrl = (messageId: string, attachmentIndex: number, fileName: string) => `${API_HOST}/mail/message/${messageId}/attachment/${attachmentIndex}/${encodeURIComponent(fileName)}`;
```

The API routes expect the ownerId in the path:
- `GET /mail/:ownerId/message/:id/download` (`apps/api/src/routes/mail.ts:43`)
- `GET /mail/:ownerId/message/:id/attachment/:index/:fileName` (`apps/api/src/routes/mail.ts:125`)

These URLs will produce 404 responses. Every attachment click and every "Download" context menu action silently fails.

**Impact:** Attachments cannot be downloaded. The "Download" option in the context menu does nothing useful.

**Fix:** Add `ownerId` parameter to both functions and include it in the URL path. Update call sites in `email-detail.tsx:292` and `email-context-menu.tsx:122` to pass the current user's ownerId.

**Status:** New finding (not in previous review).

---

### 2. Draft mutations silently swallow errors, causing false success navigation

**File:** `packages/lib/src/core/mail/hooks/use-draft.ts:22-44`

Both `updateDraftEmail` and `sendDraftEmail` wrap their API calls in `try/catch` and return `null` on failure:

```typescript
export async function sendDraftEmail(draft: EmailDraft, ownerId: string): Promise<EmailDraft | null> {
    try {
        const response = await mailApi({ownerId}).message.send.post({ mail: draft });
        return response.data || null;
    } catch (error) {
        console.error('Error sending draft:', error);
        return null;  // Error is swallowed
    }
}
```

Because `useMutation`'s `mutationFn` never throws, `mutateAsync` always resolves successfully. In `_auth.$filterType.$filterId.tsx:105-108`:

```typescript
const handleSendEmail = async (mail: EmailDraftType) => {
    await sendDraft.mutateAsync(mail);  // never throws
    navigateToList();  // always runs, even on failure
};
```

The user is navigated away from the compose view even when the send fails. The `try/catch` in `email-draft.tsx:188-201` also never catches. The `isSending` state gets stuck in `true` until `finally` runs, but the user has already been navigated away.

**Impact:** Users lose their draft content on send failure with no error feedback. Same issue affects draft saving (`handleNewDraftEmail` at line 110).

**Fix:** Remove the `try/catch` from `updateDraftEmail` and `sendDraftEmail` so errors propagate to the mutation layer. Add `onError` to the mutations or handle errors in the calling code.

**Status:** New finding. Previous review noted the missing `onSuccess` (issue #3) but did not identify that errors are silently swallowed.

---

## Important Issues

### 3. Direct mutation of TanStack Query cache data

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:62-63`

```typescript
const selectedEmailInData = emails.find(m => m.id === selectedEmail?.id);
if (selectedEmailInData) selectedEmailInData.isRead = true;
```

This directly mutates an object inside TanStack Query's cache during rendering. React Query expects cached data to be immutable. The mutation runs on every render, marking the local cache entry as read before the server responds. If the mark-as-read API call fails, the UI is already wrong. The `EmailDetail` component already handles mark-as-read correctly via `useEffect` + `toggleMailRead` (line 141-146).

**Impact:** Optimistic-looking UI update that cannot be rolled back, runs during render (React anti-pattern), and corrupts shared cache state.

**Fix:** Remove lines 62-63 entirely. The `useEffect` in `EmailDetail` already handles this correctly.

**Status:** Previously identified (issue #2). Confirmed still present.

### 4. Draft mutations lack `onSuccess` cache invalidation

**File:** `packages/lib/src/core/mail/hooks/use-draft.ts:46-62`

`useUpdateDraft` and `useSendDraft` have no `onSuccess` callback. Every other mail mutation (`useDeleteEmail`, `useMoveEmail`, `useToggleReadEmail`) invalidates relevant query caches in `onSuccess`. After saving a draft, the Drafts list is stale. After sending, neither Sent nor Drafts lists update until SSE arrives (if it does -- see issue #5).

**Impact:** Stale UI after compose/send operations. Inconsistent with the rest of the mail hooks.

**Fix:** Add `onSuccess` to `useUpdateDraft` calling `invalidateDraftUpdated`. Add `onSuccess` to `useSendDraft` invalidating the Drafts list, Sent list, mailboxes, and home size.

**Status:** Previously identified (issue #3). Confirmed still present.

### 5. `MAIL_SENT` SSE handler is a no-op

**File:** `packages/lib/src/core/mail/sse-handlers.ts:60-61`

```typescript
case SSEventType.MAIL_SENT:
    return true;
```

Returns `true` (claiming it handled the event) but performs no invalidation. Combined with issue #4, after sending an email, neither the Sent nor the Drafts folder ever updates until the user manually navigates away and back.

**Impact:** Sent folder never updates via SSE. Stale mailbox counts.

**Fix:** Add invalidation for the Sent list (`emailKeys.list('Sent')`), the Drafts list (`emailKeys.list('Drafts')`), mailboxes, and home size, consistent with other mail SSE handlers.

**Status:** Previously identified (issue #4). Confirmed still present.

### 6. Missing `await` on async calls in bulk operation handlers

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:121-155`

Several wrapper functions call async handlers without `await`:

- Line 123: `if (email) handleDeleteEmail(email);` -- `handleDeleteEmail` is async (line 81)
- Line 132: `if (email) handleMoveEmail(email, folderId);` -- `handleMoveEmail` is async (line 100)

Because `handleDeleteEmailsByIds` does `for (const id of emailIds) await handleDeleteEmailById(id)`, and `handleDeleteEmailById` does not `await` `handleDeleteEmail`, the loop advances to the next item before the delete operation has started, let alone completed. The navigation (`navigateToList`) inside `handleDeleteEmail` races with the loop.

**Impact:** Bulk delete/move operations fire-and-forget, with unpredictable ordering and premature navigation. For bulk delete from Trash, the confirmation dialog opens for the first email, but the loop continues immediately.

**Fix:** Add `await` before `handleDeleteEmail(email)` and `handleMoveEmail(email, folderId)`.

**Status:** New finding (not in previous review).

### 7. Reply ignores `Reply-To` header

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:163-167`

```typescript
handleNewDraftEmail(createDraftEmail({
    to: email.from,
    ...
}));
```

Reply always addresses `email.from`. The `replyTo` field (defined in `ParsedMail` type at `packages/lib/src/types/mail.ts:58`) is never checked. RFC 5322 specifies that when `Reply-To` is present, it should be used instead of `From`. Mailing lists, ticketing systems, and newsletters rely on this.

**Impact:** Replies go to the wrong address when `Reply-To` differs from `From`.

**Fix:** Use `email.replyTo?.value || email.from?.value` for the `to` field in `handleReplyEmail` and `handleReplyAllEmail`.

**Status:** New finding (not in previous review).

### 8. Reply All includes sender's own address and omits original To recipients

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:176-178`

```typescript
const ccValues = Array.isArray(email.cc) ? email.cc.flatMap(c => c.value) : (email.cc?.value || []);
handleNewDraftEmail(createDraftEmail({
    to: {value: [...(email.from?.value || []), ...ccValues], html: '', text: ''},
```

Two problems:
1. The original `email.to` recipients are not included, so other direct recipients are dropped from the reply.
2. The current user's own address is never filtered out, so the user addresses themselves in the reply.

**Impact:** Reply All drops recipients and creates a mail loop to self.

**Fix:** Include `email.to` values, filter out the current user's address, and use `replyTo` when present.

**Status:** New finding (not in previous review).

### 9. Subject prefix stacking on repeated reply/forward

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:165,179,191`

Reply blindly prepends `RE: ` and forward prepends `FW: `. Replying to a reply produces `RE: RE: RE: Original Subject`. Standard email clients check for existing prefixes.

**Impact:** Cosmetic but makes conversation threads harder to follow.

**Fix:** Strip existing `RE: ` / `FW: ` prefixes (case-insensitive) before prepending, e.g. `subject.replace(/^(RE|FW):\s*/i, '')`.

**Status:** New finding (not in previous review).

### 10. Unsafe `as any` type cast on API path

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts:23`

```typescript
const response = await (mailApi({ownerId}).mailbox as any)[path].get();
```

This bypasses Eden Treaty's type safety. The API route uses a wildcard (`/mail/:ownerId/mailbox/*`), and this cast is the workaround. Any typo or API change will produce a runtime 404 with no compile-time warning.

Additionally, the return type is cast to `Email[]` (line 24) but the server actually returns `EmailSummary[]` (verified at `apps/api/src/lib/mail/maildir.ts:86`). This is an incorrect type cast -- `Email` includes parsed body fields (`html`, `text`, `attachments`, etc.) that the list endpoint does not return.

**Impact:** Type safety loss, incorrect type information downstream.

**Fix:** Cast the return to `EmailSummary[]` to match the actual server response. For the wildcard, either use Eden Treaty's wildcard accessor or add a comment explaining why `as any` is necessary.

**Status:** Previously identified (issue #7). Now also includes the `Email[]` vs `EmailSummary[]` type mismatch finding.

### 11. `EmailDraft` mutates props during render

**File:** `apps/mail/src/components/mail/email-draft.tsx:91-108`

```typescript
email.from = { value: [{ name: auth.user!.name || '', ... }], ... };
if (to) { email.to = { value: [{ ... }], ... } }
```

The `email` prop is directly mutated during render. If this object comes from TanStack Query's cache (it does -- `selectedEmail` at `_auth.$filterType.$filterId.tsx:58`), the cache is corrupted. This runs outside `useMemo`/`useEffect`, so it executes on every render.

Additionally, `auth.user!` uses a non-null assertion. If `useAuth()` hasn't resolved yet, this throws.

**Impact:** Cache corruption, potential crash from non-null assertion.

**Fix:** Create a local copy of the email object instead of mutating the prop. Guard against `auth.user` being null.

**Status:** New finding (not in previous review). The previous review's issue #2 covered the direct cache mutation at line 62-63, but this is a separate mutation in a different component.

### 12. `error` prop accepted but never rendered in `EmailList`

**File:** `apps/mail/src/components/mail/email-list.tsx:36`

The `EmailList` component accepts `error?: Error | null` but never renders it. When `useEmails` returns an error, the user sees "No emails found." instead of an error message.

**Impact:** Users have no way to know that email fetching failed.

**Fix:** Add an error state before the loading check that shows the error message.

**Status:** Previously identified (issue #6). Confirmed still present.

### 13. No email address validation before sending

**File:** `apps/mail/src/components/mail/email-draft.tsx:177-201`

The send handler only checks that the `to` field is non-empty (line 181). Invalid addresses like `foo`, `@bar`, or `hello world` are sent to the server. The `getEmailDraftStatus` function exists (lines 16-32) but its usage is commented out (line 88).

The `convertStringToEmailAddressArray` parser (inside `getCurrentDraft` at line 133) splits on `<` which breaks for plain addresses with spaces, and splits on `,` which breaks for quoted display names like `"Doe, John" <john@example.com>`.

**Impact:** Invalid addresses sent to server. Server may reject or silently fail.

**Fix:** Add basic email validation before submission. Re-enable `getEmailDraftStatus` or add inline validation.

**Status:** Previously identified (issue #5). Confirmed still present.

### 14. Mobile compose has no back button

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:272`

```typescript
<Column id="detail" width="flex" onBack={isDraft ? undefined : navigateToList} toolbar={detailToolbar}>
```

When `isDraft` is true, `onBack` is `undefined`, so the mobile back arrow is not rendered. On mobile, when a user opens the compose view, there is no way to navigate back to the email list without using the browser's back button. The draft toolbar has Send and Delete, but no cancel/back action.

**Impact:** Mobile users are trapped in compose view unless they use browser navigation or delete the draft.

**Fix:** Provide `onBack={navigateToList}` for drafts as well, or add a cancel button to the draft toolbar.

**Status:** New finding (not in previous review).

---

## Minor Issues

### 15. `useMemo` dependency array missing `isLoading` and `error`

**File:** `apps/mail/src/components/mail/email-sidebar.tsx:146`

```typescript
}, [mailboxes]);
```

The memo at line 106 also reads `isLoading` and `error` (line 134) to decide whether to show `defaultMailboxes`. These are not in the dependency array. If `isLoading` changes while `mailboxes` reference stays the same, the memo returns stale data.

**Fix:** Change to `}, [mailboxes, isLoading, error]);`

**Status:** Previously identified (issue #9). Confirmed still present.

### 16. `interface` used instead of `type` (9 instances)

Per CLAUDE.md, `type` is preferred over `interface`. The following use `interface`:

- `apps/mail/src/routes/__root.tsx:7` -- `interface MyRouterContext`
- `apps/mail/src/components/mail/email-sidebar.tsx:85` -- `interface AppSidebarProps`
- `apps/mail/src/components/mail/email-compose-button.tsx:8` -- `interface EmailComposeButtonProps`
- `apps/mail/src/components/mail/email-context-menu.tsx:15` -- `interface EmailContextMenuProps`
- `apps/mail/src/components/mail/email-detail.tsx:16` -- `interface EmailDetailToolbarProps`
- `apps/mail/src/components/mail/email-detail.tsx:108` -- `interface EmailDetailProps`
- `apps/mail/src/components/mail/email-list.tsx:13` -- `interface EmailListToolbarProps`
- `apps/mail/src/components/mail/email-list.tsx:30` -- `interface EmailListProps`
- `apps/mail/src/components/mail/email-draft.tsx:60` -- `interface EmailDraftProps`

Note: `interface` in `routeTree.gen.ts` (auto-generated) and `main.tsx` (module augmentation / declaration merging) is correct.

**Status:** Previously identified (issue #10). Confirmed still present.

### 17. JSDoc comment violates project rules

**File:** `apps/mail/src/components/mail/email-draft.tsx:11-15`

```typescript
/**
 * Checks the status of an email draft
 * @param draft The email draft to check
 * @returns Object with sendable and saveable status
 */
```

CLAUDE.md states "No JSDoc -- code should be self-documenting, minimal comments."

**Status:** Previously identified (issue #11). Confirmed still present.

### 18. Missing React `key` props in `formatContactObject`

**File:** `apps/mail/src/components/mail/email-detail.tsx:186-188`

```typescript
return contact.value.map((address, idx, arr) => (
    <><MailLink ... />{idx < arr.length - 1 ? ', ' : ''}</>
));
```

The fragment returned from `.map()` has no `key` prop. React will warn in development.

**Fix:** Use `<React.Fragment key={address.address || idx}>`.

**Status:** Previously identified (issue #12). Confirmed still present.

### 19. Dead/commented-out code

**File:** `apps/mail/src/components/mail/email-sidebar.tsx:194-224` -- ~30 lines of commented-out custom mailboxes and "New Folder" button.

**File:** `apps/mail/src/components/mail/email-draft.tsx:88` -- `getEmailDraftStatus` defined but usage commented out.

**Status:** Previously identified (issue #13). Confirmed still present.

### 20. `useToggleFlaggedEmail` hook exported but unused

**File:** `packages/lib/src/core/mail/hooks/use-emails.ts:112-129`

Defined and exported but never imported in the mail app. No "star" or "flag" toggle exists in the UI.

**Status:** Previously identified (issue #14). Confirmed still present.

### 21. Content-Disposition header injection in API route

**File:** `apps/api/src/routes/mail.ts:129`

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${params.fileName}"`;
```

The filename comes from the URL parameter without sanitization. A crafted filename containing `"` or newlines could inject headers. Also at line 48 with `params.id`.

**Fix:** Use RFC 5987 encoding (`filename*=UTF-8''...`) or strip `"`, `\r`, `\n` characters.

**Status:** Previously identified (issue #15). Confirmed still present.

### 22. Hardcoded `'unknown@example.com'` fallback

**File:** `apps/mail/src/components/mail/email-detail.tsx:158`

This fallback appears clickable via `UserItem` and `MailLink`. A user might attempt to reply to it.

**Fix:** Use an empty string or hide the email display when the address is unknown.

**Status:** Previously identified (issue #16). Confirmed still present.

### 23. Inconsistent variable naming: `isEmailsError`

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:57`

```typescript
const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
```

`isEmailsError` uses the `is` prefix (boolean convention) but holds an `Error | null` object.

**Fix:** Rename to `emailsError`.

**Status:** Previously identified (issue #17). Confirmed still present.

### 24. Sequential bulk operations cause N round-trips

**File:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:126-155`, `apps/mail/src/routes/__root.tsx:31-34`

All bulk handlers (`handleDeleteEmailsByIds`, `handleMoveEmailsToFolderByIds`, `handleArchiveEmailsByIds`, `handleReportSpamByIds`, `handleMoveByDrop`) use sequential `for...of` + `await` loops. Each operation triggers its own cache invalidation, causing N refetches.

**Fix:** Use `Promise.all` for parallel execution, or implement batch API endpoints.

**Status:** Previously identified (issue #8). Now also affected by the missing `await` issue (#6 above) which makes the sequencing even more broken.

### 25. `ShadowContent` renders `innerHTML` without client-side sanitization

**File:** `packages/ui/src/components/layout/shadow-content.tsx:51`

The previous review flagged this as a critical XSS vulnerability. After deeper investigation, the server sanitizes `html` content with DOMPurify during email parsing (`apps/api/src/lib/mail/mail-parse.ts:10`). `textAsHtml` is generated by `textToHtml()` which uses `he.encode()` for HTML escaping, so it is also safe.

However, `ShadowContent` is a generic shared component -- any caller passing unsanitized HTML would be vulnerable. There is no defense-in-depth on the client side. If a code path ever bypasses server sanitization (e.g. locally constructed HTML, or a new feature), `innerHTML` will execute scripts.

**Impact:** Low for mail currently (server-side DOMPurify covers it), but the component itself is architecturally fragile.

**Fix:** Consider adding client-side DOMPurify as defense-in-depth in `ShadowContent` when `contentType === "html"`, or document the contract that callers must sanitize.

**Status:** Previously identified as critical (issue #1). Downgraded to minor after verifying server-side sanitization exists. The component's lack of self-defense is still a concern.

### 26. `needsToShowTo` / `needsToShowCc` / `needsToShowBcc` uses `> 1` threshold

**File:** `apps/mail/src/components/mail/email-detail.tsx:160-162`

```typescript
const needsToShowTo = email.to ? (Array.isArray(email.to) ? email.to.length > 1 : email.to.value.length > 1) : false;
```

The details section only shows when there are 2+ addresses. A single `To` address is hidden from the expanded details table. This means the only place the user can see who the email was addressed to is in the collapsed summary, which may be truncated.

**Fix:** Use `>= 1` or always show the To field in the expanded view.

**Status:** New finding (not in previous review).

---

## Observations

- The overall architecture follows project conventions well: AppShell, ColumnLayout, data hooks in `packages/lib`, SSE handlers, and the auth guard pattern.
- The mail app is compact (~6 components, 4 routes, 3 hooks + SSE handler) but handles a wide range of functionality: list, detail, compose, reply, forward, context menu, keyboard nav, drag-and-drop, mobile responsive layout.
- Client-side search (filter by subject/from/text on already-loaded data) is adequate for small mailboxes but will not scale. No server-side search exists.
- No virtualization on the email list -- large mailboxes will render all items, causing performance issues.
- The compose flow is text-only (no rich text, no attachment upload). This is likely a known limitation.
- Date formatting uses both `date-fns` (`format`) and native `Date.toLocaleDateString`/`toLocaleTimeString`. The native methods respect the user's locale, while `date-fns` format strings are hardcoded English. This is inconsistent but not broken.
- The `useEmail` hook uses `staleTime: Infinity`, meaning individual email details are never refetched once cached. This is appropriate since email content does not change, but draft edits from another tab would not propagate.
- The `MailLink` component constructs full URLs to the mail app using `import.meta.env.VITE_APP_MAIL_URL` (line 129 of `email-detail.tsx`), which provides proper cross-app linking.
