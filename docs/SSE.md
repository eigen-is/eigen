# Server-Sent Events (SSE)

> **TLDR:** The server tells open pages that data changed through an event stream. Every signed-in tab holds one, the stream of its user's own Home (`apps/api/src/lib/home/sse-stream.ts`, served by `apps/api/src/routes/sse.ts`), and `useSSE` (`packages/lib/src/core/sse/hooks/use-sse.ts`) hands each event to the domain handlers, which invalidate the TanStack Query cache so the page refetches. Not obvious from the code: an event carries only what invalidation needs, toasts come only from the notification center's event, the keepalive re-subscribes the stream to a Home that was evicted and rebuilt, and every stream announces the data epoch of the user's homes, an id that changes only when a restore replaces a home's data, so a tab reloads after a restore.

Every app mounts the stream once, in `EigenApp`'s provider stack ([LAYOUT.md](LAYOUT.md#every-app-is-eigenapp-around-appshell)), so a tab holds one stream whichever app it shows. It carries the changes that are not collab edits: a new mail, a renamed file, a chat message, a changed calendar event, a notification. A collab document's own edits travel on the document's socket instead ([COLLAB.md](COLLAB.md)). Read this doc before you add an event type ([§ A new domain adds four pieces](#a-new-domain-adds-four-pieces)).

## A stream belongs to one user's own Home

A user subscribes to their own Home's stream, never to another's. An action that touches another home reaches its users through the relay: `sendToHome` with a `broadcast` message, or `broadcastToOwnerAndMembers` for the owner and every member of a path, such as the people a folder is shared with or a team's members (`apps/api/src/lib/home/home-relay.ts`). The target Home then broadcasts to its own listeners. That keeps every stream on the server that owns its home, which is what sharding needs ([SCALABILITY.md](SCALABILITY.md)).

A home's first stream also starts its mail folder watchers, so a change another mail app makes reaches the open tab at once ([IMAP.md § Only the six standard folders have a watcher](IMAP.md#only-the-six-standard-folders-have-a-watcher)).

## The keepalive keeps the stream on a live Home

The stream sends a keepalive at once when it opens and every 15 s after. The first one stops a proxy such as Apache from timing out a stream that has had nothing to say yet. Each later one calls `getHome()`, which touches the Home so it does not idle out under an open tab. When the Home was evicted and rebuilt meanwhile, the stream moves its listener to the new one, or it would go silent while the tab still looks connected.

The keepalive is a named event with no data, `event: keepalive`, written by Elysia's `sse` helper. A browser never dispatches a named event to `onmessage`, so `useSSE` never sees it and every message it gets is an `SSEvent`. `apps/api/src/test/server/sse.test.ts` pins the bytes.

`useSSE` reconnects after a stream closes on an HTTP error such as a 502, which `EventSource` does not do on its own: from 1 s, doubling up to 30 s, with up to 20% jitter so a restarted server is not hit by every tab at once.

## An event carries only what invalidation needs

An event holds ids, never display text or a domain object: a drive event its path's owner, mount, id and parent, a mail event its message and mailbox, and so on. The handler invalidates the queries those ids name and refetches the truth. A fat event would be a second copy of the data that drifts from the one the query returns. The shapes are in `packages/lib/src/types/sse.ts`. A whole-file contacts import sends one `contacts:changed` in place of one event per card, since a card change invalidates the whole list anyway ([CONTACTS.md](CONTACTS.md)).

The backend builds each event in `apps/api/src/lib/[domain]/sse-events.ts` and emits it with `home.broadcast()`. A drive event's callers pass a whole `DrivePath`, so `buildDriveEvent` picks its five ids: the path's name and its ACL, which lists the email of everyone it is shared with, never travel on the stream. The frontend handler is `packages/lib/src/core/[domain]/sse-handlers.ts`, and `handleSSEvent` (`packages/lib/src/core/sse/sse-handlers.ts`) hands every event to all of them. A test keyed by every `SSEventType` (`packages/lib/src/test/core/sse/sse-handlers.test.ts`) holds each type to a handler, so a type with no handler fails it.

## A drive event reaches everyone who can read the path

`Drive.emit` sends a drive event to the path's owner and relays it to every effective member of the path through `broadcastToOwnerAndMembers`. The effective members are the people the path's own ACL or a folder above it is shared with, and on a team drive every member of the team (`Drive.getEffectiveMembers`). Nobody signs in as a team, so a team Home has no listeners of its own, and the relay is how a team drive change reaches a tab. File-history, chat and comment-index events go the same way.

The members are read when the event goes out, from the same ACLs and team rows that grant access. So a sharee of a subfolder hears that subfolder's changes and nothing beside it, and a member who left the team or lost the share hears nothing more. A change that takes the path away from some of them reads the members first: a move tells the members of the old and the new place, and a trash tells those who could see the path before. Each tab then drops the path from the folder it still shows. The event is the same five ids, so a member learns nothing about the path that their view does not already name. In a user's home the owner is one of the members, and still hears each event once.

