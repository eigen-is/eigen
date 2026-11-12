# WebDAV

> **TLDR:** WebDAV lets a computer open a Drive mount as a network folder. Each mount is one WebDAV share (RFC 4918, Class 1 and 2) at `/webdav/<ownerId>/<mountId>/`, over HTTP Basic with the same app passwords as IMAP, CalDAV and CardDAV. Every handler goes through `SharedDrive`, so a WebDAV client gets exactly the permissions the REST API gives. The code is `apps/api/src/lib/webdav/`. Not obvious from the code: nothing above a mount answers, an Eigen document shows as a plain folder whose only writable spot is its `media/`, locks live in memory only, and the ETag is the content hash because Finder loops on an unstable one. CalDAV and CardDAV are a separate service under `/dav/` ([CALDAV.md](CALDAV.md), [CARDDAV.md](CARDDAV.md)).

People mount a drive in Finder or Windows Explorer, sync it with rclone or Mountain Duck, or save straight from Word and Excel. The Integrations page (`apps/space/src/routes/_auth.services.tsx`) lists one URL per mount the user can reach and makes the app passwords. A mount is one drive of a Home: a table of paths over one storage backend ([STORAGE.md § A mount is a paths table](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)).

The one idea is that WebDAV is a thin protocol layer over Drive. Files, folders, sharing, trash and quota all come from Drive ([ACL.md](ACL.md), [SOFT-DELETE.md](SOFT-DELETE.md), [QUOTA.md](QUOTA.md)), so a WebDAV `DELETE` goes to the trash like a delete in the Drive app. WebDAV's own state is only its locks and the properties a client stores on a file.

## A mount is one share and nothing above it answers

```
/webdav/                              404
/webdav/<ownerId>/                    404
/webdav/<ownerId>/<mountId>/          the mount's root folder
/webdav/<ownerId>/<mountId>/<path>    a file or folder by name
```

`<ownerId>` is the user's id, or `team_<teamId>` for a team drive. Each mount is one volume in the client, and a share of a sub-folder is not possible. The levels above a mount answer 404 on purpose: there is no discovery, and the Integrations page (`apps/space/src/routes/_auth.services.tsx`) lists one URL per mount the user can reach. So a client that walks up from a mount URL gets nothing. Windows' **Add a network location** wizard does exactly that and rejects the URL, which is why the help center sends users to **Map network drive** instead.

A trailing slash is stripped, so `/foo/` and `/foo` name one row. The path and the `Destination` header are percent-decoded per segment, and a malformed escape (`bad%E0`) is a 400.

A `Destination` is the full URL the client was given, so in a standard install it starts `/eigen/webdav/`: Caddy strips `/eigen` from the request line but not from this header. `parseDestination` drops that one base path (`getApiBasePath`, read from `VITE_API_HOST`), so `/eigen/webdav/...` and `/webdav/...` both name a mount and any other path is a 400. The host is not checked.

## Basic auth needs TLS

