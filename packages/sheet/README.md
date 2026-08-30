# @workspace/sheet

Spreadsheet engine + React UI for [Eigen](../../README.md). Powers
`apps/sheets/`.

## Origin

This package is a heavily modified, type-tightened, modernised fork of
[**fortune-sheet**](https://github.com/ruilisi/fortune-sheet) — a
TypeScript spreadsheet library by Suzhou Ruilisi Technology Co., Ltd —
which itself originated as a TypeScript/React rewrite of
[**Luckysheet**](https://github.com/dream-num/Luckysheet) by Mengshukeji
(dream-num). Luckysheet was archived in October 2025 in favour of its
successor [Univer](https://github.com/dream-num/univer); fortune-sheet
remains actively maintained at the time of writing.

The fork was vendored into this monorepo on 2026-03-10 (commit
`84a57a06`), at which point the external `@fortune-sheet/core` dependency
was removed and the code became internal. The package is now treated as
**owned code** — remaining work is tracked in
[`docs/SHEETS-TODO.md`](../../docs/SHEETS-TODO.md).

## What changed since the fork

- Pure formula evaluator extracted under `src/engine/` with **zero
  imports from `state/`**. Importable server-side via the
  `@workspace/sheet/engine` subpath export — used by xlsx/PDF/HTML export
  and the document-load replay layer in `apps/api`.
- `Cell`, `Sheet`, `Op`, `CellMatrix`, `Range`, `SingleRange`,
  `ConditionalFormatRule`, `MergeCell`, `CellBorderSides`,
  `DataVerificationRule`, `CalcChainEntry`, `AncestorFormulaCell` etc.
  canonicalised into `@workspace/lib/sheets`; the sheet package
  re-exports the canonicals to keep the FE↔BE type chain honest.
- Many `any`-typed APIs tightened to discriminated unions (conditional-format
  rules, freeze-pane data, sheet authority, range or whole-axis selections, …).
- All `/** */` JSDoc/doc-comment blocks removed; comments only where the
  *why* is non-obvious.
- lodash → [es-toolkit](https://github.com/toss/es-toolkit) (zero lodash
  dependency).
- biome enforced across the whole package (zero errors / zero warnings).
- shadcn dialogs, dropdowns and popovers adopted for chrome (toolbar,
  context menus, sheet-tab right-click, sort/split-column dialogs,
  conditional-format rule manager, formula autocomplete, …).
- Multi-language (i18n) layer collapsed to English-only.
- React 19 / TanStack patterns; no `"use client"` directives, no
  Next.js-isms.
- `@workspace/sheet/engine` server-side replay path: BE can re-apply
  per-cell ops on snapshot read so unflushed edits survive a reload and
  are visible in xlsx/PDF/HTML exports.

In-progress work (see SHEETS-TODO.md for the canonical list):

- One CSS file still un-Tailwindised (`SheetOverlay/index.css`).
- Grammar parser (`engine/parser/grammar-parser/grammar-parser.ts`)
  regeneration from upstream jison.

## Architecture

| Subpath           | Role                                                                                                                                              |
|-------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `src/engine/`     | DOM-free formula evaluator, parser, dependency graph, ref shifter, conditional-format evaluator. **No imports from `state/`.** Server-importable. |
| `src/state/`      | Workbook context + immer reducers + DOM-coupled orchestration (selection, paste, drag-fill, cut/copy, image, hyperlink). Imports from `engine/`.  |
| `src/components/` | React UI — `Workbook`, `Sheet`, `MenuBar`, `SheetOverlay`, `FxEditor`, `SheetTab`, `ContextMenu`, `DataVerification`, `LinkEditCard`, `ImgBoxs`.  |
| `src/hooks/`      | Shared React hooks (`useFormulaAutocomplete`, …).                                                                                                 |
| `src/index.ts`    | Package entry — re-exports `Workbook` and the public surface.                                                                                     |

For component / canvas / overlay / z-index layering see
[`RENDERING.md`](./RENDERING.md). For broader sheets-domain architecture
(storage, BE replay, Yjs ops, headless engine) see
[`../../docs/SHEETS.md`](../../docs/SHEETS.md).

## License

This package is distributed under the [MIT License](../../LICENSE.txt)
along with the rest of the Eigen monorepo
(© 2026 Reinder Nijhoff).

It contains code originally derived from two upstream MIT-licensed
projects whose copyright notices are reproduced below per the MIT
License.

### fortune-sheet

```
The MIT License (MIT)

Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Luckysheet

```
MIT License

Copyright (c) 2020-present, Mengshukeji

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
