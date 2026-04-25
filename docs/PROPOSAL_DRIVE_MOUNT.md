# Proposal: Mounting Eigen Drive Locally (WebDAV)

> **TLDR**: Expose Eigen Drive as a WebDAV server at `/webdav/:ownerId/:mountId/*` on the main Elysia app —
> same architectural shape as CalDAV. Users mount it in Finder / Windows Explorer with HTTP Basic auth using
> a better-auth app password (which `verifyProtocolAuth()` already accepts). Maps cleanly to existing
> `Drive` / `Mount` methods; the only meaningful new code is path resolution, recursive listing, range
> reads, and synthetic locks for Office. By default, eigen container files (`.eigendoc`,
> `.eigensheets`, ...) appear as plain folders containing their `data.db`, with internals read-only —
> honest, lossless, backup-friendly. An opt-in `export` mode presents them as `.docx`/`.xlsx`/`.pdf` for
> users who want to round-trip through Office. FUSE / Apple File Provider give better fidelity but
> require shipping a per-OS native client and are deferred to a later phase.

## Goals

1. Let a user mount their Eigen drives as a network volume on macOS, Windows, and Linux without installing
   any Eigen-specific client software.
2. Read, write, rename, and delete regular files and folders.
3. Round-trip Eigen container files (`.eigendoc`, `.eigensheets`, `.eigenslides`) as their export formats
   (`.docx`, `.xlsx`, `.pdf`) so users can edit them in Word / Excel / Pages without realising they are Yjs
   documents underneath.
4. Reuse the existing protocol-auth path (better-auth API keys / app passwords) — no new credential
   surface.

## Non-goals

- Replacing the Drive web UI. WebDAV is a secondary surface for power-user workflows (Office round-trips,
  bulk file manipulation, scripting).
- Real-time collaboration over the mounted volume. Yjs co-editing stays in the browser app; the WebDAV
  view of an `.eigendoc` is a snapshot.
- Bidirectional sync of stickies, chat, or slides. Stickies and chat have no export pipeline; slides are
  read-only PDF.
- Sharing-permission bridging. Eigen ACLs gate WebDAV access; remote OS permissions are not synchronised
  back.

## Why WebDAV (and what about FUSE / SMB / etc.)

There are five realistic ways to expose a remote drive as a local mount. Eigen has strong reasons to pick
WebDAV first; the others are interesting but expensive.

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **WebDAV** | HTTP-based filesystem protocol (RFC 4918). Same TCP socket as the API. | No client install. Native support in macOS Finder, Windows Explorer, GNOME Files, KDE Dolphin. CalDAV precedent in the codebase makes integration mechanical. Reuses HTTPS, CORS, auth. | Limited semantics (no extended attributes, weak locking on some clients). macOS Finder is famously fussy. |
| **FUSE** | "Filesystem in Userspace" — kernel hook that lets a user-space program implement a filesystem. | Full POSIX-ish semantics. Per-file caching, inode IDs, proper locking. Highest fidelity. | Per-OS friction (see below). User has to install a kernel extension or driver. Eigen would need to ship a native client per platform. |
| **macOS File Provider** | Apple's modern API for cloud-storage providers (used by Dropbox, Google Drive, OneDrive, iCloud). | Native UX integration (Files.app on iOS, badges in Finder, on-demand download). The "right" API on macOS in 2026. | macOS-only. Requires a signed Mac app with entitlements. Largest engineering investment. |
| **SMB (Samba)** | Run a Samba server that exposes Drive via SMB shares. | Native Windows / macOS support; well-trodden. | Needs full Samba daemon, AD-style auth, kernel-level features. Heavy dep, awkward to integrate per-user mounts behind better-auth. |
| **NFSv4** | Sun's network filesystem. | Well-known on Unix. | Auth model (Kerberos / sys) does not map to better-auth users. Awful Windows experience. |

**WebDAV is the only one that ships zero client code.** Every supported OS already has a built-in WebDAV
client. CalDAV is already serving traffic on the same Elysia app, the auth helper already understands app
passwords, and the Drive metadata model is a near-perfect fit for WebDAV's collection / resource shape.

### What is FUSE, exactly?

