# Fortune-Sheet Menu-Bar Toolbar

Replace fortune-sheet's two-mode toolbar (a 34-icon desktop row + a small mobile menu)
with a single Google-Sheets-style menu bar. Five menus, hard-coded structure, mirrors
Google Sheets' ordering and section separators. Adds the missing UI for text rotation
(engine already supports it) and Color Scales / Data Bars (engine already supports them
— see `docs/PROPOSAL_FORTUNE_SHEET_CF_UI.md`). Removes Screenshot and Location condition
entirely.

The desktop icon row is being removed. Icons that survive (alignment, wrap, rotation,
border presets) move into menu items as visual cues. Color pickers (font color, fill
color) lose their dedicated icon-row slot and become menu items that open popovers.

Supersedes the desktop-icon-row half of `Toolbar/index.tsx`. Keeps the engine, state
modules, and dialog components untouched — only the dispatch surface changes.

## Scope

In:

- One menu bar component replacing both desktop and mobile toolbar variants
- Edit / View / Insert / Format / Data menus matching Google Sheets ordering exactly,
  with separators preserved where the corresponding GS section has at least one
  fortune-supported item
- New `Format > Rotation ▶` submenu (engine `tr` field is already wired)
- Extension of `Format > Conditional formatting ▶` with new Color scales ▶ and
  Data bars ▶ submenus per `docs/PROPOSAL_FORTUNE_SHEET_CF_UI.md`
- New `Edit > Cut` and `Edit > Delete ▶` submenu — wires existing handlers, no engine
  work
- Deletion of `state/modules/screenshot.ts`, `state/modules/locationCondition.ts`,
  `components/LocationCondition/`, related locale entries, and the `screenshot` /
  `locationCondition` toolbar branches
- Deletion of the `toolbarItems` and `customToolbarItems` settings fields
  (`apps/sheets` does not override them; no other consumers exist)

Out:

- New domain features. Anything Google Sheets has that fortune-sheet doesn't already
  implement is omitted (Theme, Smart chips, Pivot table, Drawing, Tick box, Note,
  Slicer, Named ranges, Named functions, Alternating colours, Convert to table, Group,
  Charts, etc.)
- Keyboard shortcuts in menu items. Shortcuts may be added later — the menu items
  render label-only for now
- File menu (no fortune-level file operations; sheet is owned by the Eigen wrapper)
- Mobile-specific layout. The menu bar is responsive enough to work on small screens
  via standard shadcn `DropdownMenu` behavior; no separate breakpoint variant
- Customizable menu structure. The new menu is hard-coded. The legacy `toolbarItems`
  customization knob goes away

## Menu Structure

Item names match Google Sheets exactly except where noted as **Δ-from-GS**. **NEW**
marks UI that did not exist in fortune-sheet before. Submenus are marked with `▶`.
Separators (`─`) match the corresponding GS sections; sections that become empty after
omitting unsupported items collapse without leaving a dangling separator.

### Edit

```
Undo
Redo
─
Cut
Copy
Paste
Format painter        Δ
─
Delete                ▶
─
Find and replace
```

`Delete ▶`:
- Values *(clear cell content — `clear` handler)*
- Row *(`delete-row`)*
- Column *(`delete-column`)*
- Cell *(`delete-cell`)*

GS items dropped: `Paste special ▶` (no fortune paste-only-values/-format variants),
`Move ▶` (no fortune row/column move action).

### View

```
Freeze                ▶
─
Hidden sheets         ▶
```

`Freeze ▶`:
- No frozen rows and columns
- Freeze 1 row
- Freeze 2 rows
- Freeze up to current row
- Freeze 1 column
- Freeze 2 columns
- Freeze up to current column
- Freeze rows and columns up to current cell

`Hidden sheets ▶` lists every sheet with `hide === 1`; clicking one calls
`showSheet(ctx, sheetId)`. Reuses the logic behind the existing
`SheetList/SheetHiddenButton.tsx`.

GS items dropped: `Show ▶` (no toggleable view options), `Group ▶` (no row/col
grouping), `Comments ▶` (no all-comments listing UI), `Zoom ▶` (feature deleted in
commit `24e82652`), `Full screen` (no fortune feature).

### Insert

```
Rows                  ▶
Columns               ▶
Sheet
─
Image
─
Function              ▶
Link
─
Comment
```

`Rows ▶`:
- Insert 1 row above
- Insert 1 row below

`Columns ▶`:
- Insert 1 column left
- Insert 1 column right