Every request carries HTTP Basic, checked by `verifyProtocolAuth` ([IMAP.md § Dovecot asks the API whether a password is right](IMAP.md#dovecot-asks-the-api-whether-a-password-is-right)). The failure limiter keys on the `X-Real-IP` Caddy sets on the `/eigen/*` route. TLS is mandatory in practice: Windows' WebClient sends Basic only over HTTPS (`BasicAuthLevel = 1`), Windows 11 included.

## Every handler resolves through SharedDrive

Each handler starts with `getSharedDrive(ownerId, user)`, so WebDAV enforces the same grants as the REST API ([ACL.md](ACL.md)). The drive methods it needs (`resolvePath`, `copyPathOver`, `movePathOver`, `readRange`, `updatePathDetails`, `lockManager`) live on `Drive` with a matching `SharedDrive` wrapper. A path the caller can't read resolves to nothing, as a name that doesn't exist does, so a stranger gets the same 404 for both and can't probe a drive for names. A write into a folder they can't read is the 409 of a missing parent.

`resolvePath` checks read access only. So LOCK checks `canWrite` before it issues or refreshes a token on an existing path: a lock announces writes to come, and a reader must not pin one. A LOCK that creates leaves the check to `SharedDrive.createNamedFile`.

## A document container is a folder a client only adds media to

An Eigen document (every type `isDocumentType` names) is a drive folder holding `data.db` and `media/` ([STORAGE.md](STORAGE.md)). Over WebDAV it lists as a folder with its real children, and `GET Report.eigendoc/data.db` returns the SQLite file byte for byte. So rclone or rsync backs up every document losslessly.

A client may PUT or COPY a new file into the document's `media/`, as the web app uploads an image there. Every other write inside one is a `423 Locked`: an overwrite, MKCOL, DELETE and PROPPATCH on anything inside, a LOCK that would create a file outside `media/`, a MOVE into or out of one, `media/` included, and a PUT or COPY of anything anywhere else in it. A MOVE into `media/` would trap an existing file where nothing names it, so the next Delete history would delete it. The drive layer owns that state, and a client write would corrupt it or orphan its rows. The container as a whole moves, renames, copies and trashes like any folder. WebDAV has no check of its own: the drive's rule for a person's write inside a document refuses it with the same 423 and message as the REST API, after the lock and access checks ([STORAGE.md](STORAGE.md#a-person-only-adds-new-files-and-threads-inside-a-document)). `container-guard.test.ts` pins every method.

There is no export view: a document is never offered as `.docx` or `.xlsx` over WebDAV, so editing one goes through the web app. The converters that could back such a view are in [EXPORT.md](EXPORT.md).

## MOVE and COPY stay inside one mount

A `Destination` in another mount or under another owner is a 502. The client downloads and re-uploads instead. COPY runs server-side through `Drive.copyPathOver`, so the bytes never cross HTTP. It meets the limits of the copy route before it writes, which are those of a PUT: any copy past the drive's free space is a 507, and a file past the per-file cap is a 413 ([QUOTA.md](QUOTA.md#507-is-a-full-budget-413-a-file-too-large)). An `Overwrite: T` COPY goes through `Drive.copyPathOver`, which replaces the existing destination only after every check, right before it writes ([§ An overwrite](#an-overwrite-keeps-a-file-under-a-file-and-trashes-anything-else)). So a COPY refused for space or size (507, 413), into its own subtree (409) or inside a document (423) leaves the destination as it was. A failure that only shows during the write, such as an I/O error, leaves a destination that was trashed in the trash, as RFC 4918 §9.8.4 describes Overwrite. A COPY is exempt from the server's idle timeout (`server.timeout(request, 0)`), because a deep copy stays silent until it lands. `Depth: 0` on a folder copies the folder without its members (RFC 4918 §9.8.3).

A MOVE is one drive call (`Drive.movePathOver`): it replaces an overwritten destination only after every check, and then one row write sets the new folder and name. Word and Excel save by MOVE with overwrite, so a refusal must never cost the file being replaced: a MOVE refused for a part of a document (423), for a folder into its own subtree (409) or past the 256-level limit (400) leaves the destination as it was. Because folder and name change in one write, `MOVE /a/x` to `/b/y` lands beside an existing `/b/x`. `apps/api/src/test/webdav/move-copy.test.ts` pins both methods.

A request whose source and destination are one resource is a 403 (RFC 4918 §9.8.5 and §9.9.4). A name is found without case, so a destination that differs from the source only in case resolves to the source itself. A MOVE then renames it, as Finder sends for a case-only rename, and a COPY is a 409, because the two names can't share a folder. `Overwrite: F` on an existing target is a 412. A `Depth: 0` folder COPY never overwrites: it only creates an empty folder, so on an existing target it is a 412 whatever `Overwrite` says, and nothing goes to the trash.

## An overwrite keeps a file under a file and trashes anything else

Word and Excel save with `PUT ~WRD0001.tmp` and a `MOVE` of it over `report.docx`. So a file moved or copied over a file keeps the destination's row, and with it the id, name, MIME type, sharing, watchers, history and dead properties: `Drive.replaceOccupant` reads the source's bytes and writes them through `Drive.writeFileContent`, the write of a PUT over an existing file. That gives the size, hash and ETag, the thumbnail, the search reindex, the `uploaded` history row and the word to open tabs and watchers, with the one temp file `commitFromTemp` owns. A MOVE then deletes the source row for good (`deleteForGood`), with its locks, its sharing and its own dead properties, because its bytes live on in the destination and a trashed copy per save would fill the trash against quota. A COPY leaves the source. Trashing the destination instead would revoke its shares on every save and leave its history and watchers on a trashed row.

Both answer 204. The destination's locks stay, as the row never leaves its URL, so the client that sent its token keeps its lock. The bytes are written before the source goes: a write that fails leaves both files as they were, and a delete of the source that fails leaves both with the new bytes. The document rule refuses the write as it refuses a PUT, so a file in a document's `media/` is never replaced (423). A plain file has no versions, so the old bytes are gone, as after a PUT.

Everything else goes to the trash and the source takes its place: a folder or an Eigen document at either end. An overwrite never trashes the source or a folder the source is in: `MOVE` or `COPY /a/b/x` to `/a/b` is a 409 and leaves both.

The handler checks `Overwrite` and the locks on the path it found under the name, and the drive writes many awaits later, for a COPY after the whole listing. So the handler hands the drive the id of that path, or null for a free name, and the drive replaces that path and no other: a file another client put there since, such as Word's LOCK and PUT on **Save as**, makes the request a 409, as a taken name is, and stays with its lock.

## Locks live in memory

`LockManager` (`apps/api/src/lib/drive/lock-manager.ts`) keeps one map of locks per `Drive`, keyed by token, and a lookup by path filters it, as a drive holds a handful. Memory is enough: collab editing never relies on WebDAV locks, Office refreshes its locks about every 10 minutes whatever `Timeout` the server answers, and a restart that drops every lock is correct. A second node would need a shared store ([SCALABILITY.md](SCALABILITY.md)).

- A lock belongs to the user who took it, and its token counts for nobody else: a LOCK or a write with another user's token is a 423, their refresh is a 412 and their UNLOCK is a 403. PROPFIND shows every token to anyone who can read the path, so a token alone proves nothing. A refresh also names the lock's own URL, not one under a locked folder.
- Two locks conflict when either is exclusive. A LOCK is a 423 while a lock it conflicts with is another user's, or the caller's own without its token in the `If` header. It checks the path's own locks, the depth-infinity locks on its ancestors, and for a depth-infinity LOCK on a folder the locks on everything under it (`Drive.descendantIds`, one recursive read of the folder's ids). So the locks that cover one path are all shared or all one user's, and a write passes with the token of any one covering lock the caller owns.
- A write that takes a whole path along has the reach of a depth-infinity LOCK: a DELETE, the source of a MOVE, and what a MOVE or COPY overwrites also meet the locks on everything under the path (RFC 4918 §9.6.1 and §9.9.2). Those are other paths' locks, so each must be the caller's own with its token in the `If` header, a shared one included: one token of several is a 423, and so is any lock of another user. `LockManager.inReach` is the one rule for which locks a request meets, for a LOCK and for a write.
- A LOCK on a name with nothing there creates an empty file and answers 201 with the lock (RFC 4918 §7.3), because Word and Excel lock a new name on **Save as** before their first PUT. The create is the one an empty PUT makes, so it meets the same write access (403), missing parent (409), locks on the folder (423) and document rule (423). Of two LOCKs on one new name at once, or a LOCK and a PUT, one creates the file and the other is a 409 ([§ PUT](#put-stages-the-body-before-the-row)); a LOCK that arrives after the create finds the file and locks it, or is a 423. When the lock on the new file is refused after the create, by a lock above it that it conflicts with, such as another user's shared lock on the folder, or by a closing Home, the empty file stays, unlocked. A refresh on a missing name stays a 404. A name the caller can't read is a missing name, so a stranger's LOCK on it is the 409 of a folder they can't see, whether something is there or not.
- A depth-infinity lock on a folder gates writes on everything below it. Each write and each LOCK reads the ids of every folder above its path (`Drive.ancestorIds`) for covering locks, the folders the caller can't read included. So a lock on a folder above a shared one holds for the sharee too, who gets the same bare 423 and no name of what is locked.
- A live lock holds its Home, so the Home's idle close never drops a lock a WebDAV-only client such as Word still counts on: Word sends nothing between its refreshes, longer than the 5-minute idle. `LockManager` takes one hold while it has any lock and arms one timer at the latest expiry; the last lock going, by UNLOCK, a release or expiry, releases the hold. A close for another reason, such as a restore, a deletion or the shutdown, drops every lock (`clear`), and a LOCK on a closing Home is a 503.
- The TTL is 600 s unless the client asks, and never over 24 h, so a client can't pin lock state, or the Home it holds, for years.
- One path holds at most 32 locks. Shared locks stack without conflict, so past that a LOCK is a 423 and a client can't grow the table without bound.
- A path that leaves its URL releases its locks and those of everything under it (`Drive.releaseLocksUnder`): a trash, a move and a rename, whether from WebDAV (DELETE, an overwrite, MOVE) or the Drive app, since a lock doesn't move with its resource (RFC 4918 §7.7). The client can't refresh or unlock such a lock at the old URL, so it would hold the Home until it expired, and a moved path would carry its lock under another user's folder lock. The Drive app's own writes check no lock, so a trash, move or rename there ends a lock where the same WebDAV request is a 423. A move into the folder the item is already in changes nothing (`Drive.movePath`), so the item keeps its locks, its `updatedAt` and its history.
- The `owner` a LOCK names is the client's own XML (RFC 4918 §14.17), often an `href`. The lock keeps it serialized and every lockdiscovery writes it back as XML, never escaped into text, so the client reads back the element it sent. Each element in it declares the namespaces it uses, so an owner can serialize to many times its body; one past 64 KB is a 400, since the lock holds it for its whole life.

## PUT stages the body before the row

A create and an overwrite both stream the body to a temp file while hashing it, then write the row. The hash becomes the ETag. Over a slow link the body can take longer than the Home's idle timeout, so a PUT holds the Home from its access check until it answers, and so does a COPY ([STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)). An empty PUT succeeds, because Finder reserves a new name with a 0-byte PUT before it sends the content. A PUT over a folder is a 409. The MIME type comes from the name's extension, and an overwrite regenerates the thumbnail. An overwrite keeps the file's type, and a MOVE that changes the extension to one with a known type updates it, as a rename in the web app does ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)).

**A create never renames.** A WebDAV URL names one file, so a PUT or a LOCK that creates goes through `Drive.createNamedFile`, which skips the free name an upload in the web app picks and lets the mount refuse a taken name, as MKCOL does. Of two creates of one new name at once, one lands and the other is a 409. On `local` the loser waits on the create lock and writes nothing; on `local-key` and `s3` the unique index refuses its row and it removes the object it wrote ([STORAGE.md](STORAGE.md#writes-to-one-row-serialize-on-its-path-lock)). The file stores no `originalName`, so it downloads under its name after a later MOVE, as Office's save by temp file and MOVE needs. The loser is not turned into an overwrite: its body is spent, and an overwrite has to pass the locks and preconditions of the file that just appeared, which the client's next PUT does. A name an upload would rewrite, such as one with a backslash, is a 400.

**`If-Match` is checked under the file's lock.** An overwrite's `If-Match` answers early, before a byte is read, and goes down with the write to `Mount.writeFileFromTemp`, which checks it again inside the file's path lock. Two PUTs from one etag both pass the early check, and the lock lets only the first write: the second is a 412. The 204 carries the etag that write committed under the lock, not the row's: a PUT without `If-Match` can land between the lock and the answer, and its etag would let the first client's next PUT overwrite it. A missing file has no etag, so a PUT with any `If-Match` on it is a 412 and creates nothing (RFC 7232 §3.1), so a client such as davfs2 keeps its copy instead of recreating a file that was deleted or moved. The inline editor's save goes through the same check ([INLINE-EDITING.md](INLINE-EDITING.md#a-save-is-guarded-by-the-files-etag-not-a-lock)).

**Write access comes before the size checks.** A PUT by someone who can only read is a 403, even on a full mount, so the answer names what they can act on.

**The size checks count the bytes.** A PUT meets the per-file upload cap a Drive upload meets (`enforceMaxUploadSize`, `quotas.maxUploadSizeMB`), which is a 413, and what is left of the mount's quota, which is a 507. An overwrite is charged only its growth. A `Content-Length` is checked before any bytes move. A `Content-Length: 0` PUT, Finder's name reservation, adds nothing, so it skips the quota lookup and lands even in a mount past its cap. Finder sends its PUTs chunked, with no `Content-Length`, so the body is also counted as it streams to the temp file, and the upload stops with the same status the moment it passes either bound. How a mount's quota resolves is in [QUOTA.md](QUOTA.md).

## The ETag is the content hash

`getetag` is the file's SHA-256, quoted (RFC 7232 §2.1). It is content-derived because Finder re-downloads in a loop when a validator changes without the content changing. A row with no hash falls back to an id, mtime and size triple. `computeEtag` lives in `lib/core/http.ts` and the REST routes use it too, so one file has one validator on both paths.

GET honors `If-Match` before `If-None-Match` (RFC 7232 §6), through the same `matchesIfMatch` and `matchesIfNoneMatch` the REST file routes and CalDAV and CardDAV use. Byte ranges, open-ended and suffix ones included, go through the shared `rangeResponse`. Every body carries `X-Content-Type-Options: nosniff`, plus a sandbox CSP for html, xhtml and svg, as REST `serveFile` does: a disguised upload opened in a browser must not run script with the viewer's session.

## Properties are derived and dead ones persist

PROPFIND serves Depth 0 and 1. Depth infinity, which is also what a missing `Depth` header means, is a 403 with `propfind-finite-depth`. Every row carries a fixed set of properties, whatever the body asks for ([ROADMAP.md](ROADMAP.md)). `getlastmodified` is always UTC, which Apple's `webdavfs` assumes. The requested folder also carries the mount's `quota-used-bytes` and `quota-available-bytes`, and its children don't.

PROPPATCH answers a 207. A live property (`getetag`, `getcontentlength`, `displayname` and the rest) is a 403 in its propstat, since a stored copy would shadow the real value. So is a `set` of a property in no namespace with a live property's name, which a client reading names alone would take for the live one; its `remove` runs, so such a stored row can still go. So is a `set` of a property in the `xml` namespace, which is reserved to the `xml` prefix and not a client's to store props in; a row stored before is listed under `xml:` and its `remove` runs. A PROPPATCH is all or nothing (RFC 4918 §9.2), so one 403 saves none of the request and answers every other op 424. Any other property persists in `DrivePath.details.webdavProps`, such as Finder's tags or Office's `Win32CreationTime`. One path stores at most 64 KB of them, the same cap as a request body. A PROPPATCH that would pass it is a 507 and saves nothing. A property name that is not an XML name makes the body malformed, so it is a 400 before anything persists.

PROPPATCH runs its `set` and `remove` ops in document order (RFC 4918 §9.2), so `set`, `remove`, `set` on one property leaves the last value. A property is keyed by its namespace and local name, whatever prefix the client wrote. A value with element content is stored as serialized XML, `xml: true` on `WebdavDeadProp` (`packages/lib/src/types/drive.ts`), each element declaring the namespaces it uses, and PROPFIND writes it back raw. A text value is stored as text and escaped on the way out.

PROPFIND, PROPPATCH and LOCK bodies are capped at 64 KB (413 over it), which keeps an authenticated user from parking megabytes on the synchronous parse. Each goes to `parseXml` (`apps/api/src/lib/core/xml.ts`) as bytes, as CalDAV's do ([CALDAV.md § A request body is read by namespace](CALDAV.md#a-request-body-is-read-by-namespace-and-a-malformed-one-is-a-400)): a body that is not well-formed, binds no prefix or carries a DOCTYPE is a 400 before anything persists, and so is a PROPFIND, PROPPATCH or LOCK whose root is not `DAV:propfind`, `DAV:propertyupdate` or `DAV:lockinfo`. A PROPFIND naming more than 1,000 distinct props, or whose not-found echo would pass 64 KiB, is a 400 as well. A blank body is allprop for PROPFIND, a lock refresh for LOCK with an `If` header, and nothing for PROPPATCH.

## Client junk files are accepted and hidden

`isHiddenName` (`container-overlay.ts`) accepts these on PUT and leaves them out of PROPFIND listings:

- AppleDouble: `.DS_Store` and `._*` (Finder)
- Office lock files on Windows: `~$*`
- Office save temps: `.~WRD*` (Word for Mac, visible since macOS 15.1) and `~WRD####.tmp` (Windows)

Clients break if they can't write them, and they are noise in a listing.

Names are stored in NFC. Lookups normalize to NFC too, so a Finder path in NFD finds the row.

## The multistatus builders are WebDAV's own

WebDAV shares a few pieces with CalDAV and CardDAV from `apps/api/src/lib/dav/`: `XML_CONTENT_TYPE`, `davError`, and `parsePropfind`, which WebDAV runs only to check the body, since every row carries the same props. The multistatus builders stay its own in `webdav/xml.ts`. The dav ones declare the CalDAV and CardDAV namespaces and emit no newlines, and switching changes every multistatus, which needs a round of real clients first ([ROADMAP.md](ROADMAP.md)).

## Real clients set the bar

Litmus 0.17 scores 101/105 against this server. Litmus fires requests back to back and can hit the global rate limiter in `apps/api/src/app.ts`, so relax it for a full run. The tests are `apps/api/src/test/webdav/`.

Client behavior the server has to live with:

- Windows Explorer works well. It needs HTTPS and the `WebClient` service, and caps uploads at 50 MB unless a registry value is raised.
- Finder works, but is slow on large folders and caches metadata hard. Mountain Duck and rclone are the recommended mounts.
- Word and Excel save by LOCK, PUT and MOVE, which is verified. Microsoft turns AutoSave off on WebDAV mounts, so saves are manual.
- iOS Files' own WebDAV is intermittent. A third-party app works better.
- Cyberduck browses and transfers without mounting, and is the test bed during development.

How a user connects each client is in the help center: [mount-drive-on-your-computer](../apps/index/src/data/support/connect/mount-drive-on-your-computer.md) and [advanced-webdav](../apps/index/src/data/support/connect/advanced-webdav.md).

## See also

- [STORAGE.md](STORAGE.md): mounts, backends and the container layout
- [ACL.md](ACL.md): the permission model every handler enforces
- [QUOTA.md](QUOTA.md): the mount quota a PUT is checked against
- [CALDAV.md](CALDAV.md) and [CARDDAV.md](CARDDAV.md): the DAV service under `/dav/`
- [IMAP.md](IMAP.md): the other protocol bridge on the same app passwords
- RFC 4918 (WebDAV), RFC 7232 (conditional requests), and [sabre.io/dav clients](https://sabre.io/dav/clients/), the best practitioner reference for Finder, Office and Windows behavior
