# Notification System

Notifications follow a three-layer pattern: error toasts in hooks, success toasts for fire-and-forget operations,
and persistent notifications via the notification center.

## 1. Error toasts — centralized in mutation hooks

Every `useMutation` in `packages/lib/src/core/[domain]/hooks/` has `onError: onMutationError` which calls
`toast.error(getErrorMessage(error))`. The `AppError` class preserves the HTTP status code from Eden Treaty
responses, so errors show as e.g. "Not enough storage (413)".

Apps must NOT add their own `try/catch` + `toast.error()` around mutations — the hook already does it.
Apps only need `try/catch` when they must do extra work on failure (e.g., reset UI state), and in that case
they must NOT show a toast.

See: `packages/lib/src/core/api-error.ts`

## 2. Success toasts — only for fire-and-forget operations

Most mutations don't need success toasts — the UI update from cache invalidation is the feedback. Success toasts
are added only to hooks where the result isn't immediately visible:

| Hook                      | Toast                    | Why                             |
|---------------------------|--------------------------|---------------------------------|
| `useSendDraft`            | "Email sent"             | User navigated away from drafts |
| `useUpdateSpaceSettings`  | "Settings saved"         | Subtle change                   |
| `useUpdateTeamSettings`   | "Team settings saved"    | Subtle change                   |
| `useUpdateServerSettings` | "Server settings saved"  | Subtle change                   |
| `useUpdateServerS3Config` | "S3 configuration saved" | Subtle change                   |
| `useUpdateACL`            | "Sharing updated"        | Confirmation of access change   |
| `useEmailCollaborators`   | "Email sent"             | Email sent in background        |

## 3. Persistent notifications — via notification center

Cross-user events (shares, invites, mentions, incoming mail) create persistent notifications in the recipient's
`NotificationCenter`. Each notification is written to a per-user SQLite database and an SSE event
(`notification:created`) is broadcast with `title` + `body` for the toast.

The frontend `handleNotificationSSEvent()` shows the toast and invalidates notification queries. Domain SSE
handlers do NOT show toasts — they only invalidate caches.

See [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) for the full architecture.

### What creates notifications

| Event                  | Notification title                    | Source                     |
|------------------------|---------------------------------------|----------------------------|
| Drive share            | `"file" was shared with you`          | `Drive.receiveACLChange()` |
| Drive unshare          | `"file" is no longer shared with you` | `Drive.receiveACLChange()` |
| Calendar share         | `"calendar" was shared with you`      | `Calendar.receiveShare()`  |
| Calendar unshare       | `"calendar" is no longer shared`      | `Calendar.removeShare()`   |
| Calendar invite        | `New invitation: "event"`             | `invite-propagation.ts`    |
| Calendar invite update | `Updated: "event"`                    | `invite-propagation.ts`    |
| Calendar invite cancel | `Cancelled: "event"`                  | `invite-propagation.ts`    |
| Incoming mail          | `New email` + sender/subject          | `Maildir` sync             |
| Chat @mention          | `You were mentioned in "chat"`        | `ChatRoom.postMessage()`   |
| Comment @mention       | `You were mentioned in "doc"`         | `ChatRoom.postMessage()`   |

### What does NOT create notifications

- Your own drive operations — the UI already reflects these
- Your own contact/label changes — single-user domain
- Your own calendar event changes — calendar view updates via cache invalidation
- Settings changes from yourself — the hook's `onSuccess` toast confirms it
- Shared drive file activity from collaborators — too spammy
- Mail operations you initiated (delete, move, flag) — UI reflects these immediately

## Related Files

- `packages/lib/src/core/api-error.ts` — `AppError`, `getErrorMessage`, `onMutationError`
- `packages/lib/src/types/sse.ts` — `SSEvent` types (minimal cache-invalidation payloads)
- `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` — just calls `useSSE()`, no toasts
- `packages/lib/src/core/sse/hooks/use-sse.ts` — dispatches SSE events to domain handlers
- `packages/lib/src/core/[domain]/sse-handlers.ts` — cache invalidation only (no toasts)
- `packages/lib/src/core/notification/sse-handlers.ts` — shows toasts for `notification:created`
- `packages/lib/src/core/[domain]/hooks/*.ts` — `onError` + selective `onSuccess` toasts
- `apps/api/src/lib/notification-center/` — `NotificationCenter` domain service
