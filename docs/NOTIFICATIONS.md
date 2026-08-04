# Notification System

> **TLDR**: The toast contract. Error toasts come from `onMutationError` on every `useMutation` in
> `packages/lib/src/core/[domain]/hooks/` — apps never toast errors themselves. Success toasts are rare and also
> live in the hook, next to the mutation. Persistent cross-user notifications are a different system:
> [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md).

## 1. Error toasts — centralized in mutation hooks

Every `useMutation` in `packages/lib/src/core/[domain]/hooks/` has `onError: onMutationError` which calls
`toast.error(getErrorMessage(error))`. The `AppError` class preserves the HTTP status code from Eden Treaty
responses, so errors show as e.g. "Insufficient Storage (507)".

Apps must NOT add their own `try/catch` + `toast.error()` around mutations — the hook already does it.
Apps only need `try/catch` when they must do extra work on failure (e.g., reset UI state), and in that case
they must NOT show a toast.

See: `packages/lib/src/core/api-error.ts`

## 2. Success toasts — only for fire-and-forget operations

Most mutations don't need a success toast — the UI update from cache invalidation is the feedback. Add one only
when the result isn't immediately visible: the user navigated away, the change is subtle, or the work happens in
the background.

The rule: a success toast lives in the hook's `onSuccess`, right next to the mutation — never in a component.
That way one call site owns both the request and its feedback, and every app gets the same wording for free.
Current examples: `useSendDraft` ("Email sent" — the user left the drafts view), `useUpdateACL` ("Sharing updated"
— confirms an access change with no other visible effect), `useSaveVersion` ("Version saved"). About seventeen
`toast.success` calls exist across `packages/lib/src/core` today; grep for them rather than trusting a list here.

## 3. Persistent notifications

Cross-user events (shares, invites, mentions, incoming mail, watched-file activity) do not use these toasts. They
persist a row in the recipient's `NotificationCenter` and broadcast one `notification:created` SSE event; the
frontend `handleNotificationSSEvent()` turns that into the toast and refreshes the bell. Domain SSE handlers only
invalidate caches — they never toast.

See [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) for the sources, storage and coalescing, and
[ACTIVITY-ROWS.md](ACTIVITY-ROWS.md) for what each row says and where it links.