These menu items always insert exactly one row / column. Fortune's existing
`insertRowCol` handler accepts a `count` field; the multi-row variant remains in the
cell context menu (which has a count input). The Insert menu items pass `count=1`
unconditionally, matching Google Sheets.

`Function ▶`:
- SUM
- AVERAGE
- COUNT
- MAX
- MIN
- ─
- More functions… *(opens existing `FormulaSearch` dialog)*

`Sheet` calls `insertSheet(ctx)`.
`Image` calls `settings.hooks.onInsertImage()`. Renders disabled if hook is absent.
`Link` opens the existing `LinkEditCard` dialog.

`Comment` is state-aware. When the active cell has no comment it reads "Comment" and
calls `settings.hooks.onAddComment(r, c)`. When the cell has a comment it reads "View
comment" and calls `settings.hooks.onViewComment(r, c)`. Renders disabled if no
active cell or the relevant hook is absent. Mirrors the existing ContextMenu behavior
in `components/ContextMenu/index.tsx` (around line 607).

GS items dropped: `Cells ▶` (no shift-cell insert), Generate a table / Pre-built
tables / Create a canvas / Timeline / Chart / Pivot table / Drawing / Tick box /
Drop-down / Emoji / Smart chips / Note (no fortune support).

### Format

```
Number                ▶
Text                  ▶
Alignment             ▶
Wrapping              ▶
Rotation              ▶   NEW
─
Font size             ▶
Fill color                Δ
Borders               ▶   Δ
Merge cells           ▶
─
Conditional formatting ▶
─
Clear formatting
```

`Number ▶` reuses the existing format dropdown content (Automatic / Number / Percent /
Currency / Date / Time / Scientific / Plain text / etc.). The standalone
`currency-format`, `percentage-format`, `number-decrease`, `number-increase` toolbar
buttons are not duplicated — they were only visible on the desktop icon row, which
is being removed; the same actions remain reachable from `Number ▶ > Currency`,
`Number ▶ > Percent`, `Number ▶ > Increase decimal places`, etc.

`Text ▶`:
- Bold
- Italic
- Underline
- Strikethrough
- ─
- Font ▶ — Δ — submenu with the font family list (`settings.fontList`)
- Font color — Δ — opens shadcn `Popover` with `ColorPicker`

`Alignment ▶`:
- Left
- Center
- Right
- ─
- Top
- Middle
- Bottom

`Wrapping ▶`:
- Overflow
- Wrap
- Clip

`Rotation ▶` — **NEW**:
- None *(`tr=0`)*
- Tilt up *(`tr=1`)*
- Tilt down *(`tr=2`)*
- Stack vertically *(`tr=3`)*
- Rotate up *(`tr=4`)*
- Rotate down *(`tr=5`)*

Locale strings already exist (`rotation.none` / `rotation.angleup` / `rotation.angledown`
/ `rotation.vertical` / `rotation.rotationUp` / `rotation.rotationDown`); icons already
exist in `icon-map.tsx`. Dispatch goes through `updateFormat(ctx, ..., 'tr', mode)` (the
existing handler in `state/modules/toolbar.ts`).

`Font size ▶` lists the existing font sizes (10, 11, 12, … 36). Calls
`handleTextSize(ctx, ..., size)`.

`Fill color` — opens `Popover` with `ColorPicker` and "Reset" entry. Δ from GS, which
keeps fill color on the icon toolbar only.

`Borders ▶` reuses the existing 13 border presets + custom. Δ from GS for the same
reason as Fill color.

`Merge cells ▶`:
- Merge all
- Merge horizontally
- Merge vertically
- Unmerge

`Conditional formatting ▶`:
- Highlight cells ▶ *(existing — Greater than / Less than / Between / Equal to / Text contains / Date is / Duplicate values)*
- Item rules ▶ *(existing — Top 10 / Top 10% / Bottom 10 / Bottom 10% / Above average / Below average)*
- Color scales ▶ — **NEW** — 12 presets per `docs/PROPOSAL_FORTUNE_SHEET_CF_UI.md`
- Data bars ▶ — **NEW** — 6 solid presets per the same proposal *(gradient presets dropped per proposal §"Out of scope" — canvas painter has no stripe support)*
- ─
- Manage rules…
- Delete rules ▶ *(existing)*

`Clear formatting` — calls the existing `clear-format` handler.

GS items dropped: Theme / Smart chips ▶ / Convert to table / Alternating colours.

### Data

```
Sort sheet            ▶
Sort range            ▶
─
Create a filter
─
Data validation
Split text to columns
```

`Sort sheet ▶`:
- Sort sheet by column N, A → Z
- Sort sheet by column N, Z → A

