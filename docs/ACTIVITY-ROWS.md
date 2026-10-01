# Activity Rows

> **TLDR:** An activity row is one line of "who did what": a notification in the topbar bell, or a file event, one entry of a file's history ([FILE-HISTORY.md](FILE-HISTORY.md)), in Drive's ***Recent activity*** panel or an editor's **Activity** panel. All three render every row with one `ActivityRow` (`packages/ui/src/components/activity-row.tsx`) and phrase it with one layer, the functions that turn a stored event into words: `describeFileEvent` for file events, `describeNotification` for notifications. Not obvious from the code: a notification's title and body are phrased on the server and stored, but chat-derived bodies are stored raw and rendered at display time; anything that depends on the viewer ("You", a start time) is formatted on the client; and a click always opens in the same tab. The pipeline behind the bell is [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md).

Two stores feed the rows. A notification is a row in the recipient's own `notifications.db`, written when something happens that concerns them, and the bell lists those. A file event is a row in the event log in the `metadata.db` of the file's mount, and the two panels list those ([FILE-HISTORY.md](FILE-HISTORY.md)). A user who watches a file gets its events as notifications too. Read this doc before you add a notification type or a file event, because the phrasing layer and the link resolvers decide what its row says and where a click on it goes.

## Three surfaces render one row

The topbar bell, the Drive details panel's **Recent activity** and the **Activity** side panel of the document editors (`ActivityPanel`, toggled from `DocumentShareCluster` in each editor's toolbar) all show the same row. One anatomy and one phrasing layer mean a file event reads the same as a notification, a watch notification reads the same as the panel row it came from, and a phrasing fix lands everywhere at once.

## A row is an action, a primary line and an optional secondary line

- **The action line** is the sentence: who did what, where (`New mail from Hanne Oberman`, `Mark added a card to "Eigen Feedback"`). It is small and muted, with the time beside it.
- **The primary line** is what the reader scans for: the mail subject, the card title, `Old → New` for a rename, the item name.
- **The secondary line** is supporting content, such as a mail snippet, an invite's start time or `in To Do`. It shows only when it exists.

A notification persists to that contract: `title` is the action, `body` the primary line, and `details` holds the secondary line plus the deep-link parameters. `details` never holds text the toast needs, because the toast event doesn't carry it ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md#the-toast-carries-just-enough-to-link)).

The avatar slot is always there, so rows align whether or not an actor resolves. Only the bell marks unread rows, with a tint and a bold primary line.

## The action line says who did what, where

- The pattern is `<Actor> <verb> [object or place]`, past tense, as short as it can be while staying clear. Two arrival rows break it: `New mail from <sender>` and `New message from <author> in "<chat>"`.
- An actor is their display name, else the email's local part. A share or unshare without an actor reads `Shared with you` or `Access removed`.
- A Drive item's name is double-quoted inside the action and bare as the primary line. A column name stays bare.
- Your own actions read "You" in the panels, decided at render time by comparing `actorUserId` with the viewer. A notification keeps its stored actor name, which is never you, because every producer skips the actor.

## One phrasing layer serves the server and the panels

`describeFileEvent` (`packages/lib/src/types/file-history.ts`) turns a file event into `{ action, primary, secondary }`. Its context decides how much the row repeats. `'own'` is an item's own panel, whose title already names the item, so the action leaves the name out. `'container'` is a folder's timeline or a notification, where the row must name the descendant it is about. The server composes every `file-event` notification with it in `'container'` context (`FileHistory.notifyWatchers`), and the panels render with it directly (`ActivityEventList`), so a watch notification reads exactly like its panel row.

`describeNotification` (`packages/lib/src/core/notification/describe.ts`) maps a stored notification to the same shape, taking the secondary line from `details`.

## The client formats what depends on the viewer

An invite's start time is stored as epoch milliseconds in `details.startTime` and formatted by `describeNotification`, so it shows in the viewer's timezone, not the server's. The same goes for "You" in the panels and for an assignment's target, which reads `you` for the viewer and a display name for anyone else.

## Chat-derived bodies are stored raw and rendered at display time

