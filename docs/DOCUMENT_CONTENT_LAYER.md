# Document Content Layer

A consolidated abstraction for reading and writing the **structured content** of eigen's container types
(`.eigendoc`, `.eigenstickies`, `.eigensheets`, `.eigenslides`, `.eigenchat`). Today this logic is scattered
across export, import, and per-app frontend code, with each type re-solving the same problems
(open the data.db, hydrate state, replay updates, apply ACLs). This doc proposes consolidating it into a
single backend module with consistent addressing, share-aware ACLs, and shared FE/BE write logic where
relevant.

This is independently valuable. It enables better export, search indexing, full import for all types, and
clean migration paths — without any of the security surface of a scripting platform. The future Scripting
Platform proposal sits on top of this layer if/when it ships.

## Goals

- **One canonical reader per container type** — every consumer (export, preview, import, search, future
  scripting) calls the same function for "give me the structured content of this document"
- **Share-aware addressing** — readers/writers take `(user, ownerId, mountId, pathId)` and route through
  `getSharedDrive(ownerId, user)` so cross-user shares work automatically, the same way they do in routes
- **No duplicated Yjs hydration logic** — the existing `loadYjsState()` (`apps/api/src/lib/collab/yjs-loader.ts`)
  is the only path; per-type readers wrap it with type-specific extraction
- **Shared FE/BE write logic for live documents** — when a write needs to land on a Y.Doc that may have
  active editors, both the editor and the backend writer use the *same* op-application module. No
  snapshot-replace clobbering
- **Shared types in `packages/lib`** — the structured content shape is part of the FE/BE type chain, not
  duplicated in each consumer

## Why now (without the scripting platform)

- **Export** has three readers (`loadEigendocContent`, `loadSheetsContent`, `loadSlidesContent`) with
  inconsistent signatures and no equivalents for stickies or chat. Adding a new export format means picking
  one of three patterns to copy
- **Import** exists for docs (`apps/api/src/lib/import/doc/writer.ts`) and sheets in a primitive form
  (`apps/api/src/lib/import/sheets/writer.ts` does a snapshot-replace that clobbers concurrent edits). Slides,
  stickies, and chat have no import path
- **Search indexing** is not implemented. When it lands, it'll need exactly these readers — building it ad-hoc
  per type is a large repeat of the same work
- **Sheets backend writes are unsafe.** The current `writeSheetsToDoc()` does
  `doc.getMap('state').set('snapshot', json)` and clears the ops Y.Array — wiping any in-flight client edits.
  This will bite the moment any feature touches a live sheet from the backend
- **Zero security surface.** Unlike scripting, this refactor does not introduce a new code-execution boundary.
  It can ship behind no flag, with no auth model changes

## Scope

Five container types, all stored as drive items shaped `<container>/data.db` plus optional `<container>/media/`:

| Type | MIME | Storage backing | Existing reader | Existing writer |
|---|---|---|---|---|
| Docs (`.eigendoc`) | `application/eigendoc` | Yjs (`Y.XmlFragment('default')`) | `loadEigendocContent` (`apps/api/src/lib/export/doc/content.ts`) | `writeDocToYjs` (`apps/api/src/lib/import/doc/writer.ts`) |
| Stickies (`.eigenstickies`) | `application/eigenstickies` | Yjs (`Y.Map('columns')`, `Y.Map('tasks')`, `Y.Array('columnOrder')`) | none | none |
| Sheets (`.eigensheets`) | `application/eigensheets` | Yjs (`Y.Map('state').snapshot` + `Y.Array('ops')`) | `loadSheetsContent` (`apps/api/src/lib/export/sheets/content.ts`) | `writeSheetsToDoc` (`apps/api/src/lib/import/sheets/writer.ts`) — **unsafe, needs replacing** |
| Slides (`.eigenslides`) | `application/eigenslides` | Yjs (`Y.Map('slides')`, `Y.Map('objects')`, `Y.Array('slideOrder')`) | `loadSlidesContent` (`apps/api/src/lib/export/slides/content.ts`) | none |
| Chat (`.eigenchat`) | `application/eigenchat` | **SQLite rows** (`apps/api/src/lib/chat/schema.ts`), REST + SSE — no Yjs | none | none (chat is append-only via `ChatRoom.postMessage`) |

The first four share the Yjs hydration path (`loadYjsState()`); chat is fundamentally different and gets its
own reader/writer pair sitting on top of the existing `ChatRoom` class.

