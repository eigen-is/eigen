# FE Code Review: Mail

## Summary

The mail frontend is a functional email client with a clean two-column layout, context menus, drag-and-drop between
mailboxes, keyboard navigation, and multi-select. Hooks are properly organized in `packages/lib/src/core/mail/hooks/`.
The main issues are: missing `await` on `handleNewDraftEmail` calls in reply/forward handlers, missing error feedback
(`try/catch` + `toast.error`) on multiple `mutateAsync` calls, `ownerId` missing from query keys, and several minor
code quality issues (interface vs type, missing React keys, inconsistent mailbox case handling in SSE invalidation).

## Critical Issues

### 1. Missing `await` on `handleNewDraftEmail` in reply/forward handlers

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/_auth.$filterType.$filterId.tsx`, lines 167,
  186, 199
- **Issue**: `handleNewDraftEmail` is an `async` function (line 114), but its return value is not awaited in
  `handleReplyEmail`, `handleReplyAllEmail`, and `handleForwardEmail`:
  ```typescript
  handleNewDraftEmail(createDraftEmail({...}));  // no await
  ```
- **Why it matters**: CLAUDE.md: "Always `await` async calls -- missing `await` is the #1 bug class in this codebase.
  A bare async call returns a truthy Promise, silently skipping the intended logic." If the `mutateAsync` inside
  `handleNewDraftEmail` throws, the error is unhandled (becomes an unhandled promise rejection). The navigation to the
  draft also doesn't wait for the draft to be created, which could cause a race where `mailId` is set before the
  draft exists.
- **Suggested fix**: Add `await` before each call:
  ```typescript
  await handleNewDraftEmail(createDraftEmail({...}));
  ```

### 2. Missing error feedback on multiple `mutateAsync` calls

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/_auth.$filterType.$filterId.tsx`
- **Issue**: Several handlers call `mutateAsync` without `try/catch` + `toast.error`:
    - `handleDeleteEmail` (line 90): `await deleteMail.mutateAsync(mail)` -- no try/catch
    - `confirmDeleteEmail` (line 97): `await deleteMail.mutateAsync(pendingDeleteMail)` -- no try/catch
    - `handleMoveEmail` (line 105): `await moveMail.mutateAsync(...)` -- no try/catch
    - `handleSendEmail` (line 110): `await sendDraft.mutateAsync(mail)` -- no try/catch
    - `handleNewDraftEmail` (line 115): `await updateDraft.mutateAsync(mail)` -- no try/catch
