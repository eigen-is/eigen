# Notification System

> **TLDR:** The toast contract. Error toasts come from `onMutationError` in the mutation hooks under `packages/lib/src/core/[domain]/hooks/`, so an app never toasts a mutation's error itself. Success toasts are rare and live in the hook too. A toast's action button needs `pointer-events` of its own, because it often appears over a modal. Persistent cross-user notifications are a different system: [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md).

## Error toasts come from the mutation hook

Every `useMutation` in `packages/lib/src/core/[domain]/hooks/` hands its error to `onMutationError` (`packages/lib/src/core/api-error.ts`), which calls `toast.error(getErrorMessage(error))`. An optimistic mutation rolls its cache back first and then calls it. One place owns the wording, so every app says the same thing for the same failure.

`AppError` keeps the HTTP status of an Eden response, so the toast reads as a message and its status, like "Too large (413)". The message comes from the response body: a plain string (what every `ApiError` returns), else its `message`, else its `summary`, else the first `errors` entry. A body with none of those falls back to a phrase for the status, because Elysia strips a validation error down to `{ type, on, found }` in production, and `String()` on that reads as `[object Object]`.

## Apps never catch a mutation error to toast it

An app must not wrap a mutation in `try/catch` + `toast.error()`: the hook already toasted, and the user would see it twice. An app catches only when it has extra work to do on failure, such as resetting UI state, and then it shows no toast.

A caller that awaits `mutateAsync` and must still see other rejections asks `wasToasted(error)`: `onMutationError` records every error it toasts, so the caller swallows exactly those (`CardForm` does this).

A hook that recovers an expected error shows its own message instead and skips `onMutationError`. A contact write that meets a 412 reloads the list and says the contact changed elsewhere (`handleStaleWrite` in `use-contacts.ts`).

## A success toast is for a result the user can't see

Most mutations need no success toast: the UI update from cache invalidation is the feedback. Add one only when the result isn't visible: the user navigated away, the change is subtle, or the work runs in the background. `useSendDraft` says "Email sent" because the user left the draft. `useUpdateACL` says "Sharing updated" because an access change shows nowhere else. Grep `toast.success` under `packages/lib/src/core` for the rest.

The toast lives in the hook's `onSuccess`, next to the mutation, never in a component. One call site owns both the request and its feedback, and every app gets the same wording.

A toast that is not one mutation's outcome is raised where the action is: mail's Undo toast after an archive (`apps/mail/src/components/mail/hooks/use-mail-actions.ts`) spans several mutations, and a paste with nothing to place is no request at all.

## A toast action works over a modal dialog

A toast with an `action` (the "Open folder" row after a save to Drive) is often raised from inside a modal. `SaveToDrivePicker` awaits its mutation, so the picker is still open when the hook toasts, and a convert stacks the progress dialog on top. A Radix modal parks `pointer-events: none` on `<body>` for as long as one is mounted, and the toaster lives under `<body>`. So `Toaster` gives every toast `pointer-events: auto` of its own (`packages/ui/src/components/sonner.tsx`). Without it the action draws and swallows every click.

## Cross-user events are notifications, not toasts

Shares, invites, mentions, incoming mail and watched-file activity persist a row in the recipient's notification center and broadcast one `notification:created` SSE event. `handleNotificationSSEvent()` turns that event into the toast and refreshes the bell. Domain SSE handlers only invalidate caches and never toast, so one event never shows twice.

## See also

- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md): the sources, storage and coalescing of persistent notifications
- [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md): what each notification row says and where it links
- [SSE.md](SSE.md): the event stream that carries them