## Architecture

```
                        ┌──────────────────────────────────────────────┐
                        │  Consumers                                   │
                        │  (export, preview, import, search, future    │
                        │   scripting SDK, future cron triggers, …)    │
                        └────────────────────┬─────────────────────────┘
                                             │  read{Doc,Stickies,Sheet,Slides,Chat}Content(user, …)
                                             │  write{…}Content / setCellValue / postMessage / …
                                             ▼
            ┌──────────────────────────────────────────────────────────────────┐
            │  apps/api/src/lib/document/                                      │
            │                                                                  │
            │  doc-reader.ts        sheets-reader.ts    slides-reader.ts       │
            │  doc-writer.ts        sheets-writer.ts    slides-writer.ts       │
            │  stickies-reader.ts   chat-reader.ts                             │
            │  stickies-writer.ts   chat-writer.ts                             │
            │  a1-notation.ts       (lexer)                                    │
            │                                                                  │
            │  All callers: (user, ownerId, mountId, pathId, …) →              │
            │     getSharedDrive(ownerId, user)  →  ACL ✓  →  data.db          │
            └─────────┬───────────────────────────────────┬────────────────────┘
                      │                                   │
       ┌──────────────▼───────────────┐    ┌──────────────▼──────────────┐
       │  Yjs hydration (existing)    │    │  Chat SQLite (existing)     │
       │  loadYjsState() in           │    │  ChatRoom in                │
       │  apps/api/src/lib/collab/    │    │  apps/api/src/lib/chat/     │
       │  yjs-loader.ts               │    │  chat.ts                    │
       └──────────────┬───────────────┘    └─────────────────────────────┘
                      │
       ┌──────────────▼─────────────────────────────────────────┐
       │  packages/lib/src/sheets/yjs-ops.ts                    │
       │     applyOpsToSheets, pushOpsToYDoc, buildSetCellOp …  │
       │     ← imported by both apps/sheets (FE) and            │
       │       apps/api/src/lib/document/sheets-writer.ts (BE)  │
       └────────────────────────────────────────────────────────┘
```

**Two key invariants:**

1. **One read path per type.** Every consumer that wants "the structured content of this stickies board" calls
   `readStickiesContent(user, ownerId, mountId, pathId)`. There are no alternative routes
2. **Live and headless writes go through the same ops module.** When the Yjs structure has a non-trivial op
   format (sheets), the FE editor and BE writer both import the same pure functions. Snapshot-replace is
   never used for live documents

## Shared Types

```typescript
// packages/lib/src/types/document.ts

import type { JSONContent } from '@tiptap/core';
import type { Sheet } from '@workspace/lib/sheets/types';
import type { DeckData } from '@workspace/lib/slides/types';
import type { ChatMessage } from '@workspace/lib/types/chat';

// --- Docs ---

type DocContent = {
    type: 'doc';
    json: JSONContent;                  // ProseMirror JSON
    text: string;                       // Plain text extraction
    media: Map<string, MediaRef>;
};

// --- Stickies ---

type StickiesContent = {
    type: 'stickies';
    columns: ColumnData[];              // ordered (resolves columnOrder + columns map)
    tasks: TaskData[];                  // sparse, all tasks in board
};

type ColumnData = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
};

type TaskData = {
    id: string;
    columnId: string;                   // resolved from columns[].taskIds membership
    title: string;
    description: string;
    color?: string;
    creator: string;
    createdAt: number;
    chatName?: string;                  // pointer to embedded .eigenchat for card comments
};

// --- Sheets ---

type SheetContent = {
    type: 'sheets';
    sheets: SheetData[];
};

type SheetData = {
    id: string;
    name: string;
    cells: CellData[];                  // sparse — only non-empty cells
    config?: SheetConfig;
};

type CellData = {
    row: number;
    col: number;
    value: unknown;                     // Computed (fortune-sheet `v`)
    formula?: string;                   // (fortune-sheet `f`)
    display?: string;                   // (fortune-sheet `m`)
    type?: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

// --- Slides ---

type SlidesContent = {
    type: 'slides';
    deck: DeckData;                     // already in packages/lib/src/slides/types.ts
    media: Map<string, MediaRef>;
};

// --- Chat ---

type ChatContent = {
    type: 'chat';
    messages: ChatMessage[];            // ordered, oldest first
    members: RoomMember[];
};

// --- Union ---

type ContainerContent =
    | DocContent | StickiesContent | SheetContent | SlidesContent | ChatContent;

type MediaRef = {
    pathId: string;
    name: string;
    mimeType: string;
    size: number;
};
```

