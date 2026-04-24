# Document Content Layer

> **Status (2026-04-19):** Export is implemented for eigendoc (DOCX/PDF/HTML) and slides
> (HTML/PDF) — see [EXPORT.md](EXPORT.md) for the authoritative export docs. Import is
> implemented for XLSX → eigensheets only (`lib/import/sheets/`). The unified
> `lib/document/` folder proposed below was not created — read/write functions live in
> `lib/export/` and `lib/import/` respectively. The architecture below remains the design
> target for when scripting or additional import formats are added.

One mechanism for reading and writing Eigen document content (docs, sheets, slides) on the
server, shared by **export**, **import**, and the future **scripting engine**. No new
persistence layer, no new broadcast layer, no duplicated code.

The `Y.Doc` inside `CollabDocument` is the single source of truth. Writes to it automatically
persist (via `DbProvider`) and broadcast to connected clients (via the existing collab sync
protocol). Everything else in this document is just plumbing around that fact.

## The layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: callers                                                │
│  Drive routes   •   Scripting SDK handler   •   Export pipeline  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ uses
┌───────────────────────────▼─────────────────────────────────────┐
│  Layer 3: addressing helpers (resolve a Y.Doc from IDs)          │
│    For writes: drive.getCollabDocument(mountId, pathId)          │
│    For reads:  mount.openDatabase(...) + loadYjsState()          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ produces Y.Doc
┌───────────────────────────▼─────────────────────────────────────┐
│  Layer 2: per-type Yjs content functions                         │
│    readSheets(doc) / writeSheets(doc, sheets) / pushSheetOps     │
│    readDoc(doc)    / writeDoc(doc, json)                         │
│    readSlides(doc) / writeSlides(doc, deck)                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │ uses
┌───────────────────────────▼─────────────────────────────────────┐
│  Layer 1: pure converters (no Yjs, no Drive)                     │
│    xlsxToSheets(buf) / sheetsToXlsx(sheets)                      │
│    docxToPmJson(buf) / pmJsonToDocx(json, media)                 │
│    pptxToDeck(buf)   / deckToPptx(deck, media)                   │
└─────────────────────────────────────────────────────────────────┘
```

Each layer depends only on the one below it. Layers 1 and 2 are pure functions with no
network or filesystem access — trivial to unit-test.

## Why writes "just work"

A write at Layer 2 looks like this:

```typescript
function writeSheets(doc: Y.Doc, sheets: Sheet[]): void {
    doc.transact(() => {
        doc.getMap('state').set('snapshot', JSON.stringify(sheets));
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}
```

Because `doc` is the `Y.Doc` owned by `CollabDocument`, this mutation triggers its update
handler which (a) inserts a row in `data.db` via `DbProvider.storeUpdate()` and (b) sends a
sync message to every connected WebSocket. Connected editors see the change appear in real
time with **no extra plumbing in this file**. That is the whole point of routing imports
through `CollabDocument.doc` rather than writing to the DB directly.

## Reads: two paths, same result

For reads, two paths exist and both yield the same content because they read from the same
`data.db`:

| Path | When to use | Cost |
|------|-------------|------|
| `mount.openDatabase(COLLAB_DB_CONFIG, dataDbId)` + `loadYjsState()` | One-shot reads (export, preview, scripting `get*`) | Ephemeral `Y.Doc` — disposable |
| `drive.getCollabDocument(mountId, pathId).doc` | When you also write in the same flow, or need up-to-the-millisecond freshness | Creates a long-lived collab instance |

The export pipeline already uses the cheap path (`export/doc/content.ts`, `export/slides/
content.ts`). Keep it. Don't reroute reads through `CollabDocument` unless there's a reason —
it caches a live instance that isn't cleaned up until the next WebSocket close.

## Writes: one path

Always through `drive.getCollabDocument()`. Direct writes to `data.db` would bypass
broadcast, which defeats the whole point — connected clients would miss the change and
overwrite it on their next save.

### Permission check is the caller's responsibility

`SharedDrive.getCollabDocument()` only checks **read** permission. The usual write check
lives in `CollabDocument.handleMessage(canWrite)` — per WebSocket message. **Direct writes
bypass that check**, so route handlers must call `drive.canWrite(...)` before writing.
`drive.create()` already verifies write permission on the parent folder, so
newly-created documents don't need a second check.

## Per-type functions

All live in `apps/api/src/lib/document/` as pure functions on `Y.Doc`.

### Sheets (`document/sheets.ts`)

```typescript
// Snapshot = the JSON blob in Y.Map('state'). Pending ops in Y.Array('ops') are not
// replayed server-side (fortune-sheet's applyOp is client-side). OK in Phase 1 because
// clients flush the snapshot on save/beforeunload — see use-sheet.ts.
function readSheets(doc: Y.Doc): Sheet[]

// Full replace. Used by import.
function writeSheets(doc: Y.Doc, sheets: Sheet[]): void

// Future: granular writes for scripting. Pushes to Y.Array('ops') in the same op format
// clients produce, so connected clients apply via workbook.applyOp() — no full reload.
function pushSheetOps(doc: Y.Doc, ops: Op[]): void
```

### Docs (`document/doc.ts`)

```typescript
function readDoc(doc: Y.Doc): JSONContent
// Uses yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'))
// Already implemented in export/doc/content.ts — move or re-export.

function writeDoc(doc: Y.Doc, json: JSONContent): void
// Build a temp doc via prosemirrorJSONToYDoc() (y-prosemirror), then merge into doc
// via restoreYjsDoc() from packages/lib/src/core/collab/yjs-utils.ts. Both primitives
// already exist.
```

### Slides (`document/slides.ts`)

```typescript
function readSlides(doc: Y.Doc): DeckData
// Already implemented in export/slides/content.ts — move or re-export.

function writeSlides(doc: Y.Doc, deck: DeckData): void
// Same recipe as writeDoc: build temp doc with Y.Map('slides'), Y.Map('objects'),
// Y.Array('slideOrder'), then restoreYjsDoc into target.
```

All write functions wrap their mutations in `doc.transact()` so they produce a single Yjs
update (one broadcast, one DB row).

## Pure converters

No Yjs, no Drive, no filesystem. Just buffer ⇆ native content type.

```
apps/api/src/lib/document/convert/
  xlsx.ts   # xlsxToSheets(buf): Sheet[]                sheetsToXlsx(sheets): Buffer
  docx.ts   # docxToPmJson(buf): JSONContent            pmJsonToDocx(json, media): Buffer
  pptx.ts   # pptxToDeck(buf): DeckData                 deckToPptx(deck, media): Buffer
```

Converters operate on the **native** per-type content (`Sheet[]`, `JSONContent`, `DeckData`).
Higher layers (scripting SDK) can wrap these in DTOs (`SheetContent`, `DocContent`) if they
want a normalized API shape — that's additive and stays out of the content layer.

## Route patterns

Three route patterns share the `/drive/:ownerId/:mountId/file/:pathId/` prefix.

| Route | Method | What it does |
|-------|--------|--------------|
| `.../export/:format` | GET | Eigen doc → downloadable file (existing) |
| `.../convert/:targetType` | POST | Drive file → new Eigen doc in the same folder |
| `.../import` | POST | Upload → overwrite existing Eigen doc content |

All three use `drive.resolveFile()` for ACL resolution and mount access. Only convert and
import touch `drive.getCollabDocument()` (for writes). None add methods to `Drive`.

### Convert (new)

```typescript
.post('/drive/:ownerId/:mountId/file/:pathId/convert/:targetType', async ({ params, user }) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);

    if (params.targetType !== 'eigensheets') {
        throw new ApiError(400, `Conversion to "${params.targetType}" is not supported`);
    }
    if (!path.name.toLowerCase().endsWith('.xlsx')) {
        throw new ApiError(400, 'Only .xlsx files can be converted to sheets');
    }

    const buffer = await mount.readFile(path.id);
    const sheets = await xlsxToSheets(buffer);

    // drive.create enforces write permission on path.parentId.
    const name = path.name.replace(/\.xlsx$/i, '');
    const newPath = await drive.create(params.mountId, path.parentId, name, 'sheets');

    const collabDoc = await drive.getCollabDocument(params.mountId, newPath.id);
    writeSheets(collabDoc.doc, sheets);
    return newPath;
}, { auth: true })
```

### Import (new)

```typescript
.post('/drive/:ownerId/:mountId/file/:pathId/import', async ({ params, request, user }) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const { path } = await drive.resolveFile(params.mountId, params.pathId);

    if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
        throw new ApiError(403, 'No write permission');
    }

    const maxSize = await getUploadMaxSize(params.ownerId, user.id, params.mountId);
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.byteLength > maxSize) throw new ApiError(413, 'Upload too large');

    if (path.mimeType === DRIVE_MIME_SHEETS) {
        const sheets = await xlsxToSheets(buffer);
        const collabDoc = await drive.getCollabDocument(params.mountId, params.pathId);
        writeSheets(collabDoc.doc, sheets);
        return { success: true };
    }
    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}, { auth: true, parse: 'none' })
