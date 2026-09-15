# WebDAV Drive Mount

> **TLDR**: Each mount is exposed at `/webdav/<ownerId>/<mountId>/` over HTTP Basic auth. Class 1 +
> Class 2 (RFC 4918) — `OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `MOVE`, `COPY`,
> `PROPPATCH`, `LOCK`, `UNLOCK`. Eigen container files (`.eigendoc`, `.eigensheets`, `.eigenvector`, ...) appear as
> plain folders containing `data.db` + `media/`; reads pass through, writes inside are blocked (423).
> Locks are in-memory. Litmus 0.17 baseline: **101/105**. Verified against Windows Explorer (works
> well), macOS Finder, Cyberduck, Mountain Duck.
>
> No discovery endpoint: `/webdav/` and `/webdav/<ownerId>/` return 404. The Space **Integrations**
> page lists one URL per accessible mount for users to copy.

## URL scheme

```
/webdav/                              → 404 (intentional)
/webdav/<ownerId>/                    → 404 (intentional)
/webdav/<ownerId>/<mountId>/          → root collection of a mount
/webdav/<ownerId>/<mountId>/<path>    → file or folder by hierarchical name
```

`<ownerId>` is a raw UUID for users, `team_<teamId>` for teams. Each mount becomes one network volume
in the client. Sub-path mounts are not supported. Cross-mount / cross-owner `MOVE` and `COPY` are
rejected with `502` — clients must download + re-upload to move bytes between mounts. URL paths and the
`Destination` header are percent-decoded per segment; a malformed escape (`bad%E0`) is `400`.

## Authentication

HTTP Basic, validated by `verifyProtocolAuth()` (`apps/api/src/lib/auth/protocol-auth.ts`):

1. Tries app passwords (better-auth API keys) first.
2. Falls back to the user's primary password — only if 2FA is disabled on the account.

App passwords are generated from the **Integrations** page in Space. **TLS is mandatory**: Windows
Explorer's WebClient defaults to `BasicAuthLevel = 1` (HTTPS-only Basic) since Vista, including
Windows 11.

## Method mapping

Every mutating method goes through `assertWritable()` (lock check) and the container-internals guard
(`enclosingDocumentContainer()` over the breadcrumb).

| Method | Class | Drive method | Notes |
|---|---|---|---|
| `OPTIONS` | – | `apps/api/src/app.ts` | Advertises `DAV: 1, 2` and the `Allow` list. Handled before CORS. |
| `PROPFIND` | 1 | `Drive.resolvePath`, `Drive.getFolderContents` | Depth 0/1 supported. Depth ∞ returns `403` with `<DAV:propfind-finite-depth>` (RFC 4918 §9.1). |
| `GET` / `HEAD` | 1 | `Drive.readFile` (or `readRange` for `Range:`) | `bytes=N-M`, open-ended `bytes=N-`, suffix `bytes=-N` all supported — the 416/206/200 shape itself is the shared `rangeResponse` (`lib/core/http.ts`), which REST `serveFile` and the mail part routes answer with too. `If-Match` / `If-None-Match` honored in RFC 7232 §6 order. Bodies carry `X-Content-Type-Options: nosniff` (plus a sandbox CSP for html/xhtml/svg), matching REST `serveFile`. |
| `PUT` | 1 | `Drive.createFileFromData` (new) / `Drive.writeFileContent` (overwrite) | Both stage the body to a tmp file with hashing before the insert. Quota pre-check via `Content-Length`. Thumbnails regenerate on overwrite. |
| `DELETE` | 1 | `Drive.deletePath` (soft) | Goes to trash. `resolvePath` skips trashed rows so subsequent `GET`/`PROPFIND` returns 404. |
| `MKCOL` | 1 | `Drive.createFolder` | Bodied `MKCOL` returns `415` (RFC 4918 §9.3.1). |
| `MOVE` | 1 | `Drive.movePath` + `renamePath` | Same-mount only. `Overwrite: F` → `412` if target exists. Same source and destination URL → `403` (RFC 4918 §9.9.4), checked before anything is trashed. |
| `COPY` | 1 | `Drive.copyPath` | Same-mount only. Server-side copy — does not round-trip bytes through HTTP. `Depth: 0` on a collection copies the folder without members (RFC 4918 §9.8.3). Same source and destination URL → `403`. |
| `PROPPATCH` | 1 | `Drive.updatePathDetails` | Live properties (`getcontentlength`, `getetag`, ...) return `403`. Unknown dead properties (e.g. `Z:Win32CreationTime`) persist in `DrivePath.details.webdavProps`. 207 multistatus; a malformed body or a property name that is not an XML name is `400` before anything persists (the name is echoed as an element in every later PROPFIND). |
| `LOCK` / `UNLOCK` | 2 | `Drive.lockManager` | In-memory tokens. Default TTL 600 s, capped at 24 h. Depth-infinity locks gate writes on descendants. Released on `DELETE`. |

PROPFIND/PROPPATCH/LOCK request bodies are capped at 64 KB to keep `fast-xml-parser`'s synchronous
path off the event loop. PROPFIND and PROPPATCH validate with `XMLValidator` before parsing; LOCK reads
its two elements (`owner`, `lockscope`) by regex because the owner is opaque client XML echoed back as-is.

## Container files (raw mode)

Eigen container files (`.eigendoc`, `.eigensheets`, `.eigenstickies`, `.eigenslides`, `.eigenvector`, `.eigenchat`)
are drive folders containing `data.db` + optional `media/` (see [Eigen container pattern in Drive
storage](STORAGE.md)). Over WebDAV they appear as folders with their real children. `GET
Report.eigendoc/data.db` returns the SQLite blob byte-for-byte — backups via rclone / rsync /
Mountain Duck capture every container losslessly.

The container is **read-only inside**: `PUT`, `MKCOL`, `DELETE`, `MOVE` (source or dest),
`PROPPATCH` targeting any path *inside* a container return `423 Locked`. The container as a whole
can be moved, renamed, or deleted as a unit through the normal Drive code path. `enclosingDocumentContainer()`
in `webdav/container-guard.ts` runs over a single pre-fetched breadcrumb to make that decision.

Reads (`GET`, `PROPFIND`, `COPY`-out) are unaffected. An `export` mode that surfaces eigen documents
as `.docx`/`.xlsx`/`.pdf` was scoped in the original proposal but **not implemented** — round-tripping
through Office is currently a web-app workflow.

## Properties

| Property | Source |
|---|---|
| `displayname` | `path.name` |
| `resourcetype` | `<collection/>` for folders, empty for files |
| `creationdate` | `path.createdAt` (ISO 8601) |
| `getlastmodified` | `path.updatedAt` (RFC 1123, **always UTC** — Apple's `webdavfs` assumes UTC) |
| `getcontentlength` | `path.size` (files only) |
| `getcontenttype` | `path.mimeType` (files only) |
| `getetag` | `"<sha-256>"` of the file body. DQUOTE-wrapped, content-derived (RFC 7232 §2.1) — Finder enters re-download loops on unstable validators. Synthetic `id-mtime-size` fallback only for legacy rows missing a hash. |
| `quota-used-bytes` / `quota-available-bytes` | Mount root only, via `getMountQuotaState()` |
| `supportedlock` | Static: an exclusive and a shared `<lockentry>`, both `<write/>` |
| `lockdiscovery` | Live tokens from `LockManager.listForPath()` |
| Dead properties | Persisted on `DrivePath.details.webdavProps` |

## Locks

`LockManager` (`apps/api/src/lib/drive/lock-manager.ts`) keeps tokens in-memory keyed by `pathId`;
depth-infinity coverage is computed per write by walking the caller's breadcrumb (`coveringLocks`). Each lock is owned by the
authenticated `userId`; another user's `If: (<token>)` on a write returns `423`.

In-memory because: collab editing never relies on WebDAV locks, Office refreshes its locks every
~10 minutes (it ignores the server's `Timeout`), and a server restart correctly drops everything.
Persistence and multi-node coordination are deferred to whenever `home-relay.ts` learns to shard
homes (see [SCALABILITY.md](SCALABILITY.md)).

## Code architecture

```
apps/api/src/lib/webdav/
  webdav-router.ts      # Elysia routes, body size cap, path decoding
  resource.ts           # GET / HEAD / PUT / DELETE / MKCOL
  propfind.ts           # PROPFIND on resources (single + listing)
  proppatch.ts          # PROPPATCH — 207 multistatus + dead-prop persistence
  move-copy.ts          # MOVE / COPY (same-mount only)
  locks.ts              # LOCK / UNLOCK handlers + assertWritable()
  container-guard.ts    # enclosingDocumentContainer() over breadcrumb
  container-overlay.ts  # AppleDouble + Office-tempfile filename filter
  path.ts               # encodeHref / decodeHref / splitParentAndName — client path ↔ drive name
  xml.ts                # multistatus / propstat / prop serialization