The first four reuse types that already live in `packages/lib/src/{sheets,slides}/types.ts` and
`@tiptap/core`. `ChatMessage` and `RoomMember` already exist in `packages/lib/src/types/chat.ts`. The new
work is `DocContent`, `StickiesContent`, `ColumnData`, `TaskData`, `CellData` (and the `MediaRef` shape that
docs and slides already use ad-hoc).

## Per-Type Modules

All readers and writers live under `apps/api/src/lib/document/` and take `(user, ownerId, mountId, pathId, …)`.
ACL is enforced by routing through `getSharedDrive(ownerId, user)` (`apps/api/src/lib/drive/get-drive.ts:16`)
— the same helper drive and editor routes use today.

### Docs (`.eigendoc`)

```typescript
// apps/api/src/lib/document/doc-reader.ts
async function readDocContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<DocContent>;

// apps/api/src/lib/document/doc-writer.ts (existing logic, add user param)
async function writeDocContent(
    user: User, ownerId: string, mountId: string, pathId: string, content: DocContent,
): Promise<void>;
```

**Reader implementation** (refactor of the existing `loadEigendocContent`):

1. `getSharedDrive(ownerId, user)` → drive instance
2. `drive.getMount(mountId)` → `mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id)`
3. `loadYjsState()` to hydrate Y.Doc
4. `ydoc.getXmlFragment('default')` → `yXmlFragmentToProsemirrorJSON()`
5. Plain text extraction from PM JSON (existing helper)
6. Media map from `mount.getChildByName(pathId, 'media')`

**Writer implementation** (lifted from existing `writeDocToYjs` plus user param):

1. `getSharedDrive` for ACL
2. Get the Y.Doc through `CollabDocument.getOrLoad(drive, mountId, pathId)` — same instance live editors use
3. `prosemirrorJSONToYDoc(content.json)` → encode update → apply via `Y.applyUpdate(doc, update)`
4. CollabDocument's existing `update` listener broadcasts to connected WebSocket clients automatically

### Stickies (`.eigenstickies`)

```typescript
async function readStickiesContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<StickiesContent>;

async function writeStickiesContent(
    user: User, ownerId: string, mountId: string, pathId: string, content: StickiesContent,
): Promise<void>;
```

**Reader implementation:**

1. `getSharedDrive` → mount → `loadYjsState()`
2. `ydoc.getMap('columns')`, `ydoc.getMap('tasks')`, `ydoc.getArray('columnOrder')` (matching the FE's
   structure in `apps/stickies/src/components/stickies/hooks/use-board.ts:51,60,61`)
3. Resolve column order by walking `columnOrder` Y.Array, looking up each column in the columns Y.Map
4. Each column has its own internal Y.Array of `taskIds`; resolve those against the tasks Y.Map
5. Return `{ columns: ColumnData[], tasks: TaskData[] }`

**Writer implementation** (live-doc-safe via direct Yjs ops):

1. `getSharedDrive` for ACL
2. Get Y.Doc through `CollabDocument.getOrLoad`
3. `doc.transact(() => { ... })` performing `Y.Map.set` / `Y.Array.push` / `Y.Array.delete` operations to
   reach the desired state. Yjs handles concurrent merges via CRDT
4. No snapshot-replace; live editors observe each map/array change directly

Stickies' direct-CRDT structure is the cleanest of the five. No shared ops module is needed — fortune-sheet's
custom op format is what *necessitates* the shared module for sheets. Stickies just uses Y.Map/Y.Array
operations and Yjs's built-in conflict resolution.

### Sheets (`.eigensheets`)

```typescript
async function readSheetContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<SheetContent>;

async function readSheetCellValue(
    user: User, ownerId: string, mountId: string, pathId: string,
    cell: string, render?: 'value' | 'formula' | 'formatted',
): Promise<unknown>;

async function readSheetRange(
    user: User, ownerId: string, mountId: string, pathId: string,
    cell: string, render?: 'value' | 'formula' | 'formatted',
): Promise<unknown[][]>;

async function writeSheetContent(
    user: User, ownerId: string, mountId: string, pathId: string, content: SheetContent,
): Promise<void>;

// Granular ops — live-safe, used by SDK writes (when scripting ships) and by import flows
async function setCellValue(
    user: User, ownerId: string, mountId: string, pathId: string,
    sheetIndex: number, row: number, col: number, value: unknown,
): Promise<void>;

async function setCellRange(
    user: User, ownerId: string, mountId: string, pathId: string,
    sheetIndex: number, row: number, col: number, values: unknown[][],
): Promise<void>;
```

