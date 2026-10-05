# WebDAV

> **TLDR:** WebDAV lets a computer open a Drive mount as a network folder. Each mount is one WebDAV share (RFC 4918, Class 1 and 2) at `/webdav/<ownerId>/<mountId>/`, over HTTP Basic with the same app passwords as IMAP, CalDAV and CardDAV. Every handler goes through `SharedDrive`, so a WebDAV client gets exactly the permissions the REST API gives. The code is `apps/api/src/lib/webdav/`. Not obvious from the code: nothing above a mount answers, an Eigen document shows as a plain folder that is read-only inside, locks live in memory only, and the ETag is the content hash because Finder loops on an unstable one. CalDAV and CardDAV are a separate service under `/dav/` ([CALDAV.md](CALDAV.md), [CARDDAV.md](CARDDAV.md)).

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

## Basic auth needs TLS

Every request carries HTTP Basic, checked by `verifyProtocolAuth` ([IMAP.md § Dovecot asks the API whether a password is right](IMAP.md#dovecot-asks-the-api-whether-a-password-is-right)). The failure limiter keys on the `X-Real-IP` Caddy sets on the `/webdav` route. TLS is mandatory in practice: Windows' WebClient sends Basic only over HTTPS (`BasicAuthLevel = 1`), Windows 11 included.

## Every handler resolves through SharedDrive

Each handler starts with `getSharedDrive(ownerId, user)`, so WebDAV enforces the same grants as the REST API ([ACL.md](ACL.md)). The drive methods it needs (`resolvePath`, `copyPath`, `readRange`, `updatePathDetails`, `lockManager`) live on `Drive` with a matching `SharedDrive` wrapper.

`resolvePath` checks read access only. So LOCK checks `canWrite` before it issues a token: a lock announces writes to come, and a reader must not pin one.

## A document container is a folder that is read-only inside

An Eigen document (every type `isDocumentType` names) is a drive folder holding `data.db` and `media/` ([STORAGE.md](STORAGE.md)). Over WebDAV it lists as a folder with its real children, and `GET Report.eigendoc/data.db` returns the SQLite file byte for byte. So rclone or rsync backs up every document losslessly.

A write inside one is a `423 Locked`: PUT, MKCOL, DELETE and PROPPATCH on anything inside, a MOVE from or to inside, and a COPY into one. The drive layer owns that state, and a client write would corrupt it or orphan its rows. The container as a whole moves, renames, copies and trashes like any folder. `enclosingDocumentContainer` (`container-guard.ts`) makes the call over the breadcrumb each handler fetches anyway for the lock check. `container-guard.test.ts` pins every method.

There is no export view: a document is never offered as `.docx` or `.xlsx` over WebDAV, so editing one goes through the web app. The converters that could back such a view are in [EXPORT.md](EXPORT.md).

## MOVE and COPY stay inside one mount

A `Destination` in another mount or under another owner is a 502. The client downloads and re-uploads instead. COPY runs server-side through `Drive.copyPath`, so the bytes never cross HTTP. It is exempt from the server's idle timeout (`server.timeout(request, 0)`), because a deep copy stays silent until it lands. `Depth: 0` on a folder copies the folder without its members (RFC 4918 §9.8.3).

An overwrite trashes the target first. So a request whose source and destination are one resource is a 403, checked before anything is trashed, or the source itself would go to the trash. `Overwrite: F` on an existing target is a 412.

## Locks live in memory

`LockManager` (`apps/api/src/lib/drive/lock-manager.ts`) keeps one table per `Drive`, keyed by path id. Memory is enough: collab editing never relies on WebDAV locks, Office refreshes its locks about every 10 minutes whatever `Timeout` the server answers, and a restart that drops every lock is correct. A second node would need a shared store ([SCALABILITY.md](SCALABILITY.md)).

- A lock belongs to the user who took it. A write with another user's token is a 423. Their UNLOCK is a 403.
- A depth-infinity lock on a folder gates writes on everything below it. Each write walks its breadcrumb for covering locks (`coveringLocks`).
- The TTL is 600 s unless the client asks, and never over 24 h, so a client can't pin lock state for years.
- One path holds at most 32 locks. Shared locks stack without conflict, so past that a LOCK is a 423 and a client can't grow the table without bound.
- DELETE and an overwrite release the replaced path's locks.
- LOCK reads its two elements (`owner`, `lockscope`) by regex, not a parser: the owner is opaque client XML that must echo back as sent.

## PUT stages the body before the row

A create and an overwrite both stream the body to a temp file while hashing it, then write the row. The hash becomes the ETag. An empty PUT succeeds, because Finder reserves a new name with a 0-byte PUT before it sends the content. A PUT over a folder is a 409. The MIME type comes from the name's extension, and an overwrite regenerates the thumbnail.

**The size checks count the bytes.** A PUT meets the per-file upload cap a Drive upload meets (`enforceMaxUploadSize`, `quotas.maxUploadSizeMB`), which is a 413, and what is left of the mount's quota, which is a 507. An overwrite is charged only its growth. A `Content-Length` is checked before any bytes move. Finder sends its PUTs chunked, with no `Content-Length`, so the body is also counted as it streams to the temp file, and the upload stops with the same status the moment it passes either bound. How a mount's quota resolves is in [QUOTA.md](QUOTA.md).

## The ETag is the content hash

`getetag` is the file's SHA-256, quoted (RFC 7232 §2.1). It is content-derived because Finder re-downloads in a loop when a validator changes without the content changing. A row with no hash falls back to an id, mtime and size triple. `computeEtag` lives in `lib/core/http.ts` and the REST routes use it too, so one file has one validator on both paths.

GET honors `If-Match` before `If-None-Match` (RFC 7232 §6), through the same `matchesIfMatch` and `matchesIfNoneMatch` the REST file routes and CalDAV and CardDAV use. Byte ranges, open-ended and suffix ones included, go through the shared `rangeResponse`. Every body carries `X-Content-Type-Options: nosniff`, plus a sandbox CSP for html, xhtml and svg, as REST `serveFile` does: a disguised upload opened in a browser must not run script with the viewer's session.

## Properties are derived and dead ones persist

PROPFIND serves Depth 0 and 1. Depth infinity, which is also what a missing `Depth` header means, is a 403 with `propfind-finite-depth`. Every row carries a fixed set of properties, whatever the body asks for ([ROADMAP.md](ROADMAP.md)). `getlastmodified` is always UTC, which Apple's `webdavfs` assumes. The requested folder also carries the mount's `quota-used-bytes` and `quota-available-bytes`, and its children don't.

PROPPATCH answers a 207. A live property (`getetag`, `getcontentlength`, `displayname` and the rest) is a 403 in its propstat, since a stored copy would shadow the real value. A PROPPATCH is all or nothing (RFC 4918 §9.2), so one 403 saves none of the request and answers every other op 424. Any other property persists in `DrivePath.details.webdavProps`, such as Finder's tags or Office's `Win32CreationTime`. One path stores at most 64 KB of them, the same cap as a request body. A PROPPATCH that would pass it is a 507 and saves nothing. A property name that is not an XML name is a 400 before anything persists, because every later PROPFIND echoes it as an element.

PROPFIND, PROPPATCH and LOCK bodies are capped at 64 KB (413 over it), which keeps an authenticated user from parking megabytes on `fast-xml-parser`'s synchronous path. PROPFIND and PROPPATCH validate the body with `XMLValidator` first, since the parser still yields ops from a truncated body.

## Client junk files are accepted and hidden

`isHiddenName` (`container-overlay.ts`) accepts these on PUT and leaves them out of PROPFIND listings:

- AppleDouble: `.DS_Store` and `._*` (Finder)
- Office lock files on Windows: `~$*`
- Office save temps: `.~WRD*` (Word for Mac, visible since macOS 15.1) and `~WRD####.tmp` (Windows)

Clients break if they can't write them, and they are noise in a listing.

Names are stored in NFC. Lookups normalize to NFC too, so a Finder path in NFD finds the row.

## The multistatus builders are WebDAV's own

WebDAV shares a few pieces with CalDAV and CardDAV from `apps/api/src/lib/dav/`: `XML_CONTENT_TYPE` and `davError`, `isNcName`, and the `fast-xml-parser` narrowing `asNode` and `isXmlNode`. The multistatus builders stay its own in `webdav/xml.ts`. The dav ones declare the CalDAV and CardDAV namespaces and emit no newlines, and switching changes every multistatus, which needs a round of real clients first ([ROADMAP.md](ROADMAP.md)).

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