```

Shared with CalDAV and CardDAV from `apps/api/src/lib/dav/`: `XML_CONTENT_TYPE` and `davError` (`xml.ts`),
`isNcName` (`propfind.ts`) and the `fast-xml-parser` node narrowing `asNode`/`isXmlNode` (`xml-node.ts`).
The multistatus builders are deliberately WebDAV's own: the dav ones declare the CalDAV/CardDAV
namespaces and emit no newlines.

`computeEtag` is not a WebDAV concern — it is imported from `lib/core/http` and shared with the REST routes, so the same file reports the same validator on both paths. The preconditions come from the same module: `matchesIfMatch` (strong, RFC 7232 §3.1) and `matchesIfNoneMatch` (weak, §3.2) are the API's only two etag comparisons, shared with CalDAV, CardDAV and the REST file routes. Both take the etag in its quoted wire form, so a surface storing a bare hash quotes it at the call.

Route entry points always go through `getSharedDrive(ownerId, user)`, so cross-owner ACL is enforced
the same way as the REST API. The drive-side helpers (`resolvePath`, `copyPath`, `readRange`,
`updatePathDetails`, `lockManager`) live on `Drive` with matching `SharedDrive` wrappers.

## Filename quirks

`isHiddenName()` in `container-overlay.ts` silently accepts but hides from listings:

- AppleDouble: `.DS_Store`, `._*` (Finder)
- Office Windows lock files: `~$*` 
- Office Mac save-temps: `.~WRD*` (Word for Mac on Sequoia 15.1+ surfaces these as visible)
- Office Windows save-temps: `~WRD####.tmp`

