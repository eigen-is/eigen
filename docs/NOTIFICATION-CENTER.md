# Notification Center

> **TLDR:** `NotificationCenter` (`apps/api/src/lib/notification-center/`) is a per-user SQLite service on the home, like calendar and contacts. A producer calls `home.notifications.persist({...})` in the recipient's home, usually through `sendToHome`. The row upserts on its `tag`, so repeats fold into one refreshed row, and a `notification:created` event makes the toast and refreshes the topbar bell. Not obvious from the code: the tag is both the row's identity and the source of its link, `coalesce` suppresses the toast but never the row, and team homes have no notification center. What each row says and where it links: [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md).

## Every user and guest home has its own notification database

`UserHome` and `GuestHome` create a `NotificationCenter` over `eigen.notifications/notifications.db` in the home folder. A `TeamHome` has none, and `sendToHome` persists through `home.notifications?.persist`, so a notification addressed to a team id is dropped. A team action therefore notifies each affected user in their own home. The routes (`apps/api/src/routes/notification.ts`) are self-only.

## Notifications and domain events are separate broadcasts

A cross-user event does two things. `persist()` writes the row and broadcasts `notification:created`, which `handleNotificationSSEvent()` turns into the toast and a refreshed bell. The producer's own `home.broadcast(domainEvent)` invalidates the domain's query caches. Toasts come only from the notification handler, and domain SSE handlers never toast, so one event never shows twice. Read, read-all and dismiss broadcast `notification:changed`, which refetches the bell without a toast.

## A notification's tag is its identity

The `tag` column is `UNIQUE`, and `persist()` is an `INSERT ... ON CONFLICT(tag) DO UPDATE`. A repeat with the same tag refreshes the existing row: new title, body, actor and details, unread again, and `createdAt` set to now, so it moves to the top. Twenty mentions in one chat are one row, not twenty. A row without a tag never folds, because SQLite treats NULLs as distinct.

The tag also carries the ids the link is built from, so each producer's tag decides both what folds together and where the row leads.

| Type | Producer | Tag |
|---|---|---|
| `share` / `unshare` | `receiveSharedPathChange` (`lib/drive/shared-with-me.ts`) | `share:{ownerId}:{mountId}:{pathId}` / none |
| `calendar-share` / `calendar-unshare` | `lib/calendar/shares.ts` | `calendar-share:{calId}:{ownerUserId}` / none |
| `calendar-invite`, `-updated`, `-cancelled` | `lib/calendar/invitations.ts` | `calendar-invite:{eventId}:{startTime}`, shared by all three, so one occurrence is one row |
| `mail` | `MailDomain` (`lib/mail/mail-domain.ts`) | `mail:new`, a constant, so all incoming mail folds into one row |
| `mention-chat`, `mention-comment`, `chat-message`, `comment-reply` | `ChatRoom.postMessage` | built in `core/notification/tags.ts` ([the tags name the thread](#chat-and-comment-tags-name-the-thread)) |
| `assigned` | the assignee route in `routes/collab.ts` | built in `core/notification/tags.ts` |
| `access-request` | `propagateAccessRequest` (`lib/drive/access-request-propagation.ts`) | `access-request:{ownerId}:{mountId}:{pathId}:{email}` |
| `file-event` | `FileHistory.notifyWatchers` | `file-event:{ownerId}:{mountId}:{pathId}`; burst events tag the parent folder ([FILE-HISTORY.md](FILE-HISTORY.md#notifications-coalesce-per-file-and-bursts-per-folder)) |
| `admin-alert` | backup verify (`lib/backup/jobs.ts`), mail queue (`routes/internal.ts`) | `backup-verify-{ownerId}`, `mail-queue-backlog` |

An unshare carries no tag, because the reader has lost access and there is nothing to link to.

## A coalesced persist skips the toast, not the row

With `coalesce: true`, `persist()` reads the row with the same tag first. If that row was refreshed less than 30 s ago, the upsert still runs but the broadcast is skipped, so the bell stays correct while a burst of events on one tag doesn't flood the screen with toasts. The window slides: a steady stream faster than 30 s stays silent for its whole length, and the bell catches up on its next refetch. File events, incoming mail and admin alerts set it; everything else toasts every time.

## `details` is typed per notification type

`details` is a JSON column holding the row's secondary line and deep-link parameters, keyed by type in `NotificationDetailsMap` (`packages/lib/src/types/notification.ts`). The write input `NotificationPersistInput` is discriminated, so `details` type-checks only for a type that defines an entry. The column is nullable, so a row without it renders title and body only. The read shape keeps `type` a `string`, because a stored row can hold a retired type string and there is no honest value to coerce it to.

## Chat and comment tags name the thread

The five chat, comment and assignment tags are built and parsed in one module, `packages/lib/src/core/notification/tags.ts` (imported by the API as `@workspace/lib/notification/tags`). A standalone chat is tagged with its own path. A comment thread is tagged with the container it comments on plus the thread's chat name, so the notification links to the document and still names the thread inside it. A mention adds the mentioned email, so each person's mention is their own row.

`chatThreadKey` is what a reader compares on. `useAutoMarkChatRead` (`packages/lib/src/core/chat/hooks/use-chat-unread.ts`) marks exactly the open thread's rows read, which is why a comment card passes the container's path id with its chat name rather than the thread's own id. `useUnreadChatIds` uses the tag's path id, so a comment's unread dot sits on the document. An assignment has the comment shape, so it clears with the card's other rows when the card opens. Only the assignee ever gets that row, so whoever clears it is the assignee.

## Your own actions and plain edits never notify

Every producer skips the actor, so your own share, message or edit never notifies you. Collaborator edits to a document notify nobody directly: that would be too noisy. They reach people only through a watch (`file-event`) and the activity panels. `actorEmail` is the sharer, organizer, mail sender, author or requester on every type except `admin-alert`, which has no actor.

## Titles are stored as display text

A producer composes the title and body when it persists, with Eigen extensions stripped (`stripEigenExtension`), and the bell shows them as stored. The phrasing rules, and the chat-derived bodies that are the exception, are in [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md#a-row-is-an-action-a-primary-line-and-an-optional-secondary-line).

## The row stores ids, and the client builds the link

No URL is stored. `resolveNotificationLink` (`packages/lib/src/core/notification/resolve-link.ts`) parses the tag and, for Drive items, fetches the current `DrivePath` at click time, so the link follows the item's type to the right app and survives a move. The link rules per type are in [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md#a-click-opens-in-the-same-tab).

## The bell counts always and lists on open

`NotificationBell` (`packages/ui/src/components/layout/app/notification-bell.tsx`) sits in the topbar. The unread count is always fetched, since it is the badge. The list is fetched only while the popover is open.

## The toast carries just enough to link

`notification:created` carries the title and body for the toast plus the notification's `type` and `tag`, so the toast's View action resolves the same target the bell does ([SSE.md](SSE.md)). It carries no `details`, so View links only to tag-derivable targets: the card (`?card=`) and mail (`?mailId=`) deep links come from the fetched row in the bell. The bell's list is always fetched from the API, never built from events.

## See also

- [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md): what each row says and where it links
- [NOTIFICATIONS.md](NOTIFICATIONS.md): the toast contract
- [SSE.md](SSE.md): the event stream and `notification:created`
- [FILE-HISTORY.md](FILE-HISTORY.md): watches and the `file-event` fan-out
- [CHAT.md](CHAT.md): who a chat message notifies
- [SCALABILITY.md](SCALABILITY.md): `sendToHome` and the home relay
