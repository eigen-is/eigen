# Server-Sent Events (SSE)

> **TLDR:** Every signed-in tab holds one event stream of its user's own Home (`apps/api/src/lib/home/sse-stream.ts`, served by `apps/api/src/routes/sse.ts`), and `useSSE` (`packages/lib/src/core/sse/hooks/use-sse.ts`) hands each event to the domain handlers, which invalidate the TanStack Query cache. Not obvious from the code: an event carries only what invalidation needs, toasts come only from the notification center's event, the keepalive re-subscribes the stream to a Home that was evicted and rebuilt, and every stream announces the data epoch of the user's homes, which reloads a tab after a restore.

## A stream belongs to one user's own Home

A user subscribes to their own Home's stream, never to another's. An action that touches another home reaches its users through the relay: `sendToHome` with a `broadcast` message, or `relayEventToMembers` for every member of a team (`apps/api/src/lib/home/home-relay.ts`). The target Home then broadcasts to its own listeners. That keeps every stream on the server that owns its home, which is what sharding needs ([SCALABILITY.md](SCALABILITY.md)).

## The keepalive keeps the stream on a live Home

The stream sends a keepalive at once when it opens and every 15 s after. The first one stops a proxy such as Apache from timing out a stream that has had nothing to say yet. Each later one calls `getHome()`, which touches the Home so it does not idle out under an open tab. When the Home was evicted and rebuilt meanwhile, the stream moves its listener to the new one, or it would go silent while the tab still looks connected.

`useSSE` reconnects after a stream closes on an HTTP error such as a 502, which `EventSource` does not do on its own: from 1 s, doubling up to 30 s, with up to 20% jitter so a restarted server is not hit by every tab at once.

## An event carries only what invalidation needs

An event holds ids, never display text or a domain object: a drive event its path's owner, mount, id and parent, a mail event its message and mailbox, and so on. The handler invalidates the queries those ids name and refetches the truth. A fat event would be a second copy of the data that drifts from the one the query returns. The shapes are in `packages/lib/src/types/sse.ts`. A whole-file contacts import sends one `contacts:changed` in place of one event per card, since a card change invalidates the whole list anyway ([CONTACTS.md](CONTACTS.md)).

The backend builds each event in `apps/api/src/lib/[domain]/sse-events.ts` and emits it with `home.broadcast()`. The frontend handler is `packages/lib/src/core/[domain]/sse-handlers.ts`, registered in `useSSE`. Space and Team have event types and no emitter or handler.

## Toasts come only from the notification center

A domain handler never toasts. `NotificationCenter.persist()` writes the notification to the user's `notifications.db` and broadcasts `notification:created`, which carries the toast text and the type and tag its **View** action resolves with `resolveNotificationLink`, the same link the bell uses. `notification:changed` carries nothing and tells the bell to refetch after a read or dismiss. So a toast always has a row in the bell behind it ([NOTIFICATIONS.md](NOTIFICATIONS.md), [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md)).

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
4. A handler in `packages/lib/src/core/[domain]/sse-handlers.ts` that invalidates, with no toast, registered in `useSSE`.

## See also

- [NOTIFICATIONS.md](NOTIFICATIONS.md): the toast pattern
- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md): the bell and its database
- [COLLAB.md](COLLAB.md): the collab socket, which carries a document's own updates
- [BACKUP.md](BACKUP.md): the restores that rotate the epoch
