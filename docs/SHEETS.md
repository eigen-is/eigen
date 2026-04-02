# Sheets App

> **TLDR**: Collaborative spreadsheet using a fully forked fortune-sheet (`packages/fortune-sheet`, published as
> `@workspace/fortune-sheet`) + Yjs. Op-based sync: each edit produces a small op pushed to Y.Array; remote clients
> apply via `applyOp()`. Stored as `.eigensheets` Drive folders.

## Architecture

```
packages/fortune-sheet/     # Forked React UI + core engine + formula parser (full source control)
apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts          # Yjs integration (op-based sync)
├── hooks/use-active-comments.ts # Scan cell matrix for comment IDs + anchor texts
├── editor.tsx                  # Workbook config + toolbar items + comment panel/dialog
└── toolbar.tsx                 # File menu + share/mode + comment toggle buttons
```

## Yjs Sync

| Key     | Type    | Purpose                                   |
|---------|---------|-------------------------------------------|
| `state` | Y.Map   | `snapshot` — full JSON for initialization |
| `ops`   | Y.Array | Incremental ops for real-time sync        |

**Why op-based**: Full JSON snapshots cause overwrite conflicts. Ops are granular — concurrent edits on different cells
merge cleanly.

**Flow**: Local edit → `onOp` callback → push to Y.Array → Yjs WebSocket → remote `applyOp()` (no React re-render).

**Snapshot**: Saved on `beforeunload` (flushes latest data to `state.snapshot` and clears the ops array). New joiners
load from the snapshot, then replay any pending ops that arrived during initial sync.

## Comments

Comments anchor to cells via `commentChatNames?: string[]` on the `Cell` type. The fortune-sheet built-in
comment system (ps field, NotationBoxes, comment module) has been fully removed and replaced with the shared
Eigen comment infrastructure.

- **Canvas indicator**: red triangle (top-right) drawn when `cell.commentChatNames?.length > 0`
- **Context menu**: "Add comment" (no comment) or "View comment" / "Delete comment" (has comment), wired via
  `hooks.onAddComment/onViewComment/onDeleteComment` from settings
- **Comment panel**: `CommentPanel` sidebar toggled via toolbar button
- **Thread viewing**: `NoteCardDialog` + `CommentThread` popup

See [COMMENTS.md](COMMENTS.md) for the full shared comment architecture.

## Fortune-Sheet Integration

The entire fortune-sheet library (UI components, core engine, formula parser) is forked into `packages/fortune-sheet/`.
There is no external `@fortune-sheet/core` dependency — everything lives in-repo under full source control.

See [TODO-FORTUNE-SHEETS.md](TODO-FORTUNE-SHEETS.md) for the refactoring audit.