**Reader implementation:**

1. `getSharedDrive` → mount → `loadYjsState()`
2. `readSheetsFromYDoc(ydoc)` from the shared ops module (see below)
3. Map fortune-sheet `Sheet[]` → `SheetContent.sheets[].cells[]` (sparse; `cell.v → value`,
   `cell.f → formula`, `cell.m → display`, `cell.ct.t → type`)
4. Optionally recalculate formulas via the headless `FormulaEngine`
   (`packages/fortune-sheet/src/engine/formula-engine.ts`) — see [SHEETS.md](SHEETS.md) for the wiring task

**Writer implementation:** uses the shared Yjs ops module described in the next section. Critically, this
replaces the existing `writeSheetsToDoc()` snapshot-replace pattern — which silently wipes concurrent
client edits — with op pushes that merge cleanly via CRDT.

### Slides (`.eigenslides`)

```typescript
async function readSlidesContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<SlidesContent>;

async function writeSlidesContent(
    user: User, ownerId: string, mountId: string, pathId: string, content: SlidesContent,
): Promise<void>;
```

**Reader** (refactor of existing `loadSlidesContent`):

1. `getSharedDrive` → mount → `loadYjsState()`
2. `ydoc.getMap('slides')`, `ydoc.getMap('objects')`, `ydoc.getArray('slideOrder')`
3. `yMapToSlideObject()` (existing helper) for typed `SlideObject[]`
4. Build media map

**Writer** (new):

1. `getSharedDrive` for ACL
2. `CollabDocument.getOrLoad`
3. `doc.transact(() => { ... })` with Y.Map.set / Y.Array operations on slides/objects/slideOrder

Slides has the same direct-CRDT story as stickies — no custom op format, just Yjs maps.

### Chat (`.eigenchat`)

```typescript
async function readChatContent(
    user: User, ownerId: string, mountId: string, pathId: string,
    options?: { limit?: number; before?: number },     // pagination
): Promise<ChatContent>;

async function postChatMessage(
    user: User, ownerId: string, mountId: string, pathId: string,
    message: { type: ChatMessageType; content: string; attachments?: ChatAttachment[]; replyTo?: string },
): Promise<ChatMessage>;
```

Chat is the odd one out: SQLite rows, not Yjs. The reader and writer become thin wrappers around the
existing `ChatRoom` class (`apps/api/src/lib/chat/chat.ts:21+`):

```typescript
async function readChatContent(user, ownerId, mountId, pathId, options) {
    const drive = await getSharedDrive(ownerId, user);
    const room = await drive.getChatRoom(mountId, pathId);
    return {
        type: 'chat',
        messages: await room.listMessages(options),
        members: await room.listMembers(),
    };
}

async function postChatMessage(user, ownerId, mountId, pathId, message) {
    const drive = await getSharedDrive(ownerId, user);
    const room = await drive.getChatRoom(mountId, pathId);
    return room.postMessage({ ...message, authorId: user.id, authorEmail: user.email });
}
```

`ChatRoom` already handles ACL on top of its raw SQLite operations (it's tied to a Home and obeys the
Home's owner rules). `getSharedDrive` ensures the user can reach the chat container. Posting via
`postChatMessage` reuses the room's `postMessage` which does the same SSE broadcast and notification logic
that the existing chat routes use.

For chat, the "Document Content Layer" benefit is uniformity of addressing — `(user, ownerId, mountId, pathId)`
— and one obvious place to add chat to search-indexing later. There is no Yjs ops module to share, because
there is no Yjs.

## The Sheets Yjs Ops Module

The single most-load-bearing piece of new code. Lives in `packages/lib` so the FE editor and the BE
writer both import it.

### Why a shared module

Fortune-sheet's Y.Doc has two structures (see
`apps/sheets/src/components/sheets/hooks/use-sheet.ts`):

- `Y.Map('state').snapshot` — JSON-serialized full `Sheet[]` of the last-flushed state
- `Y.Array('ops')` — array of `Op[]` batches representing edits since the last snapshot