- **Why it matters**: CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with
  `toast.error()`, or use the `onError` callback. Never swallow errors by catching and returning null." If any of
  these calls fail (network error, server error), the user sees no feedback and the UI may be in an inconsistent
  state (e.g., navigated away but action didn't complete).
- **Suggested fix**: Wrap each `mutateAsync` call in try/catch with `toast.error()`, or add `onError` callbacks to
  the mutation hooks themselves.

### 3. Missing error feedback on mutation hooks in `packages/lib`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`
- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-draft.ts`
- **Issue**: None of the mutation hooks (`useDeleteEmail`, `useToggleReadEmail`, `useToggleFlaggedEmail`,
  `useMoveEmail`, `useUpdateDraft`, `useSendDraft`) have `onError` callbacks. Combined with the missing try/catch
  at the call sites, errors are completely silent.
- **Suggested fix**: Add `onError: () => toast.error('...')` to each mutation hook, or ensure all call sites wrap
  in try/catch.

## Pattern Violations

### Missing `ownerId` in query keys

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-mailboxes.ts`, lines 5-12
- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, lines 6-12
- **Issue**: `mailboxKeys` and `emailKeys` do not include `ownerId` in their key hierarchy. The key structures are
  `['mailboxes', 'list']` and `['emails', 'list', {mailbox}]` respectively.
- **Why it matters**: CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data. Without it, switching
  between personal and team contexts serves stale cached data from the wrong owner." While mail is personal-only
  today, this violates the established pattern and could cause issues if the data model ever changes.
- **Suggested fix**: Add `ownerId` as the second element:
  ```typescript
  export const emailKeys = {
      all: (ownerId: string) => ['emails', ownerId] as const,
      lists: (ownerId: string) => [...emailKeys.all(ownerId), 'list'] as const,
      // ...
  };
  ```

### `useEmails` lowercases mailbox path before sending to API

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, line 21
- **Issue**: `mailboxPath.toLowerCase()` is called before sending to the API. The backend now uses canonical case
  (`Sent`, `Drafts`) and has `canonicalMailbox()` normalization. The frontend also lowercases in the query key
  (line 19: `emailKeys.list(mailboxPath)` where `mailboxPath` comes from the URL). This creates a mismatch: the
  query key uses the original case from the URL, but the API request uses lowercase.
- **Why it matters**: The sidebar links use lowercase paths (`/box/drafts`, `/box/sent`), so the query key is
  lowercase. The API normalizes lowercase to canonical case. This works but is fragile -- if the frontend ever
  passes canonical case, the query key would be different from before, causing cache misses.
- **Suggested fix**: Remove the `.toLowerCase()` call since the backend's `canonicalMailbox()` handles
  normalization. Alternatively, normalize both the query key and API call to the same case.

### `interface` used instead of `type` in multiple files

- **Files**:
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/__root.tsx`, line 7: `interface MyRouterContext`
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-context-menu.tsx`, line 16
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-sidebar.tsx`, line 85
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-list.tsx`, lines 13, 30
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-compose-button.tsx`, line 8
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-draft.tsx`, line 60
    - `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-detail.tsx`, lines 17, 109
- **Issue**: CLAUDE.md: "Always `type` over `interface` -- except when methods are needed." These are all pure data
  shape definitions.
- **Suggested fix**: Convert `interface` declarations to `type` declarations.

### SSE handler normalizes `''` to `'inbox'` but query keys use URL path

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/sse-handlers.ts`, line 15
- **Issue**: `normalizeMailbox` maps `''` to `'inbox'`. The query key for INBOX emails is
  `emailKeys.list('inbox')` (since the URL path is `/box/inbox`). Backend SSE events send `mailbox: ''` for INBOX.
  The normalization ensures the invalidation targets the correct query key. However, this creates a tight coupling
  between the URL structure and the SSE handler.
- **Why it matters**: If the URL structure changes (e.g., uses `''` instead of `'inbox'`), the SSE invalidation
  breaks silently.

### `invalidateMailReceived` is hardcoded to `'inbox'`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, line 154
- **Issue**: `invalidateMailReceived` hardcodes `emailKeys.list('inbox')`. If mail is delivered to a non-INBOX
  mailbox (e.g., via server-side rules), the SSE event carries the correct mailbox, but the handler in
  `sse-handlers.ts` (line 27) calls `invalidateMailReceived(queryClient)` which only refreshes INBOX.
- **Suggested fix**: Pass the mailbox from the event data:
  ```typescript
  export function invalidateMailReceived(queryClient: QueryClient, mailbox: string): void {
      queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
  }
  ```

## Security Concerns

### Attachment download uses `user!.id` non-null assertion

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-detail.tsx`, line 294
- **Issue**: `getMailAttachmentUrl(user!.id, ...)` uses a non-null assertion. If `user` is somehow null (auth
  race condition, component rendered before auth check), this crashes.
- **Why it matters**: Low risk since the component is behind an auth guard, but defensive programming would handle
  this gracefully.
- **Suggested fix**: Guard with `if (!user) return` before the click handler, or use optional chaining.

### Context menu download uses `user!.id` non-null assertion

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-context-menu.tsx`, line 124
- **Issue**: Same pattern: `getMailMessageDownloadUrl(user!.id, firstId)`.
- **Suggested fix**: Same as above.

## Data Integrity

### `useEmails` returns `Email[]` but API returns `EmailSummary[]`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/mail/hooks/use-emails.ts`, lines 20-22
- **Issue**: The query function declares `Promise<Email[]>` and casts `(response.data || []) as Email[]`, but the
  `/mail/:ownerId/mailbox/:mailboxPath` endpoint returns `EmailSummary[]` (from `maildb.getAllEmails`). `Email`
  includes parsed fields like `html`, `text`, `attachments`, `from`, `to`, etc. that are not present in the
  list response.
- **Why it matters**: Frontend components that access `email.html` or `email.from` on list items get `undefined`,
  which may cause subtle rendering issues. The type cast hides this mismatch.
- **Suggested fix**: Change the return type to `EmailSummary[]` and update components to only access summary fields
  from list data. Use the separate `useEmail(id)` hook for full email data.

### `displayEmails` optimistic update is fragile

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/_auth.$filterType.$filterId.tsx`, lines 64-67
- **Issue**: When a selected email is in the list, `displayEmails` creates a new array with `isRead: true` merged
  in. This is an inline optimistic update outside of TanStack Query's cache. If the email list re-renders from cache,
  this override is recomputed. But if the list refetches (e.g., from SSE invalidation), the server state takes over.
- **Why it matters**: Minor -- the UX intent is correct (show as read immediately), but this pattern diverges from
  the project standard of using `queryClient.setQueryData()` or `invalidateQueries()`.

### Draft auto-save is not implemented

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-draft.tsx`
- **Issue**: The draft component reads values from refs on submit but never auto-saves. If the user types a long
  email and navigates away or the browser crashes, the content is lost.
- **Why it matters**: Data loss risk for the user. This is a UX concern rather than a code bug.
- **Suggested fix**: Add a debounced auto-save that calls `updateDraftEmail` periodically while the user is editing.

## Code Quality

### Missing React keys in `formatContactObject`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-detail.tsx`, line 188
- **Issue**: The `contact.value.map(...)` returns JSX fragments without `key` props:
  ```typescript
  contact.value.map((address, idx, arr) => (
      <><MailLink .../>{idx < arr.length - 1 ? ', ' : ''}</>
  ))
  ```
- **Why it matters**: React will warn about missing keys in development, and it can cause rendering bugs when the
  list changes.
- **Suggested fix**: Add `key={address.address || idx}` to the fragment.

### Inconsistent error variable naming

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/_auth.$filterType.$filterId.tsx`, line 59
- **Issue**: `error: isEmailsError` -- the destructured name `error` is renamed to `isEmailsError`, but it's not a
  boolean. `isEmailsError` suggests a boolean (`isX` convention), but it's actually an `Error | null`.
- **Suggested fix**: Rename to `emailsError` to match the convention used elsewhere.

### `useEffect` dependency for `toggleMailRead` may cause infinite loop

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-detail.tsx`, lines 143-148
- **Issue**: The `useEffect` depends on `[email, toggleMailRead]`. `toggleMailRead` is a function passed as a prop,
  which creates a new reference on every render of the parent (it's an inline arrow on line 293:
  `toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}`). This could cause the effect to
  re-fire on every render. The `hasMarkedAsRead` ref prevents actual re-marking, so it won't cause an infinite
  mutation loop, but the effect runs unnecessarily.
- **Suggested fix**: Stabilize `toggleMailRead` with `useCallback` in the parent, or remove it from the dependency
  array (using an ESLint disable comment).

### Large monolithic route component

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/_auth.$filterType.$filterId.tsx`
- **Issue**: The `MailRoute` function is ~260 lines with 15+ handler functions, multiple state variables, and
  complex JSX. It's the entire mail app's logic in one component.
- **Why it matters**: Difficult to test, read, and maintain.
- **Suggested fix**: Extract handler logic into custom hooks (e.g., `useMailActions`) and break the JSX into smaller
  components.

### `useMemo` used incorrectly for `getCurrentDraft`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-draft.tsx`, line 116
- **Issue**: `useMemo` wraps a function that returns another function. The inner function reads from refs (which are
  mutable), so the memoized function always reads current values. This works but `useMemo` adds no benefit here --
  it's essentially `useCallback` semantics but using the wrong hook.
- **Suggested fix**: Use `useCallback` instead, or just define a regular function inside the component.

### `email-sidebar.tsx` `useMemo` has incomplete dependency array

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-sidebar.tsx`, line 146
- **Issue**: `useMemo` depends on `[mailboxes]` but the computation also uses `isLoading` and `error` (line 134).
  If loading state changes, the memo won't recompute.
- **Suggested fix**: Add `isLoading` and `error` to the dependency array:
  ```typescript
  }, [mailboxes, isLoading, error]);
  ```

### Context menu move targets use `mailbox.name` instead of `mailbox.path`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/components/mail/email-context-menu.tsx`, line 146
- **Issue**: `onMoveToFolder?.(messageIds, mailbox.name === 'INBOX' ? '' : mailbox.name)` uses `mailbox.name` as
  the move target. But `mailbox.name` is the display name (e.g., "Spam" for the Junk folder -- see sidebar
  `standardMailboxes` mapping). The backend expects the canonical mailbox path (`Junk`, not `Spam`).
