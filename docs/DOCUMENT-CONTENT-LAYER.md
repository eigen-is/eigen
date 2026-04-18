# Document Content Layer

Server-side read/write access to Eigen documents (docs, sheets, slides). Supports three use cases:

- **Export**: read document → convert to file format (.xlsx, .docx, .pptx)
- **Import**: parse file format → write to document (changes appear real-time in connected clients)
- **Scripting**: read + write documents programmatically via API

## Design

No new abstractions. The existing `CollabDocument` already handles persistence and WebSocket broadcast.
The Document Content Layer is just **per-type functions** that read/write the Y.Doc inside it.

```
CollabDocument (exists — persistence + WebSocket broadcast)
     │
   Y.Doc
     │
     ├── readSheets(doc) / writeSheets(doc, ...)     ← per-type read/write
     ├── readDoc(doc)    / writeDoc(doc, ...)
     └── readSlides(doc) / writeSlides(doc, ...)
               │
     ┌─────────┼─────────┐
     Export   Import   Scripting
```

Any write to the Y.Doc automatically:
1. Persists to SQLite (CollabDocument's update handler)
2. Broadcasts to connected WebSocket clients (real-time)

No extra plumbing needed. Write to the doc, and connected users see changes appear.

## Yjs Structures by Type

| Type   | Yjs root                                                           | Data model          |
|--------|--------------------------------------------------------------------|---------------------|
| Sheets | `Y.Map('state')` (snapshot JSON) + `Y.Array('ops')` (delta ops)   | `Sheet[]` (2D cell arrays with formulas, formatting) |
| Docs   | `Y.XmlFragment('default')` (Tiptap/ProseMirror)                   | ProseMirror JSON tree |
| Slides | `Y.Map('slides')` + `Y.Map('objects')` + `Y.Array('slideOrder')` | Slide objects with position/style/text |

## File Layout

Existing export code moves from `lib/export/` into `lib/document/`. Import code lives alongside.

```
apps/api/src/lib/document/
├── sheets.ts                    # readSheets(doc), writeSheetSnapshot(doc, sheets)
├── import/
│   └── sheets-xlsx.ts           # xlsxToSheets(buffer) — pure converter
├── export/
│   ├── export-document.ts       # exportDocument() dispatcher (moved from lib/export/)
│   ├── doc/                     # (moved from lib/export/doc/)
│   │   ├── content.ts
│   │   ├── docx.ts
│   │   ├── html.ts
│   │   ├── pdf.ts
│   │   └── render.ts
│   ├── slides/                  # (moved from lib/export/slides/)
│   │   ├── content.ts
│   │   ├── html.ts
│   │   ├── pdf.ts
│   │   └── render.ts
│   ├── sheets/                  # (new — future xlsx export)
│   ├── fonts.ts                 # (moved from lib/export/)
│   ├── media.ts                 # (moved from lib/export/)
│   ├── weasyprint.ts            # (moved from lib/export/)
│   └── modules.d.ts             # (moved from lib/export/)
```

Content read functions (existing `doc/content.ts`, `slides/content.ts`) stay in the export
subdirectory for now — they're tightly coupled to their export renderers. `sheets.ts` at the
top level is new and shared by both import and export.

## Route Patterns

Three route patterns on the same file path prefix (`/drive/:ownerId/:mountId/file/:pathId/`):

| Route | Method | What it does |
|-------|--------|-------------|
| `.../export/:format` | `GET` | Eigen doc → file download (docx, pdf, xlsx) |
| `.../convert/:targetType` | `POST` | Drive file → new Eigen doc alongside it |
| `.../import` | `POST` | Upload file → overwrite existing Eigen doc content |

**Export** (exists): source is an Eigen doc, returns file download.

**Convert** (new): source is a regular file in Drive (e.g., .xlsx), creates a new Eigen
document of `:targetType` in the same folder. Drive context menu: "Convert to Sheet".

**Import** (new): source is an uploaded file in the request body, target is the Eigen doc
at `:pathId`. Sheets app: "Import xlsx" menu item replaces sheet content.

All use `drive.resolveFile()` for ACL. None add methods to the Drive class.

### Convert route (Drive file → new Eigen doc)

```typescript
.post(
    '/drive/:ownerId/:mountId/file/:pathId/convert/:targetType',
    async ({ params, user }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await convertDocument(drive, params.mountId, params.pathId, params.targetType);
    },
    { auth: true },
)
```

```typescript
// apps/api/src/lib/document/import/convert-document.ts

async function convertDocument(
    drive: SharedDrive, mountId: string, pathId: string, targetType: string
): Promise<{ path: DrivePath }> {
    const { mount, path } = await drive.resolveFile(mountId, pathId);

    if (targetType === 'eigensheets') {
        if (!path.name.endsWith('.xlsx'))
            throw new ApiError(400, 'Only .xlsx files can be converted to sheets');

        // 1. Read the xlsx file from drive storage
        const buffer = await mount.readFile(path.id);

        // 2. Parse xlsx → Sheet[] (pure converter)
        const sheets = await xlsxToSheets(buffer);

        // 3. Create new eigensheets document alongside the source file
        const name = path.name.replace(/\.xlsx$/i, '');
        const newPath = await drive.createSheets(mountId, path.parentId, name);

        // 4. Open its collab document and write the snapshot
        const collabDoc = await drive.getCollabDocument(mountId, newPath.id);
        writeSheetSnapshot(collabDoc.doc, sheets);

        return { path: newPath };
    }
    throw new ApiError(400, `Conversion to "${targetType}" is not supported`);
}
```

### Import route (upload into existing Eigen doc)

```typescript
.post(
    '/drive/:ownerId/:mountId/file/:pathId/import',
    async ({ params, request, user }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await importIntoDocument(drive, params.mountId, params.pathId, request);
    },
    { auth: true, parse: 'none' },
)
```

```typescript
// apps/api/src/lib/document/import/import-document.ts

async function importIntoDocument(
    drive: SharedDrive, mountId: string, pathId: string, request: Request
): Promise<{ success: true }> {
    const { mount, path } = await drive.resolveFile(mountId, pathId);

    if (path.mimeType === DRIVE_MIME_SHEETS) {
        // Parse uploaded xlsx from request body
        const buffer = Buffer.from(await request.arrayBuffer());
        const sheets = await xlsxToSheets(buffer);

        // Write into the existing document's Y.Doc
        const collabDoc = await drive.getCollabDocument(mountId, pathId);
        writeSheetSnapshot(collabDoc.doc, sheets);

        return { success: true };
    }
    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}
```

## Frontend Integration

Two entry points, two different routes:

### Drive context menu: "Convert to Sheet"

Shown on `.xlsx` files in the drive file browser. Hits the **convert** route — creates a
new eigensheets alongside the xlsx file, then navigates to it or refreshes the folder.

```typescript
// In drive's context menu items
{
    label: 'Convert to Sheet',
    icon: Sheet,
    visible: (path) => path.name.endsWith('.xlsx'),
    onClick: (path) => convertMutation.mutate({
        mountId, pathId: path.id, targetType: 'eigensheets'
    }),
}
```

### Sheets app: "Import xlsx"

Menu item in the sheets toolbar. Opens a file picker, uploads the xlsx directly to the
**import** route — replaces the current sheet's content. Single request, no intermediate
drive file.

```typescript
// In sheets toolbar/file menu
{
    label: 'Import xlsx',
    onClick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx';
        input.onchange = () => importMutation.mutate({
            mountId, pathId, file: input.files[0]
        });
        input.click();
    },
}
```

## Content Read/Write Functions

### Sheets

```typescript
// apps/api/src/lib/document/sheets.ts

// Read: snapshot + replay pending ops → clean Sheet[]
function readSheets(doc: Y.Doc): Sheet[]

// Write full snapshot (for import — replaces everything)
function writeSheetSnapshot(doc: Y.Doc, sheets: Sheet[]): void
```

**Read path**: Parse `state.snapshot` JSON, replay ops from `Y.Array('ops')`. Optionally
recalculate formulas via `FormulaEngine.recalculateAll(createArrayResolver(sheets))`.

**Write path**: Replace snapshot entirely in a single transaction:
```typescript
function writeSheetSnapshot(doc: Y.Doc, sheets: Sheet[]) {
    doc.transact(() => {
        doc.getMap('state').set('snapshot', JSON.stringify(sheets))
        const ops = doc.getArray('ops')
        ops.delete(0, ops.length)
    })
}
```

### Future: granular writes for scripting

```typescript
// Write single cell (appears as one edit to connected clients)
function writeSheetCell(doc: Y.Doc, sheetId: string, r: number, c: number, value: CellUpdate): void

// Write range (batch cell updates in one transaction)
function writeSheetRange(doc: Y.Doc, sheetId: string, updates: CellRangeUpdate[]): void
```

Push ops to `Y.Array('ops')` using the same op format the client uses. Connected clients
apply via `applyOp()` — granular, no full reload.

### Docs

```typescript
// Read: Y.XmlFragment → ProseMirror JSON
function readDocJSON(doc: Y.Doc): ProseMirrorJSON

// Write: ProseMirror JSON → Y.XmlFragment (for import)
function writeDocFromJSON(doc: Y.Doc, content: ProseMirrorJSON): void
```

### Slides

```typescript
// Read: Y.Maps → plain SlideData
function readSlides(doc: Y.Doc): SlideData

// Write: SlideData → Y.Maps (for import)
function writeSlides(doc: Y.Doc, slides: SlideData): void
```

## xlsx → Sheet[] Converter

The core of sheets import. A pure function: buffer in, `Sheet[]` out.

```typescript
// apps/api/src/lib/document/import/sheets-xlsx.ts

async function xlsxToSheets(buffer: Buffer): Promise<Sheet[]>
```

Uses `exceljs` to parse the xlsx. Maps ExcelJS types to fortune-sheet types:

| ExcelJS                        | Fortune-sheet Cell       |
|--------------------------------|--------------------------|
| `cell.value` (number)          | `v`, `ct: { t: 'n' }`   |
| `cell.value` (string)          | `v`, `ct: { t: 's' }`   |
| `cell.value` (boolean)         | `v`, `ct: { t: 'b' }`   |
| `cell.value` (Date)            | `v` (serial number), `ct: { t: 'n', fa: date format }` |
| `cell.formula`                 | `f: '=' + formula`       |
| `cell.numFmt`                  | `ct: { fa: numFmt }`     |
| `cell.style.font.bold`         | `bl: 1`                  |
| `cell.style.font.italic`       | `it: 1`                  |
| `cell.style.font.size`         | `fs`                     |
| `cell.style.font.color`        | `fc`                     |
| `cell.style.fill`              | `bg`                     |
| `cell.style.alignment.horizontal` | `ht` (0=center, 1=left, 2=right) |
| `cell.style.alignment.vertical`   | `vt` (0=middle, 1=top, 2=bottom) |
| `cell.style.alignment.wrapText`   | `tb: '2'`               |
| Merged cells                   | `config.merge` + `mc` on cells |
| Row heights                    | `config.rowlen`          |
| Column widths                  | `config.columnlen`       |
| Hidden rows/columns            | `config.rowhidden`, `config.colhidden` |
| Frozen panes                   | `frozen: { type, range }` |
| `worksheet.name`               | `name`                   |

The converter handles the common cases. Unsupported features (charts, pivot tables,
conditional formatting) are silently skipped — the sheet is still usable, just without
those features.

## Implementation Order

1. **Move existing export code** — `lib/export/` → `lib/document/export/`, update imports
2. **`xlsxToSheets()`** — pure converter, add `exceljs` dependency
3. **`writeSheetSnapshot()`** — write Sheet[] into Y.Doc
4. **Convert route** — `POST /file/:pathId/convert/eigensheets` + Drive context menu
5. **Import route** — `POST /file/:pathId/import` + Sheets "Import xlsx" menu item
6. **`readSheets()`** — parse snapshot + replay ops (needed for export + scripting)
7. **Sheets xlsx export** — `sheetsToXlsx()` + wire into export route

Steps 2-3 are the foundation (pure converter + Yjs write). Steps 4-5 wire them into two
user-facing flows. Start with import because it's higher value for onboarding than export.

## What Already Exists

| Component | Location | Status |
|---|---|---|
| `loadYjsState()` | `apps/api/src/lib/collab/yjs-loader.ts` | Ready |
| `CollabDocument` | `apps/api/src/lib/collab/collabDocument.ts` | Ready |
| `jsonToYType()` | `packages/lib/src/core/collab/yjs-utils.ts` | Ready |
| `FormulaEngine.recalculateAll()` | `packages/fortune-sheet/src/engine/` | Ready |
| Doc content reader | `apps/api/src/lib/export/doc/content.ts` | Ready (will move) |
| Slides content reader | `apps/api/src/lib/export/slides/content.ts` | Ready (will move) |
| Export route | `apps/api/src/routes/drive.ts` L162-172 | Ready |
| `exportDocument()` | `apps/api/src/lib/export/export-document.ts` | Ready (will move) |
| `drive.createSheets()` | `apps/api/src/lib/drive/drive.ts` | Ready |
| `drive.getCollabDocument()` | `apps/api/src/lib/drive/drive.ts` | Ready |
| `applyOp()` format | `packages/fortune-sheet/src/state/types.ts` | Ready |
