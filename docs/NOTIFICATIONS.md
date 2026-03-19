# Notification System

Notifications follow a three-layer pattern: error toasts in hooks, success toasts for fire-and-forget operations,
and curated remote event notifications in SSE handlers.

## 1. Error toasts -- centralized in mutation hooks

Every `useMutation` in `packages/lib/src/core/[domain]/hooks/` has `onError: onMutationError` which calls
`toast.error(getErrorMessage(error))`. The `AppError` class preserves the HTTP status code from Eden Treaty
responses, so errors show as e.g. "Not enough storage (413)".

Apps must NOT add their own `try/catch` + `toast.error()` around mutations -- the hook already does it.
Apps only need `try/catch` when they must do extra work on failure (e.g., reset UI state), and in that case
they must NOT show a toast.

See: `packages/lib/src/core/api-error.ts`

## 2. Success toasts -- only for fire-and-forget operations

Most mutations don't need success toasts -- the UI update from cache invalidation is the feedback. Success toasts
are added only to hooks where the result isn't immediately visible:

| Hook                      | Toast                    | Why                             |
|---------------------------|--------------------------|---------------------------------|
| `useSendDraft`            | "Email sent"             | User navigated away from drafts |
| `useUpdateSpaceSettings`  | "Settings saved"         | Subtle change                   |
| `useUpdateTeamSettings`   | "Team settings saved"    | Subtle change                   |
| `useUpdateServerSettings` | "Server settings saved"  | Subtle change                   |
| `useUpdateServerS3Config` | "S3 configuration saved" | Subtle change                   |
| `useUpdateACL`            | "Sharing updated"        | Confirmation of access change   |

## 3. Remote event notifications -- curated in SSE handlers

`SSEProvider` no longer shows generic toasts for all SSE events. Instead, specific SSE handlers show toasts only
for events that genuinely need user attention.

### SSE event routing

SSE events are per-user (each user subscribes to their own Home's event stream via `requireSelf()`). Events fall
into two categories:

**Self-triggered events** -- your own action bounces back to your Home for cache invalidation. These never need
a toast because the UI already reflects the change:

- All drive CRUD (create, delete, rename, move, upload)
- All mail operations (delete, move, read, flag, draft, sent)
- All calendar CRUD (create/update/delete events and calendars)
- All contacts/labels
- Chat messages (emitted on the chat room owner's Home)

**Recipient-only events** -- explicitly propagated to another user's Home. The actor never receives these. These
are the only events that show toasts:

| SSE Handler | Event                      | Toast                          | Propagation mechanism                            |
|-------------|----------------------------|--------------------------------|--------------------------------------------------|
| Mail        | `mail:received`            | "New email -- From X: subject" | `doSyncMailbox()` on recipient's maildir         |
| Drive       | `drive:acl-shared`         | "Item shared with you -- name" | `propagateACLChange()` → recipient's home        |
| Drive       | `drive:acl-unshared`       | "Item unshared -- name"        | `propagateACLChange()` → recipient's home        |
| Calendar    | `calendar:shared`          | "Calendar shared -- name"      | `notifySharedCalendarUsers()` → recipient's home |
| Calendar    | `calendar:unshared`        | "Calendar unshared -- name"    | `notifySharedCalendarUsers()` → recipient's home |
| Calendar    | `calendar:invite-received` | "New invitation -- title"      | `propagateInvitation()` → attendee's home        |

### What does NOT show a toast

- Your own drive operations -- the UI already reflects these
- Your own contact/label changes -- single-user domain, UI updates immediately
- Your own calendar event changes -- calendar view updates via cache invalidation
- Settings changes from yourself -- the hook's `onSuccess` toast confirms it
- Shared drive file activity from collaborators -- too spammy; visible when they navigate there
- Mail operations you initiated (delete, move, flag) -- UI reflects these immediately
- Chat messages -- no way to distinguish your own messages from others' (chat room owner's Home receives all)

## SSEventNotification type

The `SSEventNotification` mixin (`{body, tag?, link?}`) is still defined in `packages/lib/src/types/sse.ts` and
used in the SSE event type definitions. The frontend no longer checks `isSSEventNotification()` to decide what to
toast, but the type is kept for two reasons:

1. SSE event builders on the backend still produce `body`/`title`/`link` fields
2. These fields map directly to a future notification DB schema

## Future: Notification Center

Replace toasts with a notification bell/dropdown that accumulates events. The backend would:

1. Store notifications in a per-user `notifications` table (`id, userId, type, title, body, link, read, createdAt`)
2. Push via SSE for real-time delivery (ephemeral)
3. Use `isSSEventNotification()` on the backend to decide which events to persist

The frontend notification center would:

- On load: fetch unread notifications from the API
- On SSE event: append to the list in real-time
- Mark as read when clicked/dismissed

The `SSEventNotification` type's `tag` field enables deduplication (e.g., multiple messages in same chat → one
notification). The `link` field provides click-to-open behavior.

## Related Files

- `packages/lib/src/core/api-error.ts` -- `AppError`, `getErrorMessage`, `onMutationError`
- `packages/lib/src/types/sse.ts` -- `SSEvent` types, `SSEventNotification` mixin
- `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` -- just calls `useSSE()`, no toasts
- `packages/lib/src/core/sse/hooks/use-sse.ts` -- dispatches SSE events to domain handlers
- `packages/lib/src/core/[domain]/sse-handlers.ts` -- cache invalidation + curated notification toasts
- `packages/lib/src/core/[domain]/hooks/*.ts` -- `onError` + selective `onSuccess` toasts
- `apps/api/src/lib/drive/acl-propagation.ts` -- drive share propagation to recipients
- `apps/api/src/lib/calendar/share-propagation.ts` -- calendar share propagation
- `apps/api/src/lib/calendar/invite-propagation.ts` -- calendar invite propagation