- **Why it matters**: Moving to "Spam" via context menu would fail with a 404 because the backend mailbox is named
  `Junk`. The sidebar correctly uses `mailbox.path`, but the context menu uses `mailbox.name`.
- **Suggested fix**: Use `mailbox.path` instead of `mailbox.name`:
  ```typescript
  onMoveToFolder?.(messageIds, mailbox.path === '' ? '' : mailbox.path);
  ```

### `handleMoveByDrop` in `__root.tsx` lacks error handling

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/mail/src/routes/__root.tsx`, lines 30-35
- **Issue**: The drag-and-drop move handler calls `moveMail.mutateAsync` in a loop with no try/catch. If one move
  fails, subsequent moves are skipped and the user gets no feedback.
- **Suggested fix**: Add try/catch with `toast.error()`.

## Architecture

### Hooks follow the shared-hooks pattern correctly

All data access hooks (`useMailboxes`, `useEmails`, `useEmail`, `useDeleteEmail`, `useMoveEmail`, etc.) live in
`packages/lib/src/core/mail/hooks/` as required by CLAUDE.md. No `useQuery`/`useMutation` calls exist directly in
app components.

### SSE handler follows the established pattern

`handleMailSSEvent` in `packages/lib/src/core/mail/sse-handlers.ts` correctly dispatches by event type, calls the
appropriate invalidation functions, and returns a boolean indicating whether the event was handled.

### Export structure is clean

`packages/lib/src/core/mail/index.ts` re-exports hooks and SSE handlers. The app imports from `@workspace/lib/mail`.

## Positive Patterns

- **Hooks in shared package**: All data hooks live in `packages/lib/src/core/mail/hooks/` as required. App code uses
  them exclusively.
- **SSE integration**: Every backend mutation has a corresponding SSE event, and the frontend handler invalidates the
  appropriate queries.
- **Context menu with multi-select**: The email list supports multi-select (shift/ctrl click) with context menu
  operations that work on all selected items.
- **Drag-and-drop**: Emails can be dragged to sidebar mailboxes. The `DroppableSidebarItem` component handles drop
  targets cleanly.
- **Keyboard navigation**: `useKeyboardListNavigation` provides arrow key navigation in the email list.
- **Theme tokens**: All colors use semantic tokens (`text-muted-foreground`, `bg-background`, `border`, etc.).
  No hardcoded color values found.
- **Column layout**: Uses the shared `ColumnLayout` + `Column` components with responsive mobile switching.
- **Auth guard**: The `_auth.tsx` route guard redirects unauthenticated users to login.
- **Delete confirmation**: Permanent deletion (from Trash) shows a confirmation dialog.

## Recommendations

| Priority | Issue                                                                | Location                                            |
|----------|----------------------------------------------------------------------|-----------------------------------------------------|
| P0       | Add `await` to `handleNewDraftEmail` calls in reply/forward handlers | `_auth.$filterType.$filterId.tsx:167,186,199`       |
| P0       | Add try/catch + `toast.error()` to all `mutateAsync` calls           | `_auth.$filterType.$filterId.tsx:90,97,105,110,115` |
| P1       | Add `onError` callbacks to mutation hooks                            | `use-emails.ts`, `use-draft.ts`                     |
| P1       | Fix context menu move using `mailbox.name` instead of `mailbox.path` | `email-context-menu.tsx:146`                        |
| P1       | Add `ownerId` to query keys                                          | `use-mailboxes.ts:5`, `use-emails.ts:6`             |
| P1       | Fix `useEmails` return type: `Email[]` should be `EmailSummary[]`    | `use-emails.ts:20`                                  |
| P2       | Fix `invalidateMailReceived` to accept mailbox parameter             | `use-emails.ts:153`                                 |
| P2       | Fix `useMemo` dependency array in `email-sidebar.tsx`                | `email-sidebar.tsx:146`                             |
| P2       | Add React keys to `formatContactObject` JSX                          | `email-detail.tsx:188`                              |
| P2       | Convert `interface` to `type` across all component files             | Multiple files                                      |
| P2       | Stabilize `toggleMailRead` callback or remove from effect deps       | `email-detail.tsx:148`                              |
| P2       | Add error handling to `handleMoveByDrop`                             | `__root.tsx:30-35`                                  |
| P2       | Remove `.toLowerCase()` from `useEmails` API call                    | `use-emails.ts:21`                                  |
| P2       | Remove dead code in `email-sidebar.tsx`                              | `email-sidebar.tsx:193-224`                         |
| P2       | Extract `MailRoute` handler logic into custom hook(s)                | `_auth.$filterType.$filterId.tsx`                   |
