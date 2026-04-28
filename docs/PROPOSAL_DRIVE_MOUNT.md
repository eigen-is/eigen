# Proposal: Mounting Eigen Drive Locally (WebDAV)

> **TLDR**: Add a Class 1+2 WebDAV server at `/webdav/:ownerId/:mountId/*` on the existing Elysia app —
> same architectural shape as CalDAV. Authenticate via HTTP Basic against an app password through
> `verifyProtocolAuth()`. Map cleanly to existing `Drive` / `Mount` methods; the only meaningful new
> code is hierarchical path resolution, recursive listing, byte-range reads, a container-internal
> read-only guard, and a small in-memory lock manager. By default, eigen container files (`.eigendoc`,
> `.eigensheets`, ...) appear as plain folders containing their `data.db`, with internals read-only —
> honest, lossless, backup-friendly. An opt-in `export` mode presents them as `.docx`/`.xlsx`/`.pdf`
> for users who want to round-trip through Office.
>
> **Honest scope.** WebDAV is the cheapest protocol that already exists on every desktop OS — but
> built-in WebDAV clients (Finder, Windows Explorer) are mediocre in 2026 and getting weaker year over
> year. The primary value of this proposal is **not** "your non-technical user mounts a network drive
> in Finder and is happy". It is: (1) a clean target for `rclone-mount`, Mountain Duck, Cyberduck, and
> any other WebDAV-aware client — these already deliver a better mount UX than Apple's own
> implementation; (2) backup pipelines (rsync / restic / Duplicati); (3) iPad / third-party mobile
> clients; (4) a CalDAV-symmetric foundation that future native clients can layer on. A first-party
> sync / VFS client (File Provider on macOS, CfAPI on Windows) is what every comparable self-hosted
> product (Nextcloud, Seafile, Filen, ownCloud) eventually shipped — out of scope here, but explicitly
> on the roadmap.

## Goals

1. Expose every Eigen drive as a WebDAV endpoint that any RFC 4918 Class 1+2 client can read, write,
   rename, move, delete, and lock.
2. Reuse the existing protocol-auth path (better-auth API keys / app passwords) so users add no new
   credential.
3. Round-trip Eigen container files (`.eigendoc`, `.eigensheets`, `.eigenslides`) as Office formats
   when the user opts in, so they can edit `Report.docx` in Word and save it back.
4. Be a first-class target for `rclone-mount`, Mountain Duck, and similar tools — these are the
   recommended desktop entry points.

## Non-goals

- Replacing the Drive web UI. WebDAV is a secondary surface for power-user workflows.
- Real-time collaboration over the mounted volume. Yjs co-editing stays in the browser app; the
  WebDAV view of an `.eigendoc` is a snapshot.
- Bidirectional sync of stickies, chat, or slides. Stickies and chat have no export pipeline; slides
  are read-only PDF.
- Sharing-permission bridging beyond Eigen ACLs. Remote OS permissions are not synchronised back.
- A polished, native-feeling desktop sync experience. That requires a code-signed sync client and
  native-OS extensions; see Phase 8 in the roadmap.

## Why WebDAV (and what about FUSE / SMB / sync clients / ...)