FUSE = **F**ilesystem in **Use**rspace. The OS kernel exposes a `/dev/fuse` device; a user-space process
opens it and registers itself as the implementation of a mounted filesystem. When the kernel needs to
service a `read`, `open`, or `getattr` syscall against that mount, it forwards the call to the user-space
process, waits for a reply, and returns the result to the original caller. The result: any program that can
speak HTTP can also speak "filesystem", as long as you wrap it in a FUSE binary.

| Platform | Implementation | Notes |
|---|---|---|
| **Linux** | Built-in (`/dev/fuse`) | Stable since 2.6.14. Just works. |
| **macOS** | macFUSE (formerly osxfuse) — kernel extension | Apple has been deprecating kexts since macOS 11. Users must approve in *System Settings → Privacy & Security* and reboot. Gets harder every release; Apple Silicon adds further friction. |
| **macOS (kext-free)** | FUSE-T | Re-implements the FUSE protocol over NFSv4 loopback — no kext needed. Newer (~2023), smaller community. |
| **Windows** | WinFsp | Mature BSD-licensed driver. Installs cleanly via MSI. |
| **iOS** | Not available | Use File Provider extension instead. |

A FUSE-backed Eigen client would be a small native binary (Go or Rust is typical) that authenticates with
the API once, then translates `read`/`getattr`/`opendir`/etc. into HTTP calls to a private Eigen
file-access endpoint. Pros: full semantics, proper byte-range caching, no Finder weirdness. Cons:

- **Distribution.** Three binaries (mac arm64 / mac x64 / windows / linux), code-signing on macOS, an
  installer or Homebrew tap, autoupdate.
- **macFUSE friction.** First-time setup is ~5 manual steps including a reboot. Many users will give up.
  FUSE-T is better but new.
- **Doesn't beat WebDAV until phase 2+.** A Class 1 WebDAV server already covers 90% of what most users
  want.

**Recommendation:** ship WebDAV first, evaluate native clients after we see what real users hit. If the
primary complaint is *"Finder is slow / locking is broken"*, the right fix is **rclone-mount** (a generic
Go tool that mounts any WebDAV endpoint via FUSE, configurable in two minutes) before we build our own
binary. If macOS users specifically want offline access and on-demand sync, *that* is when we build a File
Provider extension — but it is a many-month investment.

## Architecture

```
┌────────────────────────────────────────┐
│  Finder / Explorer / Linux file mgr     │
└────────────────────────────────────────┘
                 │  HTTPS Basic auth, WebDAV verbs
                 ▼
┌────────────────────────────────────────┐
│  Elysia app (port 8000)                 │
│  └─ /webdav/:ownerId/:mountId/*  ←──── new │
│  └─ /dav/calendars/...           (CalDAV, exists) │
│  └─ /drive/:ownerId/...          (REST, exists)   │
└────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────┐
│  getHome(ownerId).drive                 │
│  Drive → Mount → metadata.db + Storage  │
└────────────────────────────────────────┘
```

The WebDAV router is a sibling to `caldavRouter`. It calls `getHome(ownerId)`, walks through
`drive`/`SharedDrive` for ACL enforcement, and ultimately reads/writes through the existing `Mount` API
(`apps/api/src/lib/mount/mount.ts`).

### URL scheme

Mirrors CalDAV's three-level discovery. Each mount becomes a top-level WebDAV "share" (Mac users will see
one network volume per mount).

```
/webdav/                              → 401 if unauthenticated; PROPFIND lists owners
/webdav/:ownerId/                     → PROPFIND lists mounts
/webdav/:ownerId/:mountId/            → root collection of a mount
/webdav/:ownerId/:mountId/<path>      → file or folder by hierarchical name
```

**Note on `:ownerId`**: same convention as everywhere else — raw UUID for users, `team_{id}` for teams.
Routes verify the caller owns or has access to that owner via the standard `requireSelf` /
`requireTeamAccess` helpers (see `apps/api/src/lib/core/access.ts`).

**Path → pathId resolution**: WebDAV paths are hierarchical (`/Photos/2025/march.jpg`), but Drive
addresses files by UUID. There is no `Mount.resolvePath()` today — we add one (see Required Drive
additions below).

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

`verifyProtocolAuth()` already prefers app passwords (better-auth API keys) and falls back to the primary
password when 2FA is disabled (`apps/api/src/lib/auth/protocol-auth.ts:12`). The Drive web UI grows a "WebDAV
credentials" panel that creates/revokes app-password keys scoped to the WebDAV scheme.

