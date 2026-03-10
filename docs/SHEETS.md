# Sheets App

Collaborative spreadsheet editor using a forked [fortune-sheet](https://github.com/ruilisi/fortune-sheet) React UI layer (`packages/fortune-sheet`) with `@fortune-sheet/core` as the engine and real-time Yjs synchronization.

## Architecture

```
packages/fortune-sheet/          # Forked React UI layer (full source control)
├── src/components/Toolbar/      # Toolbar with leftItems/rightItems slots
├── src/components/Workbook/     # Main Workbook component + API
├── src/components/FxEditor/     # Formula bar
├── index.d.ts                   # Type declarations for consumers
└── package.json                 # Depends on @fortune-sheet/core

apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts           # Yjs integration (op-based sync)
├── editor.tsx                   # Workbook config + toolbar items
└── toolbar.tsx                  # ToolbarLeftItems (File menu) + ToolbarRightItems (Revision/Share)
```

Fortune-sheet's React UI layer is forked into `packages/fortune-sheet` for full control over toolbar styling and items. The `@fortune-sheet/core` npm package provides the engine (formulas, cell operations, types). Our code adds Eigen-specific features: file management, revision history, sharing, and Yjs collaboration.

## Yjs Data Structure

The Y.Doc contains two structures:

| Key | Type | Purpose |
|-----|------|---------|
| `state` | `Y.Map` | Stores `snapshot` — full JSON of all sheets for initialization |
| `ops` | `Y.Array` | Stores incremental ops for real-time sync |

### Why op-based sync (not full-JSON snapshot)

Storing the entire spreadsheet as one JSON blob causes **overwrite conflicts**: if User A edits cell A1 and User B edits cell B2 simultaneously, the last writer overwrites the other's change.

Op-based sync fixes this:
- Each cell edit produces a small **op** (operation) via fortune-sheet's `onOp` callback
- Ops are pushed to `Y.Array('ops')` — Yjs CRDT ensures all clients receive them
- Remote ops are applied via `workbookRef.applyOp(ops)` — no React re-render needed
- A **debounced snapshot** (every 2s) saves full state to `Y.Map('state')` for new joiners

### Sync flow

```
Local edit → fortune-sheet onOp → push to Y.Array('ops') → Yjs WebSocket → remote clients
                                                                                ↓
                                                              Y.Array observer → applyOp()
```

### What limits re-renders

- **Remote ops** are applied directly via `applyOp()` on the workbook ref — this mutates fortune-sheet's internal state without triggering a React state update
- **Local ops** set an `isLocalOpRef` flag so the Y.Array observer skips them (prevents echo)
- **Snapshot saves** are debounced (1s) and don't affect the Workbook component
- The React `initialData` state is only set once during initial sync
- Pending snapshots are flushed on `beforeunload` and component cleanup to prevent data loss

### Version restore

Revision history creates a temp `Y.Doc`, applies the saved state to it, then copies all data (Y.Map entries, Y.Array items) from the temp doc to the live doc within a single transaction — same approach as the slides app. After restore, the snapshot is re-read and applied via `updateSheet()`.

## Fortune-sheet Integration

### Toolbar items

The built-in toolbar is enabled (`showToolbar: true`) with selected items:

`undo`, `redo`, `format-painter`, `clear-format`, `format`, `font-size`, `bold`, `italic`, `strike-through`, `underline`, `font-color`, `background`, `border`, `merge-cell`, `horizontal-align`, `vertical-align`, `text-wrap`, `freeze`, `conditionFormat`, `filter`, `quick-formula`, `search`

The Toolbar component supports `leftItems` and `rightItems` slots for injecting custom React nodes (File menu on the left, Revision history + Share on the right).

### Formula bar

Enabled via `showFormulaBar: true`. Shows selected cell reference (e.g. "C22") and cell value/formula.

### Key props

| Prop | Value | Purpose |
|------|-------|---------|
| `showToolbar` | `true` | Fortune-sheet toolbar with `toolbarItems` |
| `showFormulaBar` | `true` | Cell reference + value bar |
| `showSheetTabs` | `true` | Sheet tabs at bottom |
| `onOp` | handler | Captures ops for Yjs sync |
| `onChange` | handler | Debounced snapshot save |

## File Type

| Type | MIME Type | Extension |
|------|-----------|-----------|
| Sheet | `application/eigensheets` | `.eigensheets` |

Stored as directories with `data.db` for Yjs document persistence.