Mentions, chat messages, comment replies and comment previews persist the raw message text, emote wire form and bare emails included ([CHAT.md](CHAT.md#emotes-are-stored-as-keys-and-phrased-per-viewer)). `formatChatPreview` (`packages/lib/src/core/chat/format-preview.ts`) renders it in both describe functions and in the SSE toast. An emote becomes the chat's sentence without the actor, because the row already names them (`dances with Marloes Robijn`, or `dances with you` for the viewer). An email becomes a display name through the public-user lookup, and an unknown or external address stays as it is. So the stored `body` differs from what every surface shows, on purpose.

A `file-event` row counts as chat-derived only when its `details` carry a `chatName`, since card titles and file names in other file events must not be rewritten. The toast has no viewer identity in scope, so an emote aimed at you shows your name there, not "you".

## Team names in a sharing row are resolved before the body is stored

An `acl-changed` row's secondary line lists the added and removed principals. An email reads fine as it is, but a `team_<id>` does not, so teams are named, with `UNRESOLVED_TEAM_LABEL` (`packages/lib/src/types/owner.ts`) when the team can't be resolved. The panel resolves names at render time through `usePublicUsers`. The notification body is stored, so the server resolves them first through `getBatchPublicInfo` in `notifyWatchers`; a stored body can't be fixed at render time.

## A click opens in the same tab

Every row is navigation, so a plain click opens its target in the same tab: the bell, both panels and the toast's **View** action. Drive's **Recent activity** rows are real `<a href>`s, so Cmd-click or middle-click still opens a new tab there. The bell can't use an anchor. The product-wide rule, and why the bell can't be a link, is in [LAYOUT.md § Buttons navigate here, links in content open a new tab](LAYOUT.md#buttons-navigate-here-links-in-content-open-a-new-tab).

The targets live in two functions: `resolveNotificationLink` (`packages/lib/src/core/notification/resolve-link.ts`) for notifications and `resolveEventUrl` (`packages/ui/src/components/drive/activity-event-list.tsx`) for panel rows. The rules they share:

- A card or comment event deep-links into its document with `?card=` or `?chat=`. A removed card links to the board only, since the card is gone.
- An `acl-changed` row and an access request open the share dialog (`?sharePathId=`). An access request also fills in the requester's email.
- A calendar invite opens the month of its occurrence with `?eventId=`, taking the start time from the tag.
- A panel row for a trashed or deleted item, an unshare and an admin alert link nowhere.

A panel row resolves its target from the event alone, without fetching the item, so an older row for an item since trashed or purged still points at it. Checking would cost a fetch per row.

## A Drive listing link needs read access to the parent

The listing links (`?sharePathId=`, `?pid=`) open the item's parent folder, which a viewer granted only the item can't read. The link builders don't test for that. The listing route answers the authoritative 403 and redirects a `?pid=` link to the item itself (`getDriveShareUrl`), which keeps **Request access** for a viewer who can't read the item either.

## In an editor, only card and comment rows are clickable

`ActivityPanel` passes `ActivityEventList` an `onOpenCard` and the editor's comment cards. A row that references a card or a comment thread opens it in place, resolving a `chatName` to its card. Every other row would only reopen the document you are in, so it stays inert. Drive's **Recent activity** mounts `ActivityEventList` without `onOpenCard`, so its rows keep their URLs.

## An old row degrades, never breaks

A notification without `details` renders its action and body only. A file event without a `cardId` or `chatName` links to its document instead of the card. Clients must send `cardId` when they post a card event, but the read shape keeps it optional for the rows that predate it (`FileEventDetailsMap`).

## Bell rows carry an app badge

`NotificationBadge` (`packages/ui/src/components/layout/app/notification-badge.tsx`) puts a small app-colored glyph on the avatar, so the source app reads at a glance. It maps the notification type, plus `details.pathType` when the row is about a Drive item, to the app's icon and color from the shared sources (`EIGEN_DOC_ICONS`, `getEigenDocInfoByType().colorVar`, the `--app-*-color` variables). A row without a path type falls back per type and is never blank. The panels show no badge: each is scoped to one item already.

## See also

- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md): storage, tags, coalescing and the toast event
- [FILE-HISTORY.md](FILE-HISTORY.md): the event log and watches behind file-event rows
- [COMMENTS.md](COMMENTS.md): the cards that comment and assignment rows open
- [LAYOUT.md](LAYOUT.md#buttons-navigate-here-links-in-content-open-a-new-tab): same tab versus new tab