There are five realistic ways to expose a remote drive locally. WebDAV is the cheapest to ship and the
weakest UX; that tradeoff is correct for *this* proposal but does not free us from later work.

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **WebDAV** | HTTP-based filesystem protocol (RFC 4918). Same TCP socket as the API. | No client install. Native support in macOS Finder, Windows Explorer, GNOME Files, KDE Dolphin, GVFS, KIO. CalDAV precedent makes integration mechanical. Reuses HTTPS, CORS, auth. Is also what Mountain Duck / Cyberduck / rclone speak. | Built-in client UX is poor. Finder PROPFIND latencies of 10–40 s are routinely reported on Nextcloud installs. Windows Explorer requires registry edits to lift its 50 MB file size cap and accept Basic auth — non-trivial for a typical user. macOS Sequoia (15.x) introduced fresh regressions in late 2024 that broke working WebDAV setups (Joplin issue #11118). |
| **FUSE** (macFUSE / FUSE-T / WinFsp) | Kernel hook that lets a user-space program implement a filesystem. | Full POSIX-ish semantics. Per-file caching, proper locking. | Per-OS friction: macFUSE is a kext (Apple has been deprecating since macOS 11); FUSE-T is kext-less (NFSv4 loopback) but newer; WinFsp is mature. We would need to ship a signed native binary per OS. **Or just point users at `rclone-mount`, which already does this.** |
| **macOS File Provider + Windows CfAPI** | Apple/Microsoft's modern API for cloud-storage providers (used by Dropbox, Google Drive, OneDrive, iCloud, Box, Synology Drive, Nextcloud, Seafile). | Native UX integration: Files.app on iOS, badges in Finder, on-demand download, conflict detection. The "right" 2026 answer for everyday users. | Per-OS native app, code signing, Apple Developer account, ongoing OS-version chasing. Nextcloud's macOS VFS migration spanned 2023–2025 and still has open VFS-domain bugs. Multi-engineer-month investment. |
| **SMB (Samba)** | Run a Samba server that exposes Drive via SMB shares. | Native UX on Windows, macOS, Linux. | Samba sidecar, NTLM/Kerberos auth bridge to better-auth, per-user passdb backend. Heavier than WebDAV by every measure. |
| **NFSv4** | Sun's network filesystem. | Stable on Unix. | Auth model doesn't map to better-auth; Windows experience is poor. Not viable. |

**Why WebDAV first.** It is the only option that ships zero new client code, reuses our existing
CalDAV scaffolding and `verifyProtocolAuth` helper, and serves as a clean target for the third-party
clients (`rclone-mount`, Mountain Duck) that already deliver a better mount UX than Finder does.

**What WebDAV does *not* solve.** "Open Finder, mount, drag a file, all is well" is a documented pain
point across the Nextcloud and Seafile communities (Nextcloud forum threads from 2023–2025
consistently advise *"use the desktop client, not the WebDAV mount"*). Seafile's own admin docs say
*"Finder's support for WebDAV is not very stable and slow."* Windows 11 default
`BasicAuthLevel = 1` (HTTPS-only Basic auth) and `FileSizeLimitInBytes = 50 MB` both require registry
edits to override. So: ship WebDAV because it is cheap, useful, and unlocks rclone-mount + Mountain
Duck. Document those two as the **recommended** desktop clients, and treat raw Finder / Explorer as
supported-but-not-blessed. For the durable everyday-user experience, plan a native sync / VFS client
as Phase 8 — every comparable self-hosted product ended up there.

### What is FUSE, exactly?

FUSE = **F**ilesystem in **Use**rspace. The kernel exposes a `/dev/fuse` device; a user-space process
opens it and registers itself as the implementation of a mounted filesystem. When the kernel needs to
service a `read`, `open`, or `getattr` syscall against that mount, it forwards the call to the
user-space process and returns the reply. Result: any program that can speak HTTP can also speak
"filesystem", as long as you wrap it in a FUSE binary.

| Platform | Implementation | Notes |
|---|---|---|
| **Linux** | Built-in (`/dev/fuse`) | Stable since kernel 2.6.14. |
| **macOS (kext)** | macFUSE / osxfuse | Apple has been deprecating kexts since macOS 11. Approval flow + reboot required. macFUSE 5.2 (Apr 2026) adds an FSKit backend that drops the kext requirement on Apple Silicon. |
| **macOS (kext-free)** | FUSE-T | Re-implements FUSE over NFSv4 loopback. Newer (~2023), viable, smaller community. |
| **Windows** | WinFsp | Mature BSD-licensed driver. MSI installer. |
| **iOS** | Not available | Use a third-party shim (FileBrowser, Documents, Owlfiles). |

The cleanest FUSE story for our users is **`rclone-mount`** — a single Go binary that mounts any
WebDAV endpoint via FUSE-T / WinFsp / native Linux FUSE. We ship a one-page recipe for it as a Phase 5
deliverable rather than building our own native binary.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Finder / Explorer / rclone-mount /          │
│  Mountain Duck / Cyberduck / iPad shims     │
└─────────────────────────────────────────────┘
                 │  HTTPS Basic auth, WebDAV verbs
                 ▼
┌─────────────────────────────────────────────┐
│  Elysia app (port 8000)                      │
│  └─ /webdav/:ownerId/:mountId/*  ←──── new   │
│  └─ /dav/calendars/...           (CalDAV, exists) │
│  └─ /drive/:ownerId/...          (REST, exists)   │
└─────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│  getHome(ownerId).drive                      │
│  Drive → Mount → metadata.db + Storage       │
└─────────────────────────────────────────────┘
```

The WebDAV router is a sibling to `caldavRouter`. It calls `getHome(ownerId)`, walks through
`drive`/`SharedDrive` for ACL enforcement, and reads/writes through the existing `Mount` API
(`apps/api/src/lib/mount/mount.ts`).

### URL scheme

Mirrors CalDAV's three-level discovery. Each mount becomes a top-level WebDAV "share" (Mac users will
see one network volume per mount).

```
/webdav/                              → 401 if unauthenticated; PROPFIND lists owners
/webdav/:ownerId/                     → PROPFIND lists mounts
/webdav/:ownerId/:mountId/            → root collection of a mount
/webdav/:ownerId/:mountId/<path>      → file or folder by hierarchical name
```

`:ownerId` is raw UUID for users, `team_{id}` for teams (same convention as everywhere else). Routes
verify the caller via the standard `requireSelf(ownerId, userId)` (`apps/api/src/lib/core/access.ts:44`)
and `requireTeamAccess(userId, teamId)` (line 56) helpers. For team mounts, parse the prefix with
`parseOwnerId()` from `packages/lib/src/types/owner.ts` first.

**Path → pathId resolution**: WebDAV paths are hierarchical (`/Photos/2025/march.jpg`), but Drive
addresses files by UUID. There is no `Mount.resolvePath()` today — we add one (see Required Drive
additions).

## Authentication

```typescript
// apps/api/src/lib/webdav/auth.ts (new) — mirrors caldav/auth.ts
import { verifyProtocolAuth } from '../auth/protocol-auth';

export async function authenticateBasic(request: Request) {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Basic ')) {
        return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Eigen Drive"' },
        });
    }
    const [email, password] = atob(header.slice(6)).split(':');
    const user = await verifyProtocolAuth(email, password);
    if (!user) return new Response('Unauthorized', { status: 401 });
    return user;
}
```

`verifyProtocolAuth()` (`apps/api/src/lib/auth/protocol-auth.ts:12`) prefers app passwords (better-auth
API keys) and falls back to the primary password when 2FA is disabled. The Drive web UI grows a
"WebDAV credentials" panel that creates/revokes app-password keys scoped to the WebDAV scheme.

**TLS is mandatory.** Windows Explorer's WebClient defaults to `BasicAuthLevel = 1` (HTTPS-only Basic)
on every shipping Windows since Vista, including Windows 11 / 2025. Document `https://` only.

## WebDAV method mapping

Per RFC 4918 §18, Class 1 covers OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY /
PROPPATCH; Class 2 adds LOCK / UNLOCK on top. We implement both — locking is required for transparent
Office write-back.

| Method | Class | Drive method | File:line | Notes |
|---|---|---|---|---|
| `OPTIONS` | – | n/a | new | Advertise `DAV: 1, 2` and supported methods. |
| `PROPFIND` Depth 0 | 1 | `Mount.getPath()` | mount.ts:187 | Single resource metadata. |
| `PROPFIND` Depth 1 | 1 | `Mount.listFolder()` | mount.ts:193 | Children. |
| `PROPFIND` Depth ∞ | 1 | new helper using SQL `WITH RECURSIVE` | – | Modeled on `getBreadcrumb()` (mount.ts:966). May refuse with 403 + `<DAV:propfind-finite-depth>` precondition (Apache mod_dav default; RFC 4918 §9.1). |
| `GET` | 1 | `Mount.readFile()` → `StorageFile.stream()` | mount.ts:760 | `StorageFile = BunFile \| S3File` (`storage/types.ts:5`). Both stream natively. |
| `HEAD` | 1 | `Mount.getPath()` | mount.ts:187 | Same as GET without body. |
| `PUT` (create) | 1 | `Mount.createFileFromTemp()` | mount.ts:334 | Stream request body to a temp file, then create. Quota check inline. |
| `PUT` (overwrite) | 1 | `Mount.writeFile()` | mount.ts:769 | Updates size + hash + `updatedAt`. |
| `DELETE` | 1 | `Drive.deletePath()` (soft) | drive.ts:292 | Goes to trash. `resolvePath()` MUST skip trashed entries so subsequent GET/PROPFIND returns 404 (RFC 4918 §9.6 mandates the path becomes unmapped). |
| `MKCOL` | 1 | `Mount.createFolder()` | mount.ts:249 | Validates name. **Bodied MKCOLs return 415 Unsupported Media Type** per RFC 4918 §9.3.1; plain MKCOL is enough — we do not implement RFC 5689 extended MKCOL. |
| `MOVE` | 1 | `Mount.updatePath()` | mount.ts:391 | Cross-mount = read+write+delete dance. Honor `Overwrite: F` → 412 if target exists. Default Overwrite is T per RFC 4918 §10.6. |
| `COPY` | 1 | new `Mount.copyPath()` (in-mount) / `Drive.downloadFile()` + `Mount.createFileFromTemp()` (cross-mount) | drive.ts:418, mount.ts:334 | Server-side copy avoids round-tripping bytes through the WebDAV layer. |
| `LOCK` / `UNLOCK` | 2 | new — synthetic in-memory token table | – | See *Locks* below. |
| `PROPPATCH` | 1 | new — dead-property persistence | – | **Always return 207 multistatus** with per-property `<propstat>`, even on success (RFC 4918 §9.2). Persist unknown properties (e.g. `Win32CreationTime`) as dead properties; return `HTTP/1.1 200 OK` per property. A bare 200 OK violates the spec; some Office variants error out. |

### XML responses (multistatus)

PROPFIND, PROPPATCH, and most error responses are XML `multistatus` documents — same shape as CalDAV.
We share a small helper:

```typescript
// apps/api/src/lib/webdav/multistatus.ts
type Property = { ns?: string; name: string; value?: string; raw?: string };
type ResourceResponse = { href: string; status: number; props: Property[] };

export function buildMultistatus(responses: ResourceResponse[]): Response {
    const body = renderMultistatusXml(responses);
    return new Response(body, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
}
```

CalDAV already does this in `apps/api/src/lib/caldav/propfind.ts`; lift the pattern.

### Standard properties

| Property | Source |
|---|---|
| `displayname` | `path.name` |
| `getcontentlength` | `path.size` (omit on collections) |
| `getcontenttype` | `path.mimeType` |
| `getlastmodified` | `path.updatedAt` formatted as RFC 1123, **always UTC** (Apple's webdavfs assumes UTC). Set the HTTP `Last-Modified` header on every GET/HEAD too. |
| `creationdate` | `path.createdAt` (ISO 8601) |
| `getetag` | `"${path.hash}"` — Drive already stores SHA-256. Strong validator MUST be DQUOTE-wrapped, content-derived; do *not* include `updatedAt` or Finder enters re-download loops. |
| `resourcetype` | `<collection/>` for folders, empty for files |
| `quota-available-bytes` | `mount.maxSizeMB * 1MB - usedBytes` |
| `quota-used-bytes` | sum of `paths.size` for this mount where `trashedAt IS NULL` |
| `supportedlock` | static — `<lockentry><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockentry>` (RFC 4918 §15.10 — note required `<lockentry>` wrapper; bare `<lockscope>...</lockscope><locktype>...</locktype>` without `<lockentry>` is malformed and trips Finder + Office). |
| `lockdiscovery` | dynamic — list of active locks on the resource (RFC 4918 §15.8). Required on PROPFIND for any locked resource. |

## Required Drive additions

The Drive / Mount API surface is close, but a handful of helpers are missing:

1. **`Mount.resolvePath(pathStr: string): Promise<DrivePath>`** — walk the hierarchy by name. Used on
   every WebDAV request to translate `/Photos/2025/march.jpg` to a `pathId`. Cache (`Map<pathStr,
   pathId>`) per request; optionally short-lived per-Mount. Must skip rows where `trashedAt IS NOT
   NULL` so recently-deleted paths return 404. Accept both NFC and NFD UTF-8 (Finder sends NFD).
2. **`Mount.listFolderRecursive(parentId, depth?): AsyncIterable<DrivePath>`** — for `PROPFIND` Depth ∞.
   Implement via `WITH RECURSIVE` over the `paths` table — `getBreadcrumb()` at mount.ts:966 already
   uses this pattern.
3. **`StorageBackend.readRange(key, start, end): StorageFile`** — currently no range-read primitive.
   `BunFile` supports `.slice(start, end)`; `S3File` supports byte ranges via S3 `Range` request
   params. Add an optional method, fall back to whole-file read for backends that lack it.
4. **`Mount.copyPath(srcPathId, destParentId, name): Promise<DrivePath>`** — server-side copy without
   round-tripping bytes through the WebDAV layer. For `local` storage this is `cp`; for `s3` it is
   `CopyObject`; for `local-key` it is `cp`.
5. **`Mount.usedBytes(): Promise<number>`** — for quota properties. Sum `paths.size` filtered by
   `trashedAt IS NULL`.
6. **`Drive.isCollabOpen(mountId, pathId): boolean`** — Drive tracks open collab docs in a `documents`
   Map (drive.ts ~line 62). The only related public method today is `closeCollabDocument()` (line 715);
   add an `isCollabOpen()` reader that consults the same Map. Used by `export` mode to return 423
   Locked when a Yjs session is live.
7. **Container-internal read-only guard** — there is no existing mechanism to mark a path as
   container-internal. Add a derived predicate `isInsideContainer(path): Promise<boolean>` (walks
   ancestors, short-circuits when an ancestor's `mimeType` is in the eigen-container set defined
   alongside `DRIVE_EXTENSIONS` at drive.ts:43–49). Cache hits per request. Used by Phase 2 to gate
   PUT / MKCOL / DELETE / MOVE / COPY inside `*.eigendoc`, `*.eigensheets`, etc. → 423 Locked.
8. **Lock table** (in-memory at first):
   ```typescript
   type Lock = { token: string; pathId: string; ownerHref?: string; depth: 0 | 'infinity'; expiresAt: number; userId: string };
   class LockManager {
       acquire(...);
       refresh(token);
       release(token);
       checkAccess(pathId, ifHeader?);
       listForPath(pathId); // for <lockdiscovery>
   }
   ```
   In-memory because: (a) collab editing never relies on locks, (b) WebDAV locks are short-lived
   (Office refreshes ~10 min), (c) a server restart correctly drops them. Persist in SQLite if
   multi-node deployments emerge — the relay (`home-relay.ts`, see SCALABILITY.md) is the right seam.
9. **`MountSettings.webdav`** — add an optional `webdav` field to `MountSettings`
   (`packages/lib/src/types/settings.ts`):
   ```typescript
   webdav?: {
       containerDisplay: 'raw' | 'export'; // default 'raw'
       exportFormat?: 'docx' | 'html' | 'pdf'; // only when containerDisplay = 'export'
   };
   ```

These are additive — no breaking changes to existing Drive callers.

## Container files: `.eigendoc`, `.eigensheets`, `.eigenslides`

This is the design decision that matters most to UX. Eigen container files (`.eigendoc`, `.eigensheets`,
`.eigenstickies`, `.eigenslides`, `.eigenchat`) are stored as **folders containing `data.db`** plus
optional `comments.db` and a `media/` subfolder. There are two coherent ways to expose them over
WebDAV; we support both as a per-mount setting (`MountSettings.webdav.containerDisplay`).

### `raw` mode (default) — present as folders

`Report.eigendoc/` shows up as a folder. PROPFIND on it returns its real children (`data.db`, etc.).
GET on `Report.eigendoc/data.db` returns the SQLite blob byte-for-byte. PROPFIND on
`MyBoard.eigenstickies/` and `Standup.eigenchat/` also works; nothing is hidden.

To prevent foot-guns, the **container itself is read-only inside** in raw mode: PUT, MKCOL, DELETE,
MOVE, COPY targeting any path *inside* a container return 423 Locked. The container as a whole can
still be moved, renamed, deleted, or copied as a unit (those operations go through the regular Drive
code path, which knows how to relocate the whole tree atomically). A backup tool reading the WebDAV
mount gets a complete snapshot of every container's `data.db`, while a stray `rm` inside
`Report.eigendoc/` cannot destroy the document.

### `export` mode (opt-in) — present as Office files

`Report.eigendoc/` shows up in the WebDAV listing as `Report.docx`. GET dispatches to
`exportDocument()`; PUT dispatches to `importIntoDocument()`. The internal folder structure
(`data.db`, `comments.db`, `media/`) is hidden — invisible to PROPFIND, 404 on direct URL access. Use
this when the goal is "open in Word, edit, save, done."

| Container type | DB type | WebDAV name | GET pipeline | PUT pipeline |
|---|---|---|---|---|
| `.eigendoc` | `doc` | `<name>.docx` | `exportEigendocToDocx` | `importIntoDocument` (docx → eigendoc) |
| `.eigensheets` | `sheets` | `<name>.xlsx` | `exportSheetsToXlsx` | `importIntoDocument` (xlsx → eigensheets) |
| `.eigenslides` | `slides` | `<name>.pdf` | `exportSlidesToPdf` | 405 Method Not Allowed (no pptx import exists) |
| `.eigenstickies` | `stickies` | – | filtered from listings; 404 on direct URL | – |
| `.eigenchat` | `chat` | – | filtered from listings; 404 on direct URL | – |

`exportFormat` overrides the default extension (`html` or `pdf` instead of `docx` for eigendoc; `pdf`
instead of `xlsx` for eigensheets). PUT only works for `docx` / `xlsx` — switching to `pdf`/`html`
makes the mount read-only for containers.

### Why offer both — the tradeoff

| Concern | `export` mode | `raw` mode |
|---|---|---|
| "Edit `Report.docx` in Word, save, done" | ✅ Just works | ❌ User has to download, edit, upload via web app |
| Backup via rclone / rsync over WebDAV | ❌ Lossy — backs up a one-time export | ✅ Byte-exact snapshot of Yjs state |
| User mental model | ✅ File = file, folder = folder | ⚠️ User sees `data.db` and may be confused |
| Cloud-sync clients (iCloud / Dropbox watching the mount) | ✅ One stable file per container | ⚠️ One opaque `data.db` per container — usable but slightly stale |
| Round-trip fidelity | ❌ Drops VBA, complex tables, tracked changes | ✅ Lossless |
| User accidentally deletes `data.db` | ✅ Impossible (hidden) | ✅ Blocked — container-internals are read-only |
| Implementation complexity | ❌ Overlay, name mapping, export cache, import pipeline, collab-conflict handling | ✅ Folders are folders |
| Stickies / chat (no export pipeline) | Hidden — nothing useful to expose | Visible as folders |

**Default is `raw` because** honest beats magical. What you see is what's stored, backups are
byte-exact, implementation is trivial (folders are folders), and the safety guard on container
internals prevents the only real foot-gun. The "edit `Report.docx` in Word" use case is genuinely
valuable but is opt-in for users who specifically want it — most users mounting their drive are
reaching for plain files (images, PDFs, zips), where the overlay buys nothing.

**`export` mode exists for** users who specifically want to round-trip Eigen documents through
Office. Enabled per-mount via `webdav.containerDisplay = 'export'`.

### A note on `data.db` staleness in `raw` mode

Eigen edits Yjs collab documents in `mount/tmp/{pathId}` for `local` and `s3` mounts (mount.ts:820–867,
gated by `needsTempCopy`), syncing back to storage on a periodic flush and on document close. For
`local-key` mounts, the DB is opened in place. In both cases, what WebDAV exposes is a logical row
from `metadata.db` — SQLite WAL/SHM sidecars are not tracked there and never appear in PROPFIND. So a
backup tool sees `data.db` as a single file: either the last-synced snapshot (`local`/`s3`, lagging by
seconds-to-minutes during active editing — `CollabDocument.touchUpdatedAt()` is throttled to 60 s) or
the live but checkpoint-consistent SQLite file (`local-key`). Stale at worst, never torn.

### Concurrency with active collab sessions

In `export` mode, a PUT on `Report.docx` while the same document is open in a Yjs collab session in
the browser would race the live CRDT state. **PUT returns 423 Locked if `Drive.isCollabOpen(mountId,
pathId)` is true.** The user must close the browser tab first. Alternatives (merge the docx import
into the live Yjs state, or queue and replay) are interesting but high-risk for documents with
track-changes or complex tables — defer until we have data on how often this collision happens.

In `raw` mode the question doesn't arise — the container internals are read-only.

### Caching

Export is non-trivial — `weasyprint` PDF generation can take seconds. Cache in a global temp area
(NOT under `mount.baseDir` — only `local` mounts have one; S3 mounts would fail), keyed by
`${pathId}-${updatedAt}.${format}`. Invalidate naturally because `updatedAt` changes when the
underlying Yjs doc changes (see EXPORT.md). 5-minute TTL on entries; sweep on next access.

```typescript
// apps/api/src/lib/webdav/export-cache.ts
const CACHE_DIR = join(EIGEN_DATA_DIR, 'tmp/webdav-export');

async function getExportedFile(mount: Mount, path: DrivePath, format: ExportFormat): Promise<BunFile> {
    const cacheKey = `${path.id}-${path.updatedAt}.${format}`;
    const cachePath = join(CACHE_DIR, cacheKey);
    if (await Bun.file(cachePath).exists()) return Bun.file(cachePath);

    const result = await exportDocument(mount, path, format);
    await Bun.write(cachePath, result.data);
    return Bun.file(cachePath);
}
```

### Round-trip risks

`docx → eigendoc → docx` is *not* lossless. `@turbodocx/html-to-docx` and the reverse importer drop:

- VBA macros, content controls, complex fields
- Multi-author tracked changes
- Some custom styles / theme colors
- Embedded objects (Excel-in-Word, Visio)

For a self-hosted Workspace alternative this is acceptable for typical office docs but unacceptable
for legal / engineering documents that depend on tracked changes. Surface this in the WebDAV
onboarding ("editing complex Word features may not round-trip; use the web editor for those documents").

## Mac Finder, Office, and Windows Explorer quirks

Finder is the hardest target. A WebDAV server that "works in Cyberduck" usually does *not* work in
Finder out of the box. Real-world landmines (verified against sabre/dav community references and
recent Microsoft / Apple docs):

| Quirk | Behavior | Workaround |
|---|---|---|
| Finder LOCKs files on open-with-write | One LOCK at file-open time (10-min timeout, ~5-min refresh), one UNLOCK at close — *not* per-PUT. The lock spans many PUTs during one editing session. | Implement Class 2 LOCK with synthetic tokens. |
| Office save dance: LOCK + temp filename + MOVE | Word/Excel/PowerPoint on Windows use `~$Report.docx` as the temp prefix; **Word for Mac (Sequoia 15.1+) uses `.~WRDxxxx`** — both must be accepted. The lock spans the dance; MOVE within the same collection must work. | Implement LOCK + MOVE; recognise both temp-filename families. |
| Office sends `If-Match: "etag"` on saves | Modern Office (per webdavsystem.com) does compare ETags and surfaces a merge UI on mismatch. | Honor `If-Match`; return 412 on hash mismatch. |
| Office AutoSave is disabled on WebDAV mounts | Confirmed by Microsoft on the M365 Apps community (v2306+). | Document for `export` mode users — saves are manual; co-authoring won't work via WebDAV. |
| Finder writes `.DS_Store`, `._foo` (AppleDouble) | One per directory edit. | Silently accept on PUT; filter from PROPFIND listings. (Standard Nextcloud / sabre/dav pattern.) |
| Finder URL-encoding | Encodes `?`, `#`. Uses **NFD-decomposed UTF-8** (`u%CC%88`, not `%C3%BC`). | URL-encode in `href` properly. Server must accept both NFC and NFD; `Mount` already rejects `/` and NUL. |
| Finder ETag must be content-derived | Strict: ETag for the same content must be byte-identical across requests, or Finder enters re-download loops. | Use SHA-256 hash; do *not* include `updatedAt`. |
| Windows requires HTTPS for Basic auth | `BasicAuthLevel = 1` default since Vista; current on Win 11 2025. | HTTPS-only. The registry tweak to lower it to 2 is for self-signed-cert testing only — never recommend in production. |
| Windows 50 MB upload cap | `FileSizeLimitInBytes` default is 50 MB; max via registry is 4 GB. | Onboarding doc must mention the cap and the registry path. |
| Windows 30-min upload timeout | `FsCtlRequestTimeoutInSec` default for WebClient is 30 min. | Document for users uploading large files. |
| Windows WebClient service is off by default on some SKUs | Service `WebClient` (`net start webclient`) must be running. | Document. |
| Finder PROPFIND stalls on big folders | Documented across Nextcloud / Seafile communities; pain starts in the low thousands of entries. | Empirically tune a soft cap (e.g. 10 000) and 502 above it; recommend rclone-mount for power-users. |
| `webdavfs` aggressive caching at `/var/db/webdavcache` | Cached metadata can stick around for minutes; ETag changes don't always invalidate. | `Cache-Control: no-cache, must-revalidate` on PROPFIND responses. |
| iOS Files.app native WebDAV is intermittent | Use a third-party shim (FileBrowser, Documents, Owlfiles). | Don't market iOS Files.app as a supported direct client — recommend a shim. |
| Connection reuse: 4–8 parallel HTTP/1.1 keep-alive requests | Bun handles this transparently, but lock state must be checked atomically per request. | The in-memory `Map` index by `pathId` must use a single transaction or compare-and-swap. |
| `411 Length Required` corner cases | Finder sends Content-Length always; some PUTs use chunked Transfer-Encoding. | Accept both; do not require Content-Length unconditionally. |

### Locks

We do not need a real distributed lock manager. A single-node in-memory `LockManager` covers Finder
+ Office:

```typescript
class LockManager {
    private locks = new Map<string, Lock>(); // by token
    private byPath = new Map<string, Set<string>>(); // pathId → tokens

    // Default TTL 600s — modern Office (v2509+) refreshes locks ~every 10 minutes and ignores
    // the server's Timeout header, so a short server-side TTL would expire mid-edit. Sabre/dav
    // uses 180s minimum; we choose 600s for Office friendliness.
    acquire(pathId: string, depth: 0 | 'infinity', userId: string, ttlMs = 600_000): Lock {
        const token = `urn:uuid:${crypto.randomUUID()}`;
        const lock: Lock = { token, pathId, depth, userId, expiresAt: Date.now() + ttlMs };
        this.locks.set(token, lock);
        this.byPath.set(pathId, (this.byPath.get(pathId) ?? new Set()).add(token));
        return lock;
    }
    // refresh, release, checkAccess (rejects PUT/DELETE/MOVE without matching If header),
    // listForPath (used by <lockdiscovery> property in PROPFIND)
}
```

PROPFIND on a locked resource MUST surface live lock state via the `<lockdiscovery>` property
(RFC 4918 §15.8) — otherwise `<DAV:locked-overwrite>` errors are unhelpful. Persist locks in SQLite
if multi-node deployments emerge; the relay (`home-relay.ts`, see SCALABILITY.md) is the right seam.

## Code structure

Mirror `apps/api/src/lib/caldav/`:

```
apps/api/src/lib/webdav/
  webdav-router.ts          # Elysia router — verb dispatch
  auth.ts                   # authenticateBasic — wraps verifyProtocolAuth
  multistatus.ts            # XML helpers (shared shape with CalDAV)
  discovery.ts              # PROPFIND on /webdav, /webdav/:ownerId
  propfind.ts               # PROPFIND on resources (single + listing)
  resource.ts               # GET / HEAD / PUT / DELETE / MKCOL
  move-copy.ts              # MOVE / COPY (cross-collection edge cases)
  proppatch.ts              # PROPPATCH — 207 multistatus, dead-property persistence
  locks.ts                  # LockManager + LOCK / UNLOCK handlers
  container-overlay.ts      # eigen* ↔ office-format mapping
  export-cache.ts           # On-disk cache for exported eigen* files
  path-resolve.ts           # name-walk resolver, with per-request cache
```

Mounted in `apps/api/src/app.ts` next to `caldavRouter`:

```typescript
.use(webdavRouter)
.use(caldavRouter)
```

`OPTIONS` handling for `/webdav/*` lives in the existing CalDAV-style `onRequest` hook in
`apps/api/src/app.ts:31–42`, so CORS does not eat it.

## Sample handler: PROPFIND on a folder

```typescript
// apps/api/src/lib/webdav/webdav-router.ts (excerpt)
.route('PROPFIND', '/webdav/:ownerId/:mountId/*', async ({ request, params }) => {
    const user = await authenticateBasic(request);
    if (user instanceof Response) return user;
    requireSelf(params.ownerId, user.id);

    const home = await getHome(params.ownerId);
    const drive = home.drive;
    const mount = drive.getMount(params.mountId);
    if (!mount) return new Response('Not Found', { status: 404 });

    const depth = (request.headers.get('Depth') ?? 'infinity') as '0' | '1' | 'infinity';
    const pathStr = `/${params['*'] ?? ''}`;
    const path = await mount.resolvePath(pathStr); // throws ApiError(404) if missing
    await drive.assertReadable(path, user.id);

    const responses: ResourceResponse[] = [resourceToProps(mount, path, lockManager)];
    if (path.type === 'folder' && depth !== '0') {
        const children = await mount.listFolder(path.id);
        for (const child of children) {
            const overlay = applyContainerOverlay(child, mount.settings.webdav); // hides/renames eigen*
            if (overlay) responses.push(resourceToProps(mount, overlay, lockManager));
        }
        if (depth === 'infinity') {
            // RFC 4918 §9.1: optionally refuse with 403 + <propfind-finite-depth>.
            // Apache mod_dav does this by default. Match precedent.
        }
    }
    return buildMultistatus(responses);
});
```

## Quotas and rate limits

- **Per-mount quota**: `MountConfig.maxSizeMB` (mount.ts:19). Check `mount.usedBytes() + Content-Length`
  before starting a PUT. Return 507 Insufficient Storage on failure.
- **Per-user upload size**: `getUploadMaxSize(home, user.id)` from
  `apps/api/src/lib/config/enforcement.ts:20` — same value the regular Drive route enforces.
- **Concurrency**: WebDAV clients (esp. Finder) issue 4–8 parallel requests. Existing Bun / Elysia
  handling is fine; no special pooling. Locks serialise mutating ops on a single resource.
- **Rate limits**: defer to the global Elysia rate limiter; no protocol-specific limits.

## Testing strategy

- **Unit tests**: `apps/api/src/test/webdav/*.test.ts`. Tests in this repo are integration style with
  `getTestContext()` (see TESTING.md). Use the same harness — issue raw Bun `fetch()` calls with
  `Authorization: Basic ...` and the WebDAV verb. Compare XML responses against fixtures.
- **Real clients**: a manual smoke-test checklist for macOS Finder, Windows Explorer, Cyberduck,
  rclone, Mountain Duck, Word, Excel, LibreOffice. Document in `docs/WEBDAV-COMPATIBILITY.md` after
  first ship. Each row of the Quirks table needs a recorded pass/fail.
- **Regression suite**: capture real Finder / Office traffic with `tcpdump`+`tcpflow` and replay it
  as fixtures. The single highest-value test is "open a docx in Word, edit, save, close" —
  exercises LOCK, PUT, ETag, MOVE, UNLOCK in sequence.

## Phased plan

| Phase | Scope | Effort |
|---|---|---|
| 1 | Read-only Class 1 — `OPTIONS`, `PROPFIND` (Depth 0/1; 403 + `<propfind-finite-depth>` for ∞), `GET`, `HEAD`. App-password auth via `verifyProtocolAuth`. Multistatus XML helpers (lift from CalDAV). Strong content-derived ETags. Range requests in `StorageBackend`. Containers naturally appear as plain folders (raw mode). Always-UTC `Last-Modified` header. | M |
| 2 | Write Class 1 — `PUT` (create + overwrite), `MKCOL` (with 415 for bodied), `DELETE` (soft → trash; dropped from `resolvePath`), `MOVE`, `COPY` (in-mount). `Mount.resolvePath`, `Mount.copyPath`, `usedBytes`. Quota enforcement. Container-internals read-only guard (`isInsideContainer` → 423). Spec-compliant `PROPPATCH` (207 multistatus + dead-property persistence). | M |
| 3 | Mac / Office polish — Class 2 `LOCK` / `UNLOCK` + `<lockdiscovery>`, default TTL 600 s. AppleDouble (`._x`, `.DS_Store`) silent accept + filter from PROPFIND. Word-for-Mac `.~WRDxxxx` + Windows `~$` temp recognition. Stable ETags verified against Finder + Word + Excel. Add `Drive.isCollabOpen(mountId, pathId)`. | M |
| 4 | UI — "WebDAV access" panel in the Drive app sidebar: shows mount URL, generates / revokes scoped app password, copies connection string, **links to the rclone-mount and Mountain Duck recipes**. | S |
| 5 | rclone-mount + Mountain Duck recipes — one docs page per recommended client, with example config. Treat these as the **preferred** desktop entry points; raw Finder / Explorer is supported but not blessed. | XS |
| 6 (opt-in) | `export` mode read — toggleable per-mount. Eigen containers listed under their export filename. GET dispatches to `exportDocument()`. On-disk export cache outside `mount.baseDir` (so S3 mounts work too), keyed by `(pathId, updatedAt, format)`. Per-mount default-format setting. | M |
| 7 (opt-in) | `export` mode write — PUT on `Report.docx` calls `importIntoDocument()` for eigendoc / eigensheets. 423 Locked when `Drive.isCollabOpen()` is true. | L |
| 8 (future) | Native sync / VFS client — File Provider extension on macOS, Cloud Files API engine on Windows, Qt or gtkmm fallback on Linux. This is the durable answer for everyday users (Nextcloud / Seafile / Dropbox / Drive all converged here). Multi-engineer-month investment; usage data from phases 1–7 informs whether to invest. | XL |

## Open questions

1. **Permanent delete vs trash on `DELETE`**. Default to trash (matches the user's Finder mental
   model). Permanent delete via the web app or a `?permanent=1` query param.
2. **`export` mode global enable**. Per-mount setting feels right (some users want it, others don't).
   Could add a server default later if the per-mount setting becomes universal.
3. **Shared drives and team mounts**. WebDAV URL is `:ownerId/:mountId/*`. For team mounts, ownerId =
   `team_{teamId}`. Each team mount becomes one Finder volume; acceptable.
4. **Sub-path mounts**. Probably no for v1 — adds complexity, and Finder cannot mount sub-collections
   per OS conventions.
5. **Public / unauthenticated shares**. Out of scope. Anything shared via Eigen's public-link feature
   stays in the existing REST endpoint.
6. **Large file streaming**. PUT bodies arrive as a request stream. `createFileFromTemp` already
   writes to a temp file before the DB insert (mount.ts:334) — pipe Bun's request body into a
   `Bun.write(tmp)` and pass it on. No need to buffer in memory.
7. **Lock persistence**. In-memory is adequate for single-node; multi-node deployments need SQLite
   persistence + relay coordination — defer.
8. **Cross-home WebDAV**. All paths under `/webdav/:ownerId/...` go through `getHome(ownerId).drive`,
   which is the local-home read path. Cross-home data access (e.g. a team mount whose home lives on
   another server) must go through `home-relay.ts` per SCALABILITY.md.

## File reference

| File | Path | Status |
|---|---|---|
| Router | `apps/api/src/lib/webdav/webdav-router.ts` | new |
| Auth | `apps/api/src/lib/webdav/auth.ts` | new |
| Multistatus / XML | `apps/api/src/lib/webdav/multistatus.ts` | new |
| Discovery PROPFIND | `apps/api/src/lib/webdav/discovery.ts` | new |
| Resource PROPFIND | `apps/api/src/lib/webdav/propfind.ts` | new |
| GET / PUT / DELETE / MKCOL | `apps/api/src/lib/webdav/resource.ts` | new |
| MOVE / COPY | `apps/api/src/lib/webdav/move-copy.ts` | new |
| PROPPATCH (207 + dead props) | `apps/api/src/lib/webdav/proppatch.ts` | new |
| LOCK / UNLOCK | `apps/api/src/lib/webdav/locks.ts` | new |
| Container overlay | `apps/api/src/lib/webdav/container-overlay.ts` | new |
| Export cache | `apps/api/src/lib/webdav/export-cache.ts` | new |
| Path resolver | `apps/api/src/lib/webdav/path-resolve.ts` | new |
| `Mount.resolvePath` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Mount.copyPath` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Mount.usedBytes` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Mount.listFolderRecursive` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Drive.isCollabOpen` | `apps/api/src/lib/drive/drive.ts` | edit (add) |
| `isInsideContainer` predicate | `apps/api/src/lib/drive/drive.ts` | edit (add) |
| `StorageBackend.readRange` | `apps/api/src/lib/storage/types.ts` + impls | edit |
| `MountSettings.webdav` field | `packages/lib/src/types/settings.ts` | edit (add) |
| Router mount + OPTIONS | `apps/api/src/app.ts` | edit (add) |
| WebDAV credentials UI | `apps/drive/src/components/settings/webdav-panel.tsx` | new |
| Tests | `apps/api/src/test/webdav/*.test.ts` | new |
| Compatibility doc | `docs/WEBDAV-COMPATIBILITY.md` | new (after Phase 3) |
| rclone-mount recipe | `docs/WEBDAV-RCLONE.md` | new (Phase 5) |

## See also

- [STORAGE.md](STORAGE.md) — Mount + StorageBackend internals
- [EXPORT.md](EXPORT.md) — eigen* → docx/xlsx/pdf pipeline (reused by Phases 6–7)
- [IMAP.md](IMAP.md) — analogous protocol bridge over Maildir (different file model, same auth pattern)
- [ACL.md](ACL.md) — permission model the WebDAV layer enforces
- [SCALABILITY.md](SCALABILITY.md) — locks become per-Home if homes ever shard across machines
- RFC 4918 — HTTP Extensions for WebDAV (in particular §9.1, §9.2, §9.3.1, §9.6, §13, §15.8, §15.10, §18)
- RFC 7232 — Conditional Requests (ETag, If-Match)
- [sabre.io/dav clients reference](https://sabre.io/dav/clients/) — single best practitioner reference for Finder / Office / Windows WebDAV behavior
- [Apache mod_dav directives](https://httpd.apache.org/docs/2.4/mod/mod_dav.html) — server precedent for refusing Depth-infinity by default