Names are normalized to NFC on write; resolution accepts both NFC and NFD on read (Finder sends NFD).
URL paths are URL-decoded per-segment, so `My%20Folder` matches the row stored as `My Folder`.

## Clients

Verified working as of 2026-05:

| Client | Platform | Notes |
|---|---|---|
| **Windows Explorer** ("Add a network drive") | Win 10/11 | Works really well in practice. Requires HTTPS (Basic auth default). 50 MB upload cap unless registry tweak is applied. Service `WebClient` must be running. |
| **Mountain Duck** | macOS, Win | Recommended commercial pick on macOS — Mountain Duck 5+ uses native File Provider / CfAPI. |
| **rclone-mount** | macOS, Win, Linux | Recommended free / scriptable pick. User installs FUSE-T (Mac) or WinFsp (Win). |
| **Cyberduck** | macOS, Win | Browse-and-transfer, no mount; the test bed during development. |
| **macOS Finder** (`webdavfs`) | macOS | Supported but not blessed — slow on large folders, aggressive metadata caching. Prefer Mountain Duck or rclone. |
| **Word / Excel** (Mac + Win) | – | LOCK/PUT/MOVE save-dance verified. AutoSave is disabled on WebDAV mounts (Microsoft, M365 v2306+) — saves are manual. |
| **iOS Files.app** | iOS | Native WebDAV is intermittent; use a third-party shim (FileBrowser, Documents, Owlfiles). |

## Limits

Conformance baseline: Litmus 0.17 scores **101/105** against this server.

- **Per-mount quota**: `MountConfig.maxSizeMB`. Pre-checked against `Content-Length` on `PUT`; `507`
  on overrun.
- **Per-user upload size**: `getUploadMaxSize()` — same value the regular Drive route enforces.
- **PROPFIND/PROPPATCH/LOCK body**: 64 KB.
- **Lock TTL**: 600 s default, 24 h cap.
- **Rate limits**: defer to the global Elysia rate limiter; no protocol-specific limits.

Two gaps are known and open:

1. **Unbounded chunked PUT bypasses the quota projection.** A chunked upload sends no `Content-Length`, so
   there is nothing to pre-check and the mount can be pushed one upload past its cap. The client is
   authenticated, so this is a noisy-user problem rather than an attack vector.
2. **Litmus trips the rate cap.** Litmus fires requests back-to-back and hits the global 300 req/min limit, so
   a full conformance run needs the limiter relaxed first.
3. **Dead properties and shared locks per path are unbounded** across requests for an authenticated user
   (same noisy-user class as 1). Row in [ROADMAP.md](ROADMAP.md) § Cheap wins.

## File reference

| Path | Status |
|---|---|
| `apps/api/src/lib/webdav/*.ts` | router + handlers |
| `apps/api/src/lib/drive/lock-manager.ts` | in-memory lock store |
| `apps/api/src/lib/auth/protocol-auth.ts` | `authenticateBasic` + `verifyProtocolAuth` |
| `apps/api/src/app.ts` | OPTIONS handler, router mount, DAV header |
| `apps/space/src/routes/_auth.services.tsx` | per-mount URL listing on the Integrations page |
| `apps/api/src/test/webdav/*.test.ts` | integration tests |

## See also

- [STORAGE.md](STORAGE.md) — Mount + StorageBackend internals; Eigen container layout
- [EXPORT.md](EXPORT.md) — eigen* → docx/xlsx/pdf pipeline (would back a future `export` mode)
- [IMAP.md](IMAP.md) — analogous protocol bridge over Maildir, same auth pattern
- [ACL.md](ACL.md) — permission model the WebDAV layer enforces
- [SCALABILITY.md](SCALABILITY.md) — locks become per-Home if homes ever shard across machines
- RFC 4918 — HTTP Extensions for WebDAV
- RFC 7232 — Conditional Requests (ETag, If-Match)
- [sabre.io/dav clients reference](https://sabre.io/dav/clients/) — best practitioner reference for Finder / Office / Windows WebDAV behavior
