# Proposal: Recent files

Finding a file you just worked on is harder than it should be when it sits deep in a shared folder or a team drive. Drive's listings show where a file lives, and the bell shows events, not files. This proposal adds a **Recent files** page to Drive: one flat list of the files and folders that involve you, wherever they live, each once, newest first.

**Status:** built on branch `recent-files`, not yet on `develop`. The owner agreed to the design on 2026-11-09, with the yes for the `shared.db` migration and the route. How it works now: [STORAGE.md § Recent files stores only which path and when](../STORAGE.md#recent-files-stores-only-which-path-and-when). The later steps at the end, the palette and the mail addresses, are not built. Size: M.

> **TLDR**: A small `recent_paths` table in each user's own `shared.db` holds which file and when, nothing else. A file moves to the top when the server sees you open it or when a notification about it reaches you. The Drive route `/recent` checks the newest rows against each file's owner at read time, so names are always current and a file you can no longer read never shows. One helper in `home-relay.ts` reads many homes, logs a failed read and leaves that owner out, and Watched, All docs, file search and the teams list use it too. The sidebars of Drive, the document apps, Chat, Calendar, Mail and Contacts link to that one page, **Recent files**, which sits directly below Drive in Drive and the document apps.

## What counts

A row is one file for one user, so a file can't appear twice. Two things write it.

**You opened the file.** The server records it where it already serves the open: a document in its editor, a plain file in the inline editor, and a chat. Opening a preview is never stored. Editing and commenting need an open first, so they are covered.

**A notification about the file reached you.** A share, a mention, a reply, an assignment, an access request or a watched change moves the file to the top. Without this, a doc someone just shared with you wouldn't appear until you had opened it, which is the case the page most needs to serve. The Recent row is separate from the bell row, so dismissing the notification leaves the file in Recent.

Accepted edges:

- Opening a folder doesn't count, because clicking through folders would fill the list with ones you only passed through. A folder still appears when a notification names it, as a burst of uploads does.
- An upload, a WebDAV edit or a rename counts only if you also open the file or get notified about it.
- A team file appears only when it involves you. Nearly everyone is in the default team, so showing every edit would make this a feed of the whole company.
- A colleague editing a doc they shared with you doesn't bring it up unless you watch it. Default-watch on share, parked in the File History row of [ROADMAP.md](../ROADMAP.md), would change that.
- The chat app's index route opens your first chat by itself, so visiting the app counts as opening that chat.
- Trashing many watched files at once writes a row per file, and those rows stay hidden. Two hundred or more would push your older rows out for good.
- A file you only preview doesn't appear, so a PDF or image with no inline editor appears only when a notification names it.
- The time means "last had it open". A document's socket reconnecting after sleep or a dropped network, an inline editor's refetch, or a new message in an open chat moves that file up again.
- The table starts empty and fills from first use. There is no backfill.

Non-goals for now: guests, removing one row by hand, a Clear button, per-type Recent pages in the document apps, grouping by day.

## Data

One table in the viewer's own `shared.db` (`apps/api/src/lib/drive/sharedschema.ts`), added as schema version 2 in `apps/api/src/lib/drive/db-config.ts`. `shared.db` is already in `HOME_DATABASES`, so backups carry it with no new registration, and no new database file or class is needed.

```sql
CREATE TABLE recent_paths (
    ownerId TEXT NOT NULL,
    mountId TEXT NOT NULL,
    pathId TEXT NOT NULL,
    lastActivityAt INTEGER NOT NULL,
    PRIMARY KEY (ownerId, mountId, pathId)
);
```

It holds no name, type or reason. A stored name would go stale on a rename and would keep showing a file you lost access to. `lastActivityAt` is in seconds, like the other timestamps in this database; two rows in one second may swap places, which is harmless. The table is capped at 200 rows, trimmed in the same write that adds a row, so it needs no scheduled cleanup and no age limit. At that size it needs no index on the time.

A team home gets the empty table with its migration, and nothing writes to it. A guest home can collect rows from notifications, and nothing reads them.

Every Drive home runs this migration at open, and an older archive migrates when it opens. The cost is the same as any `shared.db` migration: the older build's `restore --check-data` refuses the newer schema, so `./eigen rollback` after this update restores the pre-update Full backup and loses what changed since.

## Writing a row

`recent.ts` in `apps/api/src/lib/drive/` holds the upsert, the trim and the list as functions over `sharedDb`, like `shared-with-me.ts`, behind `Drive.touchRecent` and `Drive.listRecent`.

**An open** is recorded on the server, in the three places that already serve one, once the open has succeeded:

| Open | Where | Recorded after |
|---|---|---|
| A document | The collab socket's `open` (`/ws/collab/:ownerId/:mountId/:pathId` in `routes/collab.ts`) | `checkAccess`, the session and read check after `document.subscribe`, which the 15-second keepalive repeats and which never records. `canRead` passes a trashed doc, and `CollabRegistry.get` refuses it later, on every reconnect |
| A plain file in the inline editor | `GET /editor/:ownerId/:mountId/:pathId/content`, which only the inline editor reads | `getEditableContent` returns, since it refuses binaries and oversized files after `resolveFile` |
| A chat | `GET /chat/:ownerId/:mountId/:chatId/messages`, first page only | `getChat`. A request with `before` is an older page of a chat already open, so it records nothing |

Each ends in `recordOpened(user, path)` in `recent.ts`, which does nothing for a guest. A path inside a document records nothing either: a collab document is never inside one, `ChatRoom` holds its `containerPath` (a comment thread's chat has one, and without this every comment view would write a hidden row and push older files out), and the editor route calls `recordOpenedUnlessInDocument`, which reads the file's breadcrumb after the answer has gone out. Then it pushes the row to the caller's own home with `sendToHome(user.id, ...)`, a new `drive:recent-open` kind of `HomeMessage` beside `drive:acl-change`, which `Drive.touchRecent` receives there. The caller's own home is held open by their SSE stream, so the push opens no home. The push is fire-and-forget with a `.catch` that logs, so a failed write never fails the open. The ids come from a path the route has just found and checked, so they need no validation of their own.

Not `GET /collab/.../info`, even though every editor passes through it. Its query refetches on window focus and on someone else's rename or ACL change (`invalidatePathRenamed`, `invalidateAclUpdated`), so a doc you aren't looking at would keep moving up. No preview path records anything: previews read other routes.

**A notification** writes in `Home.notify`, after the row persists, when the home has a notification center. It runs in the recipient's own home. A failure there is caught and logged: as in `FileHistory.notifyWatchers`, a notification never fails the change that caused it, and `propagateAssignment` awaits this path directly. The file comes from the tag, through a new `parseNotificationPath(type, tag)` in `packages/lib/src/core/notification/tags.ts`. The share, access-request and file-event parsers move there from `resolve-link.ts`, which then imports them. Builders for those three tags join them, replacing the inline strings in `shared-with-me.ts`, `history.ts` and `access-request-propagation.ts`, so one module spells every tag. Mail, calendar, admin alerts and unshares have no file, so they write nothing.

## Reading the list

```
GET /drive/:ownerId/recent     requireSelf + requireNonGuest
```

`aggregateRecents` in `apps/api/src/lib/drive/aggregate.ts`:

1. Take the caller's newest 100 rows and group them by owner.
2. Look up the caller's team memberships once, for the whole load.
3. Ask each owner through `pullFromEach` and `pullRecentPaths` ([below](#one-helper-for-reads-across-homes)). The caller's own home is asked the same way. An owner that is gone is skipped, an owner whose read fails is logged and adds nothing, and the others still answer.
4. If fewer than 100 rows came back visible, do the same for the remaining rows, at most 100 more. This is what the other 100 stored rows are for: after a bulk trash the page still has older files to show, and in the usual load those owners are never asked.
5. Merge and sort by `lastActivityAt`, newest first, and return at most 100, each as the current `DrivePath` plus `lastActivityAt`.

`Drive.getRecentPathsFor(user, memberships, rows)` answers for one owner, batched per mount with `mount.getBreadcrumbs`. It does its own access check and is called only from the relay, so it falls under the "server code" clause of [ARCHITECTURE.md](../ARCHITECTURE.md#drive-architecture) and needs no `SharedDrive` wrapper. A row whose mount this home doesn't have, because it is disabled, removed or failed to start, is skipped, because `Drive.getMount` would otherwise throw and lose that owner's other rows. It drops a row when:

| Dropped | Why |
|---|---|
| Empty breadcrumb | The file was deleted for good |
| `canReadFromAncestors` fails | You lost access. The owner, members of the owning team, a direct or parent folder ACL and a public visibility all pass |
| `isTrashedChain` | It is in the trash. A trash already ends a sharee's access, but the owner and team members can still read it, so they need this check. A restore brings the file back, sharing included |
| Any ancestor is a document type | It is inside a doc container. `FileHistory` and the comment tags already avoid these, and this is the one check that guarantees it. A breadcrumb ends with the file itself, so the check reads `slice(0, -1)`, as `isInsideDocument` does; otherwise every doc and chat would be dropped |
| `parentId` is null | A mount root, such as Drive home, which would otherwise rank first |

**A read never deletes a row.** A failed lookup looks the same as a missing file at this level, and a brief error must not wipe someone's history. A hidden row comes back when access or the file does, and otherwise falls off through the 200-row trim.

## One helper for reads across homes

`aggregateWatches`, `aggregateMimeContents` and `aggregateFileSearch` each ask their homes in one `Promise.all` and swallow a failed read with `.catch(() => [])`, so a home that can't answer looks like a home with nothing to show, and nothing records it. One helper replaces those three catches, and `aggregateRecents` uses it too. It skips an owner that is gone, because `shared_paths` rows and Recent rows can outlive their owner, and those would otherwise log an error on each load. It landed first as a private function in `aggregate.ts`, and moves to `home-relay.ts` as an export, so that every read of many homes goes through one function and how many run at once can be changed in one place.

Its first other caller is the teams list in `routes/home.ts`, whose per-team pulls already log and skip a failure. Its calendar pull turns a 404, a team with its calendar off (the default), into an empty list inside the pull, since that isn't a failure. Quota's team overrides, admin usage, team calendar sync and signup reconciliation differ in how a failure should end, or run one at a time on purpose, so they move in a later unit of their own.

```ts
// A gone owner is skipped, and a failed read is logged and leaves that owner out, so the others still answer.
export async function pullFromEach<T>(ownerIds: readonly string[], pull: (ownerId: string) => Promise<T>): Promise<T[]> {
    const results = await Promise.all(
        ownerIds.map((ownerId) =>
            getOwnerExists(ownerId)
                .then((exists) => (exists ? pull(ownerId) : null))
                .catch((err) => {
                    console.error(`home-relay: reading ${ownerId} failed:`, err);
                    return null;
                }),
        ),
    );
    return results.filter((result) => result !== null);
}
```

It runs every read at once, with no limit, by the owner's choice on 2026-11-09. Measured under load that day, a closed team home opens in 4 to 8 ms with 9 file descriptors, and a closed user home in 6 to 14 ms with 18. The database opens, most of that CPU, are synchronous, so running fewer at a time saves no CPU and ends with the same open files, but it does keep the server answering. On the API image over 500 closed user homes, all at once took 1.2 s with a longest event-loop gap of 1.17 s, eight at a time 1.4 s with gaps of 64 to 79 ms, and one at a time 1.5 to 1.7 s with gaps of 11 to 16 ms. Over 100 lighter team homes the gap was 7 to 15 ms all at once. If loads that large show up, this function is the one place to change.

The real cost is homes held open. That run took file descriptors from 37 to 937, and those hundred homes stayed open for their idle time, as any read of them does. That is the job of the LRU cap in [PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md). Production pins a high file limit in `docker-compose.yml`, and a dev machine at a low `ulimit -n` can run out sooner, as it already can with Watched or a large share. Recent is normally the lighter of the two, because it asks only the owners in your list, while Watched asks every team and everyone who shared with you.

`pullRecentPaths` is an ordinary pull:

```ts
export async function pullRecentPaths(ownerId: string, user: User, memberships: Memberships, rows: RecentRow[]) {
    const home = await getHome(ownerId);
    return home.drive.getRecentPathsFor(user, memberships, rows);
}
```

| | Cost per load |
|---|---|
| The list itself | One small query in your own home |
| Each owner already open | One batched query per mount |
| Each owner closed | A full open, which also runs what any open runs (trash purge, reindex kick), then the same queries. The home stays open for its idle time, so the next load is the row above |

## The page

- **Route:** `apps/drive/src/routes/_auth.recent.tsx`, modeled on `_auth.watched.tsx`, including its `?pid=&uid=&mid=` selection and detail panel, read-only like it (`DRIVE_CAPABILITIES.readOnly`), with `useRecentPaths` in `packages/lib/src/core/drive/hooks/`. Unlike Watched's owner-less `watchesAll`, its key is `driveKeys.recent(ownerId)`, because the query keys rule requires the owner.
- **Sidebar:** a row labeled "Recent files" with lucide's `Clock` directly below Drive, in the same section of `UserAppSidebar` (`app-sidebar.tsx`), which serves Drive and the document apps. It uses `to` in Drive and `href: getDriveAppUrl('recent')` in the other apps, as Watched and Trash do. Chat, Calendar, Mail and Contacts have their own sidebars, and each gets the same link in a section of its own. Chat's and Calendar's hide it from a guest, and a guest never reaches Mail or Contacts. One page serves every app, since Recent is most useful across types and the chat app has no list view of its own. Nothing loads until you open the page.
- **Order:** the page opens newest first, every time. It keeps its own sort in state, starting at Last activity, newest first, because following the shared view preference could open it alphabetically, and it never writes the preference. `DriveTable`, `DriveBrowser`, `DriveLayout` and `DriveList` take one `sort` object, a `DriveSortControl` (`value`, `onChange`) from `drive-table.tsx`. `DriveLayout` sorts by it, and `DriveListToolbar` hands it to `DriveViewControls`, so a column header, the grid's sort menu and the phone's View options all sort this page only.
- **Date:** the list shows `lastActivityAt` and names it "Last activity" in the column header and the sort menus, the way Trash shows "Trashed". `DriveTable`, `DriveLayout` and `DriveList` take one `date` object, a `DriveListDate` (`label`, `of`) from `drive-table.tsx`. `DriveLayout` hands `of` to `getDriveComparator`, which needs a `Date`, so it reads `date.of(path) ?? path.updatedAt`. `of` takes a `DrivePath`, so the page looks the date up in a map by path id. The grid shows no date, which is accepted.
- **Freshness:** no SSE and no live updates, because every refetch reads every owner in the list. `useRecentPaths` has a one-minute `staleTime`, so a mount or a focus refetches only once the data is a minute old. An open is recorded on the server and doesn't touch the page's query, so a file you just opened shows on the first visit after that minute. A share arriving while you sit on the page still raises its toast, and shows in the list on the first focus after that minute.
- **Empty state:** the standard one every Drive list shows, "Within this void, all possibilities are yet unobserved."

**Dropped: a latest-activity line under each row.** The owner ruled on 2026-11-09 that the page "should look exactly the same as in Drive itself": it uses the shared Drive list with no line under the name, and a click on a file shows its activity in the detail panel.

## Build order

1. `pullFromEach` in `aggregate.ts`, with Watched, All docs and file search on it. Its own commit: these log a failed read whether or not Recent files ships.
2. `pullFromEach` moved to `home-relay.ts`, with the teams list on it. Table, `recordOpened` in the three places, `Drive.getRecentPathsFor`, `pullRecentPaths`, the route, the `Home.notify` write, tests.
3. Sidebar rows, page, the sort and date props.
4. Dropped: the latest-activity line, by the owner's ruling of 2026-11-09 above.

Steps 1 to 3 are built. Later steps get their own go, below.

## Tests

`apps/api/src/test/drive/recent.test.ts`: a row from each of the three opens (the socket, the inline editor's content, a chat's messages), none from a comment thread's messages or a preview, a failing write not failing the open, one row after repeated opens, the 200-row trim, a revoked share hidden and back after re-sharing, a trashed file hidden and back after restore, a deleted file, a mount root, a file inside a container hidden while a doc and a chat themselves stay listed, a shared, a team and a public file, a share notification adding a row, a dismissed notification keeping it, a type without a path adding none, a failing write not failing the notification, a guest refused by the route and a guest's open recording nothing, a row for a file the user can't read staying hidden, a row on a missing mount leaving that owner's other rows, one failing owner leaving the others and keeping its rows, a deleted owner skipped, only the newest 100 rows asked in the usual load, and the older rows asked when too few are visible.

In `apps/api/src/test/drive/aggregate.test.ts`: Watched, All docs and file search each log a failed read, leave that owner out and still return the other owners' files, and Watched skips a deleted owner without logging. The teams list logs a failed mount read and logs nothing for a team with its calendar off.

Plus `app-sidebar.test.tsx` for the row in Drive and in an app, a test that sorting Recent leaves the shared preference alone, and a run through the verify-in-browser skill.

## Docs when it lands

`docs/STORAGE.md` or a new domain doc for the table, [ARCHITECTURE.md](../ARCHITECTURE.md) for the concept, [NOTIFICATION-CENTER.md](../NOTIFICATION-CENTER.md) for the write in `Home.notify`, [SCALABILITY.md](../SCALABILITY.md) for `pullFromEach` and `pullRecentPaths`, a help-center article under `apps/index/src/data/support/drive/` and `CHANGELOG.md`.

## Later: Recent files in the command palette

The palette's empty box shows the published selection or the curated Suggested list (`SUGGESTED_COMMAND_IDS`). `buildSections` would add a Recent files section beside Suggested, from `useRecentPaths`. It is decided when it is built whether Recent comes before Suggested, how many rows it shows, and whether opening the palette may read every owner in the list or needs a lighter read. [COMMAND-PALETTE.md](../COMMAND-PALETTE.md) then needs correcting, since it says the palette stores nothing and searches nothing until there is text. This covers files only: the recency boost for commands in [PROPOSAL_COMMAND_PALETTE.md](PROPOSAL_COMMAND_PALETTE.md) needs per-command usage, which this table doesn't hold.

## Later: addresses used in mail

The owner wants addresses entered in mail saved for future suggestions. They are not part of this table, because they have a different shape and belong to mail. The likely design:

- An `email_recents` table in the user's `mail.db` (`email`, `lastUsedAt`, `useCount`), written in `Mail.messageSend` after the send succeeds. `emails.recipientsAll` already holds past recipients, so a first fill can come from it. That is a mail migration, with its own yes.
- A third source in `useContactSuggestions`, strictly below team members and personal contacts, deduped by lowercased email, stored lowercased with `+tag` aliases kept distinct.
- `ContactSuggestion` gains a kind for it. `suggestionToResult` in the palette's contacts provider has to handle that kind: today it links to the contact's page, and a recent address has no contact, so its row composes a mail instead.

To decide then: whether an address typed into a draft that is never sent counts, and whether calendar, chat and the share dialog also suggest these or only mail.

## Rejected

- **Notifications alone.** Every producer skips the actor and plain edits reach only watchers, so your own work would never appear, and dismissing a bell row deletes it.
- **Deriving the list from `file_events`.** It needs no table, but it can't see a file you only read, has no index on the actor, and searches every mount of every team and sharing owner on each load.
- **A new `eigen.recents/recents.db`.** A new class, more open files per home and a backup registration, for one small table that fits in `shared.db`.
- **Storing names and types.** Stale after a rename, and they show a file you lost access to.
- **Recording opens in `GET /collab/.../info`.** It refetches on focus and on someone else's rename, so a doc you aren't looking at would move up, and it misses chats and plain files.
- **A `POST` from the client for each open.** A route and a hook in three apps, for opens the server already serves, and a body the server would have to bound because the ids aren't a path it has checked.
- **A server-wide queue for reads that open homes.** A stuck open would stall other users' loads too.
- **Closing a home straight after reading it, with `openHome` and `withHomeHeld`.** It would hold down how many homes stay open, but every load would rerun each closed owner's whole open and close: the trash purge, the reindex kick, and a close that waits on them while that owner's own requests wait too.
- **A list that updates live.** Each notification, such as every message in a busy chat, would read every owner again.