A relayed event only refetches: `handleDriveSSEvent` raises no toast and adds nothing to the bell, the same as for the owner ([§ Toasts come only from the notification center](#toasts-come-only-from-the-notification-center)). A team calendar's event changes reach only the users it is shared with by name, not the team's members ([ROADMAP.md](ROADMAP.md)).

## A relayed drive event costs half a millisecond for a team of 50

The relay reads the members from the path's ACL chain and their accounts in one query, then pushes the event into each open home. On a dev machine that is about 0.5 ms per change for a team of 50, and 500 uploads into a team folder take about as long as 500 into a personal folder (`apps/api/src/test/drive-sse-fanout-benchmark.ts`). A closed home costs nothing, because a broadcast never opens one.

## A burst of new files refetches an open listing once

Every member's tab hears every file of a burst, such as 500 files dropped into a team folder. Each invalidation restarts the open listing's fetch, so that was 500 fetches per tab, and the tabs of one office share the server's per-IP rate limit (`rateLimit` in `apps/api/src/app.ts`). So `handleDriveSSEvent` collapses the listing, search and history refetches of `drive:file-created`, `drive:folder-created` and `drive:file-uploaded` per owner into one, 250 ms after the burst (`debouncePerOwner`). An uploaded file's own detail still refetches at once, because an open preview of an overwritten file must show the new bytes. The tab that made the change refreshes from its own mutation, without waiting.

## Toasts come only from the notification center

A domain handler never toasts. The toast comes from `notification:created`, which the notification center broadcasts after it writes the row, so a toast always has a row in the bell behind it ([NOTIFICATION-CENTER.md § Notifications and domain events are separate broadcasts](NOTIFICATION-CENTER.md#notifications-and-domain-events-are-separate-broadcasts), [NOTIFICATIONS.md](NOTIFICATIONS.md)).

## A backup job's event is only a nudge

`backup:job-updated` carries the job's id and its home's `ownerId`, nothing else. The job map in the API is the truth, and the admin pane refetches its job and artifact lists. An event for the org's `ownerId` refetches the server archive list, whose rows show the record a running upload rewrites. A home job's event goes to every admin, so a second admin watching the same pane follows along; a server backup's goes to the owner alone, who alone may see it ([BACKUP.md](BACKUP.md)).

## A restore reloads every tab of the home

A restore puts other data under every open tab of the home, and each tab's caches describe the home as it was. The data epoch (`apps/api/src/lib/home/data-epoch.ts`) marks that moment. It has two parts: the server's, a random id in `data/server/data-epoch` drawn on first use, followed by the home's, from `data/server/home-data-epochs.json`. A per-home restore rotates the home's part once the new folder is whole, so no tab reloads onto the 503 of a restore still running, and a failed restore leaves it alone. A whole-server archive never holds either file (`SERVER_RUNTIME_FILES` in `apps/api/src/lib/config/paths.ts`), so after `./eigen restore` or `./eigen rollback` the server draws a new epoch and every tab reloads. A restart or an update keeps both files.

Every stream sends `home:data-epochs` when it opens and after every keepalive: the epoch of the user's own home and of each of their teams. `handleHomeSSEvent` (`packages/lib/src/core/home/sse-handlers.ts`) reloads through `reloadReplacedHome` when an epoch it holds changes. A home it has not heard of is new to it (a team joined), not replaced. One announcement covers every case with no push across homes: a tab connected through the restore hears it within 15 s of the end, and a tab that was offline, or any tab after a whole-server restore, hears it on reconnect.

## A reload for a restore starts the epochs over

A tab keeps its epochs in sessionStorage, so the next page it loads still holds them. `reloadReplacedHome` drops them before it reloads. An editor tab reloads when its collab socket names an epoch the restore replaced, which can come before its stream announces the new one, and the page that comes back takes the first epochs it hears as its own. So no page reloads twice for one restore. Stay on the leave prompt ends the asking, because the tab already holds the epoch it asked for.

## The owner and the team reload, a user with a share does not

The owner reloads in every app, and so does every member of a restored team, because those are the homes a stream announces. A user who only has something shared from the home keeps their tabs. Their open documents of it reload through the collab socket ([COLLAB.md](COLLAB.md#home-replacement-closes-every-socket)).

## A new domain adds four pieces

1. The event type in `packages/lib/src/types/sse.ts`: its entry in `SSEventType` and its member of the `SSEvent` union.
2. A builder in `apps/api/src/lib/[domain]/sse-events.ts` that returns only ids.
3. `this.home.broadcast(buildEvent(...))` where the business logic changes the data.
4. A handler in `packages/lib/src/core/[domain]/sse-handlers.ts` that invalidates, with no toast, called from `handleSSEvent`, and a sample of the event in its test's table.

## See also

- [NOTIFICATIONS.md](NOTIFICATIONS.md): the toast pattern
- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md): the bell and its database
- [COLLAB.md](COLLAB.md): the collab socket, which carries a document's own updates
- [BACKUP.md](BACKUP.md): the restores that rotate the epoch
