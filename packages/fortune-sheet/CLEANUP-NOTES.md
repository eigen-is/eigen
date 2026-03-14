# Fortune-Sheet Cleanup Notes

Issues found during component cleanup that need future work.

## Directory Rename

- `LinkEidtCard/` → `LinkEditCard/` — typo in directory name. Deferred because it requires updating all import paths.

## Core Directory (Out of Scope)

The `core/` directory (30K+ lines) was not touched during this cleanup. Future work:

- **Lodash modernization**: 962+ lodash calls across 58 files (563 `_.isNil`, 104 `_.cloneDeep`, 61 `_.forEach`, etc.)
- **mouse.ts splitting**: 5,434 lines — handles too many event types (drag, drop, wheel, context menu, image drag, comment drag, freeze drag). Should split by event type.
- **formula.ts splitting**: 3,550 lines — mixes formula calculation, range selection highlighting, and UI hints. Should separate concerns.
- **82 `@ts-ignore` directives** across core — indicate type safety debt.
- **37 `eslint-disable` directives** across core.
- **`ConditionFormat.ts` (1,765 lines) vs `conditionalFormat.ts` (578 lines)** — unclear separation of responsibilities. Audit needed.

## DOM Selector Coupling

The `core/` code has 365 references to `luckysheet-*` class names and IDs, many used as DOM selectors (`getElementById`, `querySelector`, `getElementsByClassName`). Key IDs/classes that MUST be preserved on component elements:

- `fortune-cell-selected-move` (moveCells.ts)
- `luckysheet-modal-dialog-activeImage` (image.ts)
- `luckysheet-formula-text-lpar` (formula.ts)
- `fortune-search-replace` (searchReplace.ts)
- `fortune-freeze-drag-line` (mouse.ts)
- Many `luckysheet-cell-*` selection classes (mouse.ts — 165 references)

When migrating CSS classes to Tailwind, always check if core/ references the class as a DOM selector before removing it.

## Dialog System

- `ImgBoxs` and `NotationBoxes` bypass the dialog system with absolute-positioned divs. This is intentional — they need drag/resize behavior that the dialog system doesn't support.
- `LinkEditCard` also uses absolute-positioned divs for precise cell-relative positioning.
- `DropdownList` uses absolute positioning for cell-attached dropdown.

## Keyboard Handlers

All keyboard shortcuts are manual implementations in `core/events/keyboard.ts` (941 lines). Most are too complex/stateful for `@tanstack/react-hotkeys` (arrow navigation with hidden row/col awareness, formula editing, etc.). Only Ctrl+Z/Y (undo/redo) might be extractable.

## Package Location

This package is only used by `apps/sheets/`. Consider moving it to `apps/sheets/src/fortune-sheet/` to make the dependency explicit.