**TLS is mandatory.** Windows Explorer's WebClient refuses Basic auth over plain HTTP unless the user edits
the registry. Document `https://` only.

## WebDAV method mapping

Class 1 covers create/read/update/delete/move. Class 2 adds locking — required for transparent Office
write-back.

| Method | Class | Drive method | File:line | Notes |
|---|---|---|---|---|
| `OPTIONS` | – | n/a | new | Advertise `DAV: 1, 2` and supported methods. |
| `PROPFIND` Depth 0 | 1 | `Mount.getPath()` | mount.ts:187 | Single resource metadata. |
| `PROPFIND` Depth 1 | 1 | `Mount.listFolder()` | mount.ts:193 | Children. |
| `PROPFIND` Depth ∞ | 1 | new helper using SQL `WITH RECURSIVE` | – | No native recursive query today. Fall back to Depth 1 + Iterate if performance is fine. |
| `GET` | 1 | `Mount.readFile()` → `StorageFile.stream()` | mount.ts:760 | `StorageFile` is `BunFile \| S3File`; both stream natively. |
| `HEAD` | 1 | `Mount.getPath()` | mount.ts:187 | Same as GET without body. |
| `PUT` (create) | 1 | `Mount.createFileFromTemp()` | mount.ts:334 | Stream request body to a temp file, then create. Quota check inline. |
| `PUT` (overwrite) | 1 | `Mount.writeFile()` | mount.ts:769 | Write storage, update size + hash + `updatedAt`. |
| `DELETE` | 1 | `Drive.deletePath()` (soft) | drive.ts:292 | Goes to trash. Permanent purge via separate UI / endpoint. |
| `MKCOL` | 1 | `Mount.createFolder()` | mount.ts:249 | Validates name. |
| `MOVE` | 1 | `Mount.updatePath()` (rename / reparent) | mount.ts:391 | Cross-mount = read+write+delete dance. |
| `COPY` | 1 | `Drive.downloadFile()` + `Mount.createFileFromTemp()` | drive.ts:418, mount.ts:334 | Add `Mount.copyPath()` for in-mount short-circuit. |
| `LOCK` / `UNLOCK` | 2 | new — synthetic in-memory token table | – | See *Locks* below. |
| `PROPPATCH` | 1 | n/a | – | 200 with no-op for known dead properties (Finder writes `Win32*` and `getlastmodified`). Persist `displayname` ⇄ `name` if useful. |

### XML responses (multistatus)

PROPFIND responses are XML `multistatus` documents — same shape as CalDAV. We share a small helper:

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
| `getlastmodified` | `path.updatedAt` (formatted as RFC 1123) |
| `creationdate` | `path.createdAt` (ISO 8601) |
| `getetag` | `"${path.hash}"` — Drive already stores SHA-256 |
| `resourcetype` | `<collection/>` for folders, empty for files |
| `quota-available-bytes` | `mount.maxSizeMB * 1MB - usedBytes` |
| `quota-used-bytes` | sum of `size` from `paths` table for this mount |
| `supportedlock` | static — `<lockscope><exclusive/></lockscope><locktype><write/></locktype>` |

## Required Drive additions

The Drive / Mount API surface is close, but a handful of helpers are missing:

1. **`Mount.resolvePath(pathStr: string): Promise<DrivePath>`** — walk the hierarchy by name. Used on
   every WebDAV request to translate `/Photos/2025/march.jpg` to a `pathId`. Cache (`Map<pathStr,
   pathId>`) per request, optionally short-lived per-Mount.
2. **`Mount.listFolderRecursive(parentId, depth?): AsyncIterable<DrivePath>`** — for `PROPFIND` Depth
   ∞. Implement via `WITH RECURSIVE` over the `paths` table (the existing `getBreadcrumb()` helper
   already uses recursive CTEs).
3. **`StorageBackend.readRange(key, start, end): StorageFile`** — currently there is no range-read
   primitive. `BunFile` supports `.slice(start, end)`; `S3File` supports byte ranges via `range` request
   params. Add an optional method, fall back to whole-file read for backends that lack it.
4. **`Mount.copyPath(srcPathId, destParentId, name): Promise<DrivePath>`** — server-side copy without
   round-tripping bytes through the WebDAV layer. For `local` storage this is `cp`; for `s3` it is
   `CopyObject`; for `local-key` it is `cp`.
