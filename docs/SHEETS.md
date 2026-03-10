# Sheets App

Collaborative spreadsheet editor using [fortune-sheet](https://github.com/ruilisi/fortune-sheet) with real-time Yjs synchronization.

## Architecture

```
apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts   # Yjs integration (op-based sync)
├── editor.tsx           # Workbook + fortune-sheet config
└── toolbar.tsx          # File menu, revision history, share
```

Fortune-sheet provides the spreadsheet engine, built-in toolbar (formatting, formulas, filters, etc.), and formula bar. Our code adds Eigen-specific features: file management, revision history, sharing, and Yjs-based collaboration.

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
- **Snapshot saves** are debounced (2s) and don't affect the Workbook component
- The React `initialData` state is only set once during initial sync

### Version restore

Revision history uses `Y.applyUpdate(doc, state)` to restore a previous Yjs document state. After restore, the snapshot is re-read and applied via `updateSheet()`.

## Fortune-sheet Integration

### Toolbar items

The built-in toolbar is enabled (`showToolbar: true`) with selected items:

`undo`, `redo`, `format-painter`, `clear-format`, `currency-format`, `percentage-format`, `number-decrease`, `number-increase`, `format`, `font`, `font-size`, `bold`, `italic`, `strike-through`, `underline`, `font-color`, `background`, `border`, `merge-cell`, `horizontal-align`, `vertical-align`, `text-wrap`, `freeze`, `conditionFormat`, `filter`, `quick-formula`, `search`

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