Every connected editor:
- Pushes its own ops onto the array via `Y.Array.push([ops])` (`use-sheet.ts:172`)
- Observes the array and replays remote ops via `WorkbookInstance.applyOp(ops)` (`use-sheet.ts:84`)
- On `beforeunload`, flushes a fresh snapshot and clears the ops array (`use-sheet.ts:36-54`)

The current backend writer (`apps/api/src/lib/import/sheets/writer.ts`) does
`doc.getMap('state').set('snapshot', json)` and clears the ops array. If a live client has unflushed ops
when this runs, those ops are wiped. Backend writes from import (or future SDK writes) silently lose user
edits.

The fix: backend writes use the **same op-push mechanism** clients use. Live editors observe the op via the
same Y.Array path, fortune-sheet replays it like any other user's edit, and the snapshot is left alone
(consolidation continues to happen on `beforeunload` from a leaving client).

### Module shape

```typescript
// packages/lib/src/sheets/yjs-ops.ts

import * as Y from 'yjs';
import type { Op, Sheet } from '@workspace/fortune-sheet';

// ---- Pure state functions (used by both FE and BE) ----

// Apply an op batch to a snapshot of Sheet[]. Extracted from the existing
// WorkbookInstance.applyOp logic in packages/fortune-sheet (currently embedded in
// the React component at packages/fortune-sheet/src/components/Workbook/api.ts:42).
// Pure: no React, no DOM, no side effects.
export function applyOpsToSheets(sheets: Sheet[], ops: Op[]): Sheet[];

// Replay snapshot + pending ops into a current state.
export function readSheetsFromYDoc(doc: Y.Doc): Sheet[] {
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    let sheets: Sheet[] = snapshot ? JSON.parse(snapshot) : [DEFAULT_SHEET];
    for (const opBatch of doc.getArray<Op[]>('ops').toArray()) {
        sheets = applyOpsToSheets(sheets, opBatch);
    }
    return sheets;
}

// ---- Y.Doc mutation (used by both FE and BE) ----

// The single op-push primitive. The FE editor calls this; the BE writer calls this.
// Live observers see the same delta via Y.Array.observe → WorkbookInstance.applyOp.
export function pushOpsToYDoc(doc: Y.Doc, ops: Op[]): void {
    doc.transact(() => doc.getArray('ops').push([ops]));
}

// ---- High-level op builders (used primarily by BE writer; FE has its own UI-level
//      paths that produce ops, but these are useful for headless tooling and tests) ----

export function buildSetCellValueOp(
    sheetIndex: number, row: number, col: number, value: unknown,
): Op[];

export function buildSetCellRangeOp(
    sheetIndex: number, row: number, col: number, values: unknown[][],
): Op[];

// More builders as needed: buildInsertSheetOp, buildDeleteRowOp, etc.
```

### Refactor: extract `applyOpsToSheets` from the Workbook component

Today, op application lives in `packages/fortune-sheet/src/components/Workbook/api.ts:42`
(`applyOp: (ops: Op[]) => { ... }`) and mutates the React component's state via fortune-sheet's reducer
modules. The refactor:

1. Extract the pure state-transformation logic into `packages/fortune-sheet/src/state/apply-ops.ts` as a
   `(sheets: Sheet[], ops: Op[]) => Sheet[]` function with no React/DOM dependencies
2. The Workbook component's `applyOp` becomes a thin wrapper that calls the pure function and updates
   component state
3. `packages/lib/src/sheets/yjs-ops.ts` re-exports it as `applyOpsToSheets` for callers outside fortune-sheet
4. Cover the pure function with unit tests — fortune-sheet ops are non-trivial and currently only tested
   indirectly through the React component

This refactor is independently useful (testability of ops, reusability) and a prerequisite for any
backend-side sheet write.

### What this enables now (without scripting)

- **Safe XLSX import**: replace the snapshot-replace in `apps/api/src/lib/import/sheets/writer.ts` with a
  series of op pushes. Importing a 10MB XLSX into a sheet that someone is currently editing no longer wipes
  their edits
- **Server-side recalc** can write recomputed values back as ops (per [SHEETS.md](SHEETS.md))
- **Future cron / batch tools** can mutate sheets safely
- **Future SDK writes** drop in trivially when scripting ships

## Migration Plan

### Step 1 — Define shared types (`packages/lib/src/types/document.ts`)

