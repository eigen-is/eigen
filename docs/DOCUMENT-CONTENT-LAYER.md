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
     ├── readSheets(doc) / writeSheets(doc, ...)     ← NEW: per-type functions
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

## API

### Opening a document

```typescript
// apps/api/src/lib/document/open.ts

async function openDocumentContent(
    home: Home, mountId: string, pathId: string
): Promise<{ doc: Y.Doc, type: 'sheets' | 'doc' | 'slides' }>
```

Uses existing `home.drive.getCollabDocument()` to get the live CollabDocument (with WebSocket
connections). Returns the Y.Doc and detected type. If no clients are connected, loads from DB
via `loadYjsState()`.

### Sheets

```typescript
// apps/api/src/lib/document/sheets.ts

// Read: snapshot + replay pending ops → clean Sheet[]
function readSheets(doc: Y.Doc): Sheet[]

// Write full snapshot (for import — replaces everything)
function writeSheetSnapshot(doc: Y.Doc, sheets: Sheet[]): void

// Write single cell (for scripting — granular, appears as one edit)
function writeSheetCell(doc: Y.Doc, sheetId: string, row: number, col: number, value: CellUpdate): void

// Write range (for scripting — batch cell updates in one transaction)
function writeSheetRange(doc: Y.Doc, sheetId: string, updates: CellRangeUpdate[]): void
```

**Read path**: Parse `state.snapshot` JSON, replay ops from `Y.Array('ops')`. Optionally
recalculate formulas via `FormulaEngine.recalculateAll(createArrayResolver(sheets))`.

**Write path for import**: Replace snapshot entirely — `state.set('snapshot', JSON.stringify(sheets))`,
clear ops array. Connected clients reload.

**Write path for scripting**: Push ops to `Y.Array('ops')` using the same op format the client uses.
Connected clients apply via `applyOp()` — granular, no full reload.

### Docs

```typescript
// apps/api/src/lib/document/docs.ts

// Read: Y.XmlFragment → ProseMirror JSON
function readDocJSON(doc: Y.Doc): ProseMirrorJSON

// Write: ProseMirror JSON → Y.XmlFragment (for import)
function writeDocFromJSON(doc: Y.Doc, content: ProseMirrorJSON): void

// Write: plain text → Y.XmlFragment (for simple scripting)
function writeDocText(doc: Y.Doc, text: string): void
```

**Read path**: `yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'))` — already exists
in `apps/api/src/lib/export/doc/content.ts`.

**Write path**: Use `@tiptap/y-tiptap`'s `prosemirrorJSONToYDoc()` or manually construct
Y.XmlElement/Y.XmlText nodes inside a `doc.transact()`.

### Slides

```typescript
// apps/api/src/lib/document/slides.ts

// Read: Y.Maps → plain SlideData
function readSlides(doc: Y.Doc): SlideData

// Write: SlideData → Y.Maps (for import)
function writeSlides(doc: Y.Doc, slides: SlideData): void
```

**Read path**: Already exists in `apps/api/src/lib/export/slides/content.ts` — iterate
`Y.Map('slides')`, `Y.Map('objects')`, `Y.Array('slideOrder')`.

**Write path**: Clear and repopulate the Y.Maps inside a `doc.transact()`. Use
`jsonToYType()` from `packages/lib/src/core/collab/yjs-utils.ts` to convert plain objects
to Y.Map/Y.Array.

## File Layout

```
apps/api/src/lib/document/
├── open.ts              # openDocumentContent() — shared entry point
├── sheets.ts            # readSheets, writeSheetSnapshot, writeSheetCell, writeSheetRange
├── docs.ts              # readDocJSON, writeDocFromJSON, writeDocText
└── slides.ts            # readSlides, writeSlides
```

## Export / Import Flow

```
Export:  readSheets(doc)  →  sheetsToXlsx(sheets)  →  Response (file download)
Import:  xlsxBuffer  →  xlsxToSheets(buffer)  →  writeSheetSnapshot(doc, sheets)
```

Converters live alongside the content functions:

```
apps/api/src/lib/document/
├── sheets.ts                # read/write Yjs
├── sheets-xlsx.ts           # sheetsToXlsx(), xlsxToSheets() — OOXML conversion
├── docs-docx.ts             # docToDocx(), docxToDoc() — future
└── slides-pptx.ts           # slidesToPptx(), pptxToSlides() — future
```

The converter functions are pure: they take structured data in, produce bytes out (or vice versa).
No Yjs knowledge, no database access. Easy to test in isolation.

## Scripting Flow

```
Script API call  →  openDocumentContent()  →  readSheets(doc)  →  script logic
                                           →  writeSheetCell(doc, ...)  →  real-time update
```

Scripting routes expose a subset of the read/write functions as HTTP endpoints. Scripts can
also run server-side (future) with direct access to the functions.

## Implementation Order

1. **`readSheets()`** — parse snapshot + replay ops. Foundation for everything else
2. **`sheetsToXlsx()`** — export sheets to .xlsx using a library (`exceljs` or `xlsx-js-style`)
3. **Export route** — wire into existing `/drive/:ownerId/:mountId/file/:pathId/export/xlsx`
4. **`xlsxToSheets()`** — parse .xlsx into Sheet[] structure
5. **`writeSheetSnapshot()`** — import into Yjs, enabling .xlsx import
6. **`writeSheetCell/Range()`** — granular writes for scripting
7. **Docs and slides** — same pattern, different converters

Step 1 is the foundation. Step 2-3 give immediate value (users can export their spreadsheets).
Step 4-5 enable import + Google migration. Step 6 enables scripting. Steps 1-6 share the same
infrastructure — each step builds on the previous.

## What Already Exists

| Component | Location | Status |
|---|---|---|
| `loadYjsState()` | `apps/api/src/lib/collab/yjs-loader.ts` | Ready — loads Y.Doc from SQLite |
| `CollabDocument` | `apps/api/src/lib/collab/collabDocument.ts` | Ready — persistence + WebSocket |
| `jsonToYType()` | `packages/lib/src/core/collab/yjs-utils.ts` | Ready — JSON → Y.Map/Y.Array |
| `FormulaEngine.recalculateAll()` | `packages/fortune-sheet/src/engine/` | Ready — server-side formula eval |
| Doc content reader | `apps/api/src/lib/export/doc/content.ts` | Ready — Y.XmlFragment → ProseMirror JSON |
| Slides content reader | `apps/api/src/lib/export/slides/content.ts` | Ready — Y.Maps → SlideData |
| Export route | `apps/api/src/routes/drive.ts` | Exists — route structure, no sheet converter |
| `applyOp()` format | `packages/fortune-sheet/` | Ready — op format documented in use-sheet.ts |