5. **`Mount.usedBytes(): Promise<number>`** — for quota properties. Trivial sum over `paths.size`
   filtered by `trashedAt IS NULL`.
6. **Lock table** (in-memory at first):
   ```typescript
   type Lock = { token: string; pathId: string; ownerHref?: string; depth: 0 | 'infinity'; expiresAt: number; userId: string };
   class LockManager { acquire(...); refresh(token); release(token); checkAccess(pathId, token?); }
   ```
   In-memory because: (a) collab editing never relies on locks, (b) WebDAV locks are short-lived (Office
   refreshes every minute), (c) a server restart correctly drops them. Persist to SQLite later if needed.

These are additive — no breaking changes to existing Drive callers.

## Container files: `.eigendoc`, `.eigensheets`, `.eigenslides`

This is the design decision that matters most to UX, and the one with the strongest argument on both
sides. Eigen container files (`.eigendoc`, `.eigensheets`, `.eigenstickies`, `.eigenslides`, `.eigenchat`)
are stored as **folders containing `data.db`** plus optional `comments.db` and a `media/` subfolder. There
are two coherent ways to expose them over WebDAV; we support both as a per-mount setting.

```typescript
// MountSettings (packages/lib/src/types/settings.ts) — added field
type MountSettings = {
    // ... existing fields
    webdav?: {
        containerDisplay: 'raw' | 'export'; // default 'raw'
        exportFormat?: 'docx' | 'html' | 'pdf'; // only used when containerDisplay = 'export'
    };
};
```

### `raw` mode (default) — present as folders

`Report.eigendoc/` shows up as a folder. PROPFIND on it returns its real children (`data.db`, etc.). GET
on `Report.eigendoc/data.db` returns the SQLite blob byte-for-byte. PROPFIND on `MyBoard.eigenstickies/`
and `Standup.eigenchat/` also works; nothing is hidden.

To prevent foot-guns, the **container itself is read-only inside** in raw mode: PUT, MKCOL, DELETE, MOVE,
COPY targeting any path *inside* a container return 423 Locked. The container as a whole can still be
moved, renamed, deleted, or copied as a unit (those operations go through the regular Drive code path,
which knows how to relocate the whole tree atomically). A backup tool reading the WebDAV mount gets a
complete snapshot of every container's `data.db`, while a stray `rm` inside `Report.eigendoc/` cannot
destroy the document.

### `export` mode (opt-in) — present as Office files

`Report.eigendoc/` shows up in the WebDAV listing as `Report.docx`. GET dispatches to `exportDocument()`;
PUT dispatches to `importIntoDocument()`. The internal folder structure (`data.db`, `comments.db`,
`media/`) is hidden — invisible to PROPFIND, 404 on direct URL access. Use this when the goal is "open
in Word, edit, save, done."

| Container type | DB type | WebDAV name | GET pipeline | PUT pipeline |
|---|---|---|---|---|
| `.eigendoc` | `doc` | `<name>.docx` | `exportEigendocToDocx` | `importIntoDocument` (docx → eigendoc) |
| `.eigensheets` | `sheets` | `<name>.xlsx` | `exportSheetsToXlsx` | `importIntoDocument` (xlsx → eigensheets) |
| `.eigenslides` | `slides` | `<name>.pdf` | `exportSlidesToPdf` | 405 Method Not Allowed (no pptx import exists) |
| `.eigenstickies` | `stickies` | – | filtered from listings; 404 on direct URL | – |
| `.eigenchat` | `chat` | – | filtered from listings; 404 on direct URL | – |

`exportFormat` overrides the default extension (`html` or `pdf` instead of `docx` for eigendoc; `pdf`
instead of `xlsx` for eigensheets). PUT only works for `docx` / `xlsx` — switching to `pdf`/`html` makes
the mount read-only for containers.

### Why offer both — the tradeoff

| Concern | `export` mode | `raw` mode |
|---|---|---|
| "Edit `Report.docx` in Word, save, done" | ✅ Just works | ❌ User has to download, edit, upload via web app |
| Backup via rclone / rsync over WebDAV | ❌ Lossy — backs up a one-time export | ✅ Byte-exact snapshot of Yjs state |
| User mental model | ✅ File = file, folder = folder | ⚠️ User sees `data.db` and may be confused |
| Cloud-sync clients (iCloud / Dropbox watching the mount) | ✅ One stable file per container | ⚠️ One opaque `data.db` per container — usable but slightly stale (see below) |
| Round-trip fidelity | ❌ Drops VBA, complex tables, tracked changes | ✅ Lossless |
| User accidentally deletes `data.db` | ✅ Impossible (hidden) | ✅ Blocked — container-internals are read-only |
| Implementation complexity | ❌ Overlay, name mapping, export cache, import pipeline, collab-conflict handling | ✅ Folders are folders |
| Stickies / chat (no export pipeline) | Hidden — nothing useful to expose | Visible as folders |