```

## Scripting integration

The future scripting SDK handler calls the **same** Layer 2 functions. Only addressing
differs — routes go through `SharedDrive` with a user context, scripts go through `Home`
with an `ownerId`:

```typescript
// In apps/api/src/lib/scripts/sdk-handler.ts (Phase 2)

"sheets.getRange": {
    permission: "drive:read",
    handler: async (home, p) => {
        const mount = home.drive.getMount(p.mountId);
        const dataDbPath = await mount.getChildByName(p.pathId, 'data.db');
        const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
        const { doc } = loadYjsState(managedDb);
        return extractRange(readSheets(doc), p.cell);
    },
},

"sheets.setCell": {
    permission: "drive:write",
    handler: async (home, p) => {
        const collabDoc = await home.drive.getCollabDocument(p.mountId, p.pathId);
        pushSheetOps(collabDoc.doc, [{ op: 'v', r: p.row, c: p.col, v: p.value }]);
        return { ok: true };
    },
},
```

Same `readSheets` / `pushSheetOps` — no duplicated content logic. The scripting SDK never
touches XLSX or DOCX converters; those are for file-format I/O only.

If a DTO layer turns out useful (e.g. `readSheetContent(ownerId, mountId, pathId):
SheetContent` that normalizes value/formula/display into a flat cell list), it belongs in
the scripting side as a thin wrapper over Layer 2 — not inside this layer.

## File layout

```
apps/api/src/lib/import/
  import-document.ts        # dispatcher — convertToDocument, importIntoDocument
  sheets/
    from-xlsx.ts            # xlsxToSheets(buffer): Sheet[]
    writer.ts               # writeSheetsToDoc(doc, sheets)