Add `DocContent`, `StickiesContent`, `SheetContent`, `SheetData`, `CellData`, `SlidesContent`, `ChatContent`,
`MediaRef`, `ContainerContent` union. Reuse existing types from `packages/lib/src/{sheets,slides}/types.ts`
and `packages/lib/src/types/chat.ts`.

### Step 2 — Stand up `apps/api/src/lib/document/`

For each of the five types, add a reader (and writer for docs/sheets/slides where logic exists today). All
take `(user, ownerId, mountId, pathId, …)` and route through `getSharedDrive`.

For docs and slides this is mostly a refactor of `loadEigendocContent` and `loadSlidesContent` with a `user`
parameter and updated ACL path. For sheets it's a refactor plus the headless FormulaEngine wiring
([SHEETS.md](SHEETS.md)). Stickies and chat are net-new readers.

### Step 3 — Refactor existing callers in export

The export pipeline at `apps/api/src/lib/export/{doc,slides,sheets}/` already consumes per-type content
loaders. Replace each with a thin wrapper around the new readers. Existing export tests should pass unchanged.

### Step 4 — Build the sheets Yjs ops module

`packages/lib/src/sheets/yjs-ops.ts` plus the `applyOpsToSheets` extraction from
`packages/fortune-sheet/src/components/Workbook/api.ts:42` into `packages/fortune-sheet/src/state/apply-ops.ts`.
Cover the pure function with unit tests.

### Step 5 — Replace the unsafe sheets writer

`apps/api/src/lib/import/sheets/writer.ts` switches from snapshot-replace to op pushes through the new module.
Existing import tests should pass; add an integration test that proves a concurrent live edit survives an
import.

### Step 6 — Stickies and slides writers

Add `writeStickiesContent` and `writeSlidesContent` going through `CollabDocument.getOrLoad` + direct Y.Map /
Y.Array transactions. No shared ops module needed for either.

### Step 7 — Wire chat reader/writer

Thin wrappers around `ChatRoom`. The reader is mostly a useful adapter for future search-indexing; the writer
mostly mirrors what chat routes already expose (`postMessage`).

### Step 8 (optional, nice-to-have) — Search indexing prototype

Once readers exist for all five, a one-evening search-indexing prototype becomes possible: walk drive items,
call the right reader by mime type, push extracted text into a search index. Not in this proposal's
required scope, but worth flagging that this layer enables it.

## Phasing

### Phase 1 — Readers + safe sheets writes

Steps 1–5 above. This is the minimum that:

- Consolidates export
- Removes the unsafe snapshot-replace in sheets import
- Lays the foundation for everything else

### Phase 2 — Full writers + chat

Steps 6–7. Stickies/slides writers + chat reader/writer. Enables:

- Full import for slides (PPTX) and stickies (e.g. Trello CSV)
- Chat search indexing
- Any future feature that wants to programmatically post chat messages from the backend (e.g. system
  notifications into a chat room)

### Phase 3 — Search indexing

Step 8. Builds on the now-uniform reader API. Out of scope for the initial layer, but the layer is the
prerequisite.

## Out of Scope

- **Scripting platform.** The SCRIPTING_PLATFORM proposal sits on top of this layer; this doc deliberately
  does not depend on that landing
- **Custom mime types.** The five container types are the universe today. New types add new readers/writers;
  the pattern stays the same
- **Format conversion** (DOCX ↔ DocContent, etc.). Format-specific serializers live next to format-specific
  importers/exporters; this layer provides the canonical content shape they convert to and from
- **Encryption-at-rest** for content. Storage backends already handle this where applicable (S3-backed
  mounts); the content layer is format-aware, not encryption-aware

## Open Questions

- **CollabDocument lifecycle for headless writes.** Today `CollabDocument` is created on first WebSocket
  connection. A backend writer that needs to mutate a document with no live editors needs `CollabDocument`
  to be obtainable headlessly and to persist updates back to `data.db` — a small extension to the current
  init path. Worth confirming during Step 1 spike before committing to writer signatures
- **Sheets formula recalc.** Listed as out-of-scope here but tracked in [SHEETS.md](SHEETS.md). When it
  lands, `readSheetContent` gains accurate formula values automatically — no API change needed
- **Chat container cold-load cost.** A 10k-message chat read for search indexing would pull all rows.
  Pagination via `options.limit / options.before` covers the SDK use case; the search-indexing case may
  want a streaming variant (`AsyncIterable<ChatMessage>`). Decide when search indexing actually starts
