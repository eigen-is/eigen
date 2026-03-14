# Sheets App

> **TLDR**: Collaborative spreadsheet using forked fortune-sheet UI (`packages/fortune-sheet`) + `@fortune-sheet/core`
> engine + Yjs. Op-based sync: each edit → small op → Y.Array → remote clients apply via `applyOp()`. Stored as
`.eigensheets` Drive folders.

## Architecture

```
packages/fortune-sheet/     # Forked React UI (full source control)
apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts      # Yjs integration (op-based sync)
├── editor.tsx              # Workbook config + toolbar
└── toolbar.tsx             # File menu + revision/share buttons
```

## Yjs Sync

| Key     | Type    | Purpose                                   |
|---------|---------|-------------------------------------------|
| `state` | Y.Map   | `snapshot` — full JSON for initialization |
| `ops`   | Y.Array | Incremental ops for real-time sync        |

**Why op-based**: Full JSON snapshots cause overwrite conflicts. Ops are granular — concurrent edits on different cells
merge cleanly.

**Flow**: Local edit → `onOp` → push to Y.Array → Yjs WebSocket → remote `applyOp()` (no React re-render).

**Snapshot**: Debounced save (every 2s) for new joiners. Flushed on `beforeunload`.

## Fortune-Sheet Integration

See [FORTUNE-SHEETS-TODO.md](FORTUNE-SHEETS-TODO.md) for the refactoring audit.