Both call `handleSort(ctx, asc)` over the full sheet range with the active column as
the sort key. `N` is the active column letter, computed at render time.

`Sort range ▶`:
- Sort range, A → Z *(uses `orderAZ` handler)*
- Sort range, Z → A *(uses `orderZA` handler)*
- ─
- Advanced range sorting options *(opens the existing `CustomSort` dialog)*

`Create a filter` is a state-aware item. When no filter is active it reads
"Create a filter" and calls `createFilter(ctx)`. When a filter exists it reads
"Remove filter" and calls `clearFilter(ctx)`.

`Data validation` opens the existing `DataVerification` dialog.

`Split text to columns` opens the existing `SplitColumn` dialog.

GS items dropped: Analyse data / Solve / Create group by view / Create filter view /
Add a slicer / Protect sheets and ranges / Named ranges / Named functions /
Randomise range / Column stats / Data clean-up / Data extraction / Data connectors.

## New code

### `Edit > Cut` — `state/modules/clipboard.ts`

Today, Ctrl+X is handled inline in `state/events/keyboard.ts` (around line 340) by
calling the copy path then setting `ctx.luckysheet_paste_iscut = true`. Extract:

```typescript
export function handleCut(ctx: Context) {
    handleCopy(ctx);
    ctx.luckysheet_paste_iscut = true;
}
```

`keyboard.ts` calls `handleCut(ctx)` instead of inlining the logic. The new
`Edit > Cut` menu item dispatches the same handler.

### `Format > Rotation ▶` — `components/MenuBar/format-menu.tsx`