```

`apps/api/src/lib/export/` stays where it is; `lib/import/` mirrors its shape (dispatcher
at the top, per-type subdirectories). Future additions go next to the existing ones:
`lib/import/doc/from-docx.ts`, `lib/import/slides/from-pptx.ts`. Read-side helpers
(`readSheets`, `readDoc`, `readSlides`) remain in `lib/export/*/content.ts` for now and
can be hoisted into a shared `lib/document/` folder later — not a blocker.

## Frontend integration

Two new entry points, two mutations in `packages/lib/src/core/drive/hooks/`.

- **Drive context menu: "Convert to Sheet"** — shown on `.xlsx` files. Calls the convert
  route, then navigates to the new eigensheets file.
- **Sheets app toolbar: "Import xlsx"** — opens a file picker filtered to `.xlsx`, uploads
  directly to the import route, which overwrites the current sheet.

Both hooks follow the project's `onMutationError` pattern — error toasts live in the hook,
not in app components.

## Implementation order

Start with just enough to ship xlsx → sheets for both flows:

1. **`import/sheets/from-xlsx.ts`** — `xlsxToSheets(buffer)`. Add `exceljs` dep.
2. **`import/sheets/writer.ts`** — `writeSheetsToDoc(doc, sheets)`. Snapshot replace only.
3. **`import/import-document.ts`** — dispatcher `convertToDocument` / `importIntoDocument`.
4. **Convert + import routes** in `apps/api/src/routes/drive.ts` — thin handlers that
   delegate to the dispatcher.
5. **Drive "Convert to Sheet"** context menu + `useConvertDocument` hook.
6. **Sheets "Import xlsx"** toolbar item + `useImportDocument` hook.

Then only when needed:

7. `readSheets(doc)` + `sheetsToXlsx(sheets)` → wire into `exportDocument()` for `xlsx`.
8. `writeDocFromDocx` / `writeSlidesFromPptx` converters → DOCX/PPTX import.
9. `pushSheetOps` + scripting SDK granular writes.

Steps 1–6 are a few hundred lines total. No refactoring required, no new abstractions on
top of what `CollabDocument` and `drive.getCollabDocument()` already give us.

## Edge cases & tradeoffs

- **Sheets ops are not replayed on read.** Fortune-sheet's formula engine and op application
  are client-side. Snapshots are flushed on save and `beforeunload`, so Phase 1 reads the
  last flushed state — slightly stale under active editing. Server-side op replay + recalc
  via `FormulaEngine.recalculateAll()` is tracked in [SHEETS.md](SHEETS.md#remaining-work--server-side-recalc).
- **Write permission must be checked explicitly.** `SharedDrive.getCollabDocument()` only
  checks read permission; the WebSocket path's per-message `canWrite` gate doesn't apply to
  direct writes. Add an explicit `drive.canWrite(...)` before any direct write.
- **`getCollabDocument()` keeps a live instance warm.** For a one-shot import with no
  connected editors, the instance stays in memory until the next `closeCollabDocument()` or
  `shutdownAllHomes()`. Not a leak, but worth noting.
- **Import is lossy by design.** XLSX → fortune-sheet drops charts, pivot tables, and
  conditional formatting. Document this in the user-facing copy, don't try to preserve
  everything.
- **No migration needed.** This design doesn't change any existing data layout — it only
  adds new entry points.

## What already exists

| Component | Location | Status |
|-----------|----------|--------|
| `loadYjsState()` | `apps/api/src/lib/collab/yjs-loader.ts` | Ready |
| `CollabDocument` (broadcast + persist) | `apps/api/src/lib/collab/collabDocument.ts` | Ready |
| `jsonToYType`, `restoreYjsDoc` | `packages/lib/src/core/collab/yjs-utils.ts` | Ready |
| `drive.resolveFile()`, `createSheets()`, `getCollabDocument()`, `canWrite()` | `apps/api/src/lib/drive/drive.ts` | Ready |
| Export route + dispatcher | `apps/api/src/routes/drive.ts` L162, `lib/export/export-document.ts` | Ready |
| Doc content reader | `apps/api/src/lib/export/doc/content.ts` | Ready — may migrate |
| Slides content reader | `apps/api/src/lib/export/slides/content.ts` | Ready — may migrate |
| Fortune-sheet op types | `packages/fortune-sheet/src/state/types.ts` | Ready |