**Default is `raw` because** honest beats magical. What you see is what's stored, backups are byte-exact,
implementation is trivial (folders are folders), and the safety guard on container internals prevents
the only real foot-gun. The "edit `Report.docx` in Word" use case is genuinely valuable but is opt-in for
users who specifically want it — most users mounting their drive in Finder are reaching for plain files
(images, PDFs, zips), where the overlay buys nothing.

**`export` mode exists for** users who specifically want to round-trip Eigen documents through Office.
Enabled per-mount via `webdav.containerDisplay = 'export'`.

**A note on `data.db` staleness in `raw` mode**: Eigen edits Yjs collab documents in
`mount/tmp/{pathId}` for `local` and `s3` mounts (`mount.ts:820-867`, `needsTempCopy`), syncing back to
storage on a periodic flush and on document close. For `local-key` mounts, the DB is opened in place. In
both cases, what WebDAV exposes is a logical row from `metadata.db` — SQLite WAL/SHM sidecars are not
tracked there and never appear in PROPFIND. So a backup tool sees `data.db` as a single file: either the
last-synced snapshot (`local`/`s3`, lagging by seconds-to-minutes during active editing) or the live but
checkpoint-consistent SQLite file (`local-key`). Stale at worst, never torn.

### Concurrency with active collab sessions

In `export` mode, a PUT on `Report.docx` while the same document is open in a Yjs collab session in the
browser would race the live CRDT state. Proposal: PUT returns 423 Locked if `Drive.isCollabOpen(pathId)`
is true. The user must close the browser tab first. Alternatives (merge the docx import into the live Yjs
state, or queue and replay) are interesting but high-risk for documents with track-changes or complex
tables — defer until we have data on how often this collision happens in practice.

In `raw` mode the question doesn't arise — the container internals are read-only.

### Caching

Export is non-trivial — `weasyprint` PDF generation can take seconds. Cache in `mount/tmp/webdav-export/`,
keyed by `${pathId}-${updatedAt}.${format}`. Invalidate naturally because `updatedAt` changes when the
underlying Yjs doc changes (`CollabDocument.touchUpdatedAt()`, throttled to 60s — see EXPORT.md). 5-minute
TTL on entries; sweep on next access.

```typescript
// apps/api/src/lib/webdav/export-cache.ts
async function getExportedFile(mount: Mount, path: DrivePath, format: ExportFormat): Promise<BunFile> {
    const cacheKey = `${path.id}-${path.updatedAt}.${format}`;
    const cachePath = join(mount.baseDir, 'tmp/webdav-export', cacheKey);
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

For a self-hosted Workspace alternative this is acceptable for typical office docs but unacceptable for
legal / engineering documents that depend on tracked changes. We surface this in the WebDAV onboarding
("editing complex Word features may not round-trip; use the web editor for those documents").

## Mac Finder, Office, and Windows Explorer quirks

Finder is the hardest target. A WebDAV server that "works in Cyberduck" usually does *not* work in Finder
out of the box. The known landmines:

| Quirk | Workaround |
|---|---|
| Finder sends `LOCK` before every `PUT` | Implement Class 2 LOCK (synthetic tokens fine; see Locks below). |
| Finder writes `.DS_Store`, `._foo` (AppleDouble) | Silently accept on PUT; do not list on PROPFIND. Optionally store in a hidden `metadata.appleDouble` JSON column. |
| Office uses `LOCK` + temp filename `~$Report.docx` + `MOVE` | Locks plus MOVE within the same collection both must work. |
| Office sends `If-Match: "etag"` on saves | Honor `If-Match`; return 412 if hash differs. |
| Windows requires HTTPS for Basic auth | Document HTTPS-only. Provide registry tweak only as a last resort. |
| Finder PROPFIND can stall on big folders | Cap Depth 1 listings to ~10k entries with a 502 if exceeded; suggest using the web app. |
| Finder uses `?` and `#` in filenames | URL-encode in `href` properly; reject names containing `/` and NUL (Mount already does this). |
| Finder `getetag` mismatch causes re-download loop | ETag must be **stable for the same content**. SHA-256 hash is perfect; do *not* include `updatedAt`. |
| Office sends `PROPPATCH` with `Win32CreationTime` etc. | Return 200 OK as no-op. |