Six `DropdownMenuItem`s in a `DropdownMenuSub`, each calling
`updateFormat(ctx, ..., 'tr', mode)` for `mode` in `none | angleup | angledown |
vertical | rotation-up | rotation-down`. The existing rotation icons from
`icon-map.tsx` render alongside each label as visual cues. Active mode gets a check
mark (read from the active cell's `tr` value).

### `Format > Conditional formatting ▶ > Color scales / Data bars`

Per `docs/PROPOSAL_FORTUNE_SHEET_CF_UI.md` § Plan. Three files touched:

- `state/modules/conditionFormat.ts` — adds `CF_PRESETS` table and
  `applyColorScalePreset(ctx, presetKey)` / `applyDataBarPreset(ctx, presetKey)`
  producer functions. Replaces the broken `updateItem` (which writes the wrong
  `format` shape for array-format rule types).
- `components/MenuBar/format-menu.tsx` — renders the two new submenus with
  color-chip swatches.
- No engine change. The existing `evaluateConditionalFormat` already handles
  `colorGradation` and `dataBar` rule types correctly.

### `MenuBar/index.tsx` — new file

Single component, rendered from `Workbook/index.tsx` in place of `<Toolbar />`.
Five `DropdownMenu`s for Edit / View / Insert / Format / Data, each triggered by a
left-aligned `<button>` showing the menu name. Items inside use shadcn
`DropdownMenuItem`, `DropdownMenuSub`, `DropdownMenuSubTrigger`,
`DropdownMenuSubContent`, `DropdownMenuSeparator` — same primitives the existing
`ConditionFormat/index.tsx` and the soon-to-be-removed mobile toolbar already use.

The menu trigger row sits where the desktop toolbar used to sit; Tailwind utility
classes only, no new CSS. Height matches the existing toolbar slot so the rest of the
layout doesn't shift.

Click handlers all use the existing `setContext((ctx) => …)` pattern — no new dispatch
machinery. The component is wrapped in `useContext(WorkbookContext)` exactly as the
current `Toolbar/index.tsx` is.

### `MenuBar/<menu>.tsx` — split per menu

Each menu body lives in its own file:

- `components/MenuBar/edit-menu.tsx`
- `components/MenuBar/view-menu.tsx`
- `components/MenuBar/insert-menu.tsx`
- `components/MenuBar/format-menu.tsx`
- `components/MenuBar/data-menu.tsx`

Each file exports a single component returning a `<DropdownMenuContent>` body. The
parent `MenuBar/index.tsx` wires triggers to content. Splitting per menu keeps each
file under ~200 lines and matches the cleanliness goal — `Toolbar/index.tsx` today is
~1400 lines.

Color-picker popovers (`Format > Text > Font color`, `Format > Fill color`) use
shadcn `Popover` nested inside the `DropdownMenu`. The existing `ChangeColor/`
component is the picker body; only the trigger surface changes.

## Code removal

Delete:

- `state/modules/screenshot.ts` (~100 LOC)
- `state/modules/locationCondition.ts` (~250 LOC)
- `components/LocationCondition/` directory
- `screenshot` and `locationCondition` keys from `state/locale/en.ts`
  (and any peer locale files — currently only `en` is populated)
- `Screenshot` / `Location condition` icons from `icon-map.tsx`
- `screenshot` and `locationCondition` toolbar branches in the old
  `Toolbar/index.tsx` (which is going away anyway)
- The `toolbarItems` field from `defaultSettings` and from the `Settings` type in
  `state/settings.ts`
- The `customToolbarItems` field from `defaultSettings` and from `Settings`. The
  `LucideIcon` import becomes unused in `state/settings.ts` and is dropped.
- `Toolbar/index.tsx` — full rewrite into `MenuBar/index.tsx`
- `Toolbar/toolbar-helpers.tsx` — only used by the icon row; dies with it
- Mobile toolbar code path (the `mobileToolbar` branch in `Toolbar/index.tsx`) —
  the new menu bar serves both desktop and mobile

The old `Toolbar/CustomBorder.tsx` (border picker dialog) is reused by the new
`Format > Borders ▶` and stays. Move it under `MenuBar/CustomBorder.tsx` to keep the
border picker next to its only consumer.

`ICON_MAP` in `icon-map.tsx` keeps the entries used as visual cues inside menu items
(alignment / wrap / rotation / border-preset icons). Drops entries used only as
toolbar buttons (top-level toolbar items that aren't visual cues — the icons for
`format-painter`, `clear-format`, `link`, `image`, `freeze`, `screenshot`,
`locationCondition`, `splitColumn`, etc.). The dead-code-eliminator will report
which entries are unused after the rewrite; remove those.

## Files touched

| File                                               | Change                                                                            |
|----------------------------------------------------|-----------------------------------------------------------------------------------|
| `components/MenuBar/index.tsx`                     | New. Top-level menu bar.                                                          |
| `components/MenuBar/edit-menu.tsx`                 | New.                                                                              |
| `components/MenuBar/view-menu.tsx`                 | New.                                                                              |
| `components/MenuBar/insert-menu.tsx`               | New.                                                                              |
| `components/MenuBar/format-menu.tsx`               | New. Includes Rotation ▶ and the CF Color scales / Data bars submenus.            |
| `components/MenuBar/data-menu.tsx`                 | New.                                                                              |
| `components/MenuBar/CustomBorder.tsx`              | Moved from `components/Toolbar/CustomBorder.tsx`.                                 |
| `components/Workbook/index.tsx`                    | Imports `MenuBar` instead of `Toolbar`; drops `mobileToolbar` branch.             |
| `components/Toolbar/`                              | Deleted (entire directory).                                                       |
| `components/LocationCondition/`                    | Deleted.                                                                          |
| `components/icon-map.tsx`                          | Drops icons no longer referenced.                                                 |
| `state/modules/clipboard.ts`                       | Adds `handleCut(ctx)`.                                                            |
| `state/events/keyboard.ts`                         | Calls `handleCut(ctx)` instead of inlining the cut path.                          |
| `state/modules/conditionFormat.ts`                 | Adds `CF_PRESETS`, `applyColorScalePreset`, `applyDataBarPreset`. Removes broken `updateItem`. |
| `state/modules/screenshot.ts`                      | Deleted.                                                                          |
| `state/modules/locationCondition.ts`               | Deleted.                                                                          |
| `state/settings.ts`                                | Drops `toolbarItems`, `customToolbarItems`. Drops `LucideIcon` import.            |
| `state/locale/en.ts`                               | Drops `screenshot` and `locationCondition` keys.                                  |

## Open questions

None remaining. The user has approved:

- Pure menu bar, no icon toolbar, items left-aligned, shortcuts deferred
- Scope (b): existing engine/state features only; no new domain logic
- Strict GS skeleton, fortune-only items in nearest GS slot, with explicit
  deviations called out
- Removing Screenshot and Location condition entirely
- Full rewrite of the toolbar component, with helper functions extracted as needed

## Risk

Low. Engine and state modules are not touched (except deleting two unused ones and
adding `handleCut`). Every menu item dispatches an existing handler. The new menu
component is built from primitives already used elsewhere in the package
(`DropdownMenu` is established in `ConditionFormat/index.tsx` and the current mobile
toolbar). The CF Color scales / Data bars work was already specced and tested at the
engine level; the only failure mode there is preset color values not matching
expectations, which is a one-line fix per preset. The largest behavioral change for
end users is a different *path* to existing features, not different behavior.