### Locks

We do not need a real distributed lock manager. A single-node in-memory `LockManager` covers Finder + Office:

```typescript
class LockManager {
    private locks = new Map<string, Lock>(); // by token
    private byPath = new Map<string, Set<string>>(); // pathId → tokens

    acquire(pathId: string, depth: 0 | 'infinity', userId: string, ttlMs = 60_000): Lock {
        const token = `urn:uuid:${crypto.randomUUID()}`;
        const lock: Lock = { token, pathId, depth, userId, expiresAt: Date.now() + ttlMs };
        this.locks.set(token, lock);
        this.byPath.set(pathId, (this.byPath.get(pathId) ?? new Set()).add(token));
        return lock;
    }
    // refresh, release, checkAccess (rejects PUT/DELETE/MOVE without matching If header) ...
}
```

Persist later if multi-node deployments need it; the relay (`home-relay.ts`, see SCALABILITY.md) is the
right seam.

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
  proppatch.ts              # PROPPATCH (no-op for Win32* properties)
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

`OPTIONS` handling for `/webdav/*` lives in the same place as the existing CalDAV OPTIONS handler in
`apps/api/src/app.ts:31-42`, so CORS does not eat it.

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

    const responses: ResourceResponse[] = [resourceToProps(mount, path)];
    if (path.type === 'folder' && depth !== '0') {
        const children = await mount.listFolder(path.id);
        for (const child of children) {
            const overlay = applyContainerOverlay(child); // hides/renames eigen*
            if (overlay) responses.push(resourceToProps(mount, overlay));
        }
        if (depth === 'infinity') {
            // Optionally recurse — guard against pathological depth
        }
    }
    return buildMultistatus(responses);
});
```

## Quotas and rate limits

- **Per-mount quota**: `MountConfig.maxSizeMB`. Check `mount.usedBytes() + Content-Length` before
  starting a PUT. Return 507 Insufficient Storage on failure.
- **Per-user upload size**: `getUploadMaxSize(home, user.id)` from `apps/api/src/lib/config/enforcement.ts`
  — same value the regular Drive route enforces.
- **Concurrency**: WebDAV clients (esp. Finder) like to issue 4-8 parallel requests. Existing Bun /
  Elysia handling is fine; no special pooling. Locks serialise mutating ops on a single resource.
- **Rate limits**: defer to the global Elysia rate limiter; no protocol-specific limits.

## Testing strategy

- **Unit tests**: `apps/api/src/test/webdav/*.test.ts`. Tests in this repo are integration style with
  `getTestContext()` (see TESTING.md). Use the same harness — issue raw Bun `fetch()` calls with
  `Authorization: Basic ...` and the WebDAV verb. Compare XML responses against fixtures.
- **Real clients**: a manual smoke-test checklist for macOS Finder, Windows Explorer, Cyberduck, rclone,
  Word, Excel, LibreOffice. Document in `docs/WEBDAV-COMPATIBILITY.md` after first ship. Each row of the
  Quirks table needs a recorded pass/fail.
- **Regression suite**: capture real Finder / Office traffic with `tcpdump`+`tcpflow` and replay it as
  fixtures. The single highest-value test is "open a docx in Word, edit, save, close" — exercises LOCK,
  PUT, ETag, MOVE, UNLOCK in sequence.

## Phased plan

| Phase | Scope | Effort |
|---|---|---|
| 1 | Read-only Class 1 — `OPTIONS`, `PROPFIND`, `GET`, `HEAD`. App-password auth via `verifyProtocolAuth`. Multistatus XML helpers (lift from CalDAV). ETags from `path.hash`. Range requests in `StorageBackend`. Containers naturally appear as plain folders (raw mode). | M |
| 2 | Write Class 1 — `PUT` (create + overwrite), `MKCOL`, `DELETE` (to trash), `MOVE`, `COPY` (in-mount). `Mount.resolvePath`, `Mount.copyPath`, `usedBytes`. Quota enforcement. **Container-internals read-only guard** — any write inside `*.eigen*` returns 423. | M |
| 3 | Mac / Office polish — `LOCK` / `UNLOCK` in-memory `LockManager`. AppleDouble (`._x`, `.DS_Store`) silent accept. `PROPPATCH` no-op for `Win32*`. Stable ETags verified against Finder + Word + Excel. | M |
| 4 | UI — "WebDAV access" panel in the Drive app sidebar: shows mount URL, lets the user generate / revoke a scoped app password, copy connection string for Finder. | S |
| 5 (opt-in) | `export` mode read — toggleable per-mount. eigen* listed under their export filename. GET dispatches to `exportDocument()`. On-disk export cache keyed by `(pathId, updatedAt, format)`. Per-mount default-format setting. | M |
| 6 (opt-in) | `export` mode write — PUT on `Report.docx` calls `importIntoDocument()` for eigendoc / eigensheets. 423 Locked when a Yjs collab session is open for the path (`Drive.isCollabOpen(pathId)`). | L |
| 7 (future) | rclone-mount documentation + recipe. Test FUSE-T on macOS as an officially-supported alternate path for users who hit Finder bugs. | S |
| 8 (future) | Native macOS File Provider extension. Separate Xcode project; signed Mac app distributed via the Eigen download page. Only worth doing once usage data justifies the build cost. | XL |

## Open questions

1. **Permanent delete vs trash on `DELETE`**. Default to trash, since Finder `DELETE` is a "move to trash"
   gesture in the user's mental model. Permanent delete via the web app or a `?permanent=1` query param.
2. **`export` mode global enable**. Per-mount setting feels right (some users want it, others don't), but
   we should consider whether to expose it in the global server settings too. For now, per-mount only.
3. **Shared drives and team mounts**. WebDAV URL is `:ownerId/:mountId/*`. For team mounts, ownerId =
   `team_{teamId}`. The Drive app should surface those URLs explicitly; users may want one connection per
   team they belong to, which becomes one Finder volume each. Acceptable.
4. **Sub-path mounts**. Should we let a user mount only `/Photos/2025` instead of the whole mount?
   Probably no for v1 — adds complexity, and Finder cannot mount sub-collections per OS conventions.
5. **Public / unauthenticated shares**. Out of scope. Anything shared via Eigen's public-link feature
   stays in the existing REST endpoint.
6. **Large file streaming**. PUT bodies arrive as a request stream. `createFileFromTemp` already writes
   to a temp file before the DB insert (mount.ts:334) — pipe Bun's request body into a `Bun.write(tmp)`
   and pass it on. No need to buffer in memory.

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
| PROPPATCH | `apps/api/src/lib/webdav/proppatch.ts` | new |
| LOCK / UNLOCK | `apps/api/src/lib/webdav/locks.ts` | new |
| Container overlay | `apps/api/src/lib/webdav/container-overlay.ts` | new |
| Export cache | `apps/api/src/lib/webdav/export-cache.ts` | new |
| Path resolver | `apps/api/src/lib/webdav/path-resolve.ts` | new |
| `Mount.resolvePath` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Mount.copyPath` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `Mount.usedBytes` | `apps/api/src/lib/mount/mount.ts` | edit (add) |
| `StorageBackend.readRange` | `apps/api/src/lib/storage/types.ts` + impls | edit |
| Router mount + OPTIONS | `apps/api/src/app.ts` | edit (add) |
| WebDAV credentials UI | `apps/drive/src/components/settings/webdav-panel.tsx` | new |
| Tests | `apps/api/src/test/webdav/*.test.ts` | new |
| Compatibility doc | `docs/WEBDAV-COMPATIBILITY.md` | new (after Phase 3) |

## See also

- [STORAGE.md](STORAGE.md) — Mount + StorageBackend internals
- [EXPORT.md](EXPORT.md) — eigen* → docx/xlsx/pdf pipeline (reused by Phase 4)
- [IMAP.md](IMAP.md) — analogous protocol bridge over Maildir (different file model, same auth pattern)
- [ACL.md](ACL.md) — permission model the WebDAV layer enforces
- [SCALABILITY.md](SCALABILITY.md) — locks become per-Home if homes ever shard across machines
- RFC 4918 — HTTP Extensions for WebDAV (the protocol definition)
- RFC 5689 — extended MKCOL (we do not need this, plain RFC 4918 MKCOL is enough)
