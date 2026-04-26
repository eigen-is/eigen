# Proposal — wire the missing Color Scales / Data Bars UI in fortune-sheet

> **Status:** Drafted 2026-04-26 after the colorGradation engine bug fix
> (commit `1b2b36a0`). The engine supports `colorGradation` / `dataBar`
> rules; the UI never emits them. This proposal lays out exactly what's
> needed to wire the missing dropdown and rule producers.

## Problem

The Conditional Format dropdown in `apps/sheets` only exposes:

- **Highlight cell rules** — greaterThan, lessThan, between, equal,
  textContains, occurrenceDate, duplicateValue
- **Item selection rules** — top10, top10_percent, last10, last10_percent,
  aboveAverage, belowAverage
- **Delete rule** — delSheet / manageRules

There is **no UI** for `colorGradation` or `dataBar` rules. The engine in
`packages/fortune-sheet/src/engine/conditional-format.ts` evaluates them
correctly (incl. the recently fixed colorGradation array-format bug), and
`state/locale/en.ts` defines preset names for both — but no component ever
constructs a rule with `type: 'colorGradation'` or `type: 'dataBar'`.

Effect: the colorGradation bug fix is provably correct via engine + HTML
export tests, but cannot be verified visually in the canvas because there
is no way to create such a rule from the UI.

## What already exists

### Engine (works)

`engine/conditional-format.ts::evaluateConditionalFormat` handles both
types. Key shapes:

```ts
// dataBar rule
{ type: 'dataBar', cellrange: SingleRange[], format: string[] }
// `format[0]` is the bar colour. Negative bars hardcode red.

// colorGradation rule
{ type: 'colorGradation', cellrange: SingleRange[], format: string[] }
// 2-color: format[0] = max stop, format[1] = min stop.
// 3-color: format[0] = max, format[1] = mid (avg), format[2] = min.
```

### Locale presets (defined, unused)

`state/locale/en.ts` (lines ~9973-9999):

- `gradientDataBar_1..6` — gradient data-bar presets
- `solidColorDataBar_1..6` — solid data-bar presets
- `colorGradation_1..12` — 12 color-scale presets (mostly 3-color, last
  6 are 2-color)
- `dataBar`, `colorGradation`, `dataBarColor`, `clearColorSelect` —
  submenu and section labels

The original luckysheet hard-coded the colour values for each preset; we
need to port the same table. Example mappings (verified against canvas
`drawDataBar` defaults — adjust if the source has more authoritative
values):

| Preset                | Format array (RGB) |
| --------------------- | ------------------ |
| `colorGradation_1` (Green-yellow-red, 3-color)     | `['#f8696b', '#ffeb84', '#63be7b']` |
| `colorGradation_2` (Red-yellow-green, 3-color)     | `['#63be7b', '#ffeb84', '#f8696b']` |
| `colorGradation_3` (Green-white-red, 3-color)      | `['#f8696b', '#ffffff', '#63be7b']` |
| `colorGradation_4` (Red-white-green, 3-color)      | `['#63be7b', '#ffffff', '#f8696b']` |
| `colorGradation_5` (Blue-white-red, 3-color)       | `['#f8696b', '#ffffff', '#5a8ac6']` |
| `colorGradation_6` (Red-white-blue, 3-color)       | `['#5a8ac6', '#ffffff', '#f8696b']` |
| `colorGradation_7` (White-red, 2-color)            | `['#f8696b', '#ffffff']`            |
| `colorGradation_8` (Red-white, 2-color)            | `['#ffffff', '#f8696b']`            |
| `colorGradation_9` (Green-white, 2-color)          | `['#ffffff', '#63be7b']`            |
| `colorGradation_10` (White-green, 2-color)         | `['#63be7b', '#ffffff']`            |
| `colorGradation_11` (Green-yellow, 2-color)        | `['#ffeb84', '#63be7b']`            |
| `colorGradation_12` (Yellow-green, 2-color)        | `['#63be7b', '#ffeb84']`            |
| `solidColorDataBar_1` (Blue)                        | `['#638ec6']`                       |
| `solidColorDataBar_2` (Green)                       | `['#63be7b']`                       |
| `solidColorDataBar_3` (Red)                         | `['#f8696b']`                       |
| `solidColorDataBar_4` (Orange)                      | `['#ffb628']`                       |
| `solidColorDataBar_5` (Light blue)                  | `['#a3c8ff']`                       |
| `solidColorDataBar_6` (Purple)                      | `['#a085ff']`                       |
| `gradientDataBar_*`                                  | Two-stop arrays — engine treats them the same as solid for now (canvas painter doesn't support stripes). Decide whether to fall back to the first stop or wire stripes later. |

> **Action item:** verify the exact luckysheet colour table by either
> grepping the upstream repo or pulling from a known-good reference.
> The values above are best-guess defaults, not authoritative.

### Producer (broken for these types)

`state/modules/conditionFormat.ts::updateItem(ctx, type)` (line ~252)
currently builds rules with `format: { textColor, cellColor }` regardless
of `type`. That shape is wrong for `colorGradation` and `dataBar` (they
need `format: string[]`). The function is dead code today — only
`updateItem(ctx, 'delSheet')` is wired from the UI.

## Plan

### 1. Locale preset table

Add a mapping from preset key → format array. Two reasonable spots:

- **Inline at the producer** (simplest): a `const CF_PRESETS: Record<string, string[]>` in `state/modules/conditionFormat.ts` next to the
  new producer function.
- **Shared with locale** (slightly cleaner): in `state/locale/en.ts`,
  add `colorGradationPresets: Record<string, string[]>` alongside the
  existing label strings. Importer can read both.

I'd start with inline — fortune-sheet is full-fork code, no
internationalisation yet on these labels (they're English in `en.ts` and
the locale switcher always returns `en`). If/when we add another locale,
revisit.

### 2. Replace `updateItem` with type-aware helpers

Rename / split:

```ts
// state/modules/conditionFormat.ts
export function clearSheetRules(ctx: Context) {
    if (!checkProtectionFormatCells(ctx)) return;
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    ctx.luckysheetfile[index].luckysheet_conditionformat_save = [];
}

export function applyColorScalePreset(ctx: Context, presetKey: string) {
    if (!checkProtectionFormatCells(ctx)) return;
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const rule = {
        type: 'colorGradation',
        cellrange: ctx.luckysheet_select_save ?? [],
        format,
    };
    const ruleArr =
        ctx.luckysheetfile[index].luckysheet_conditionformat_save ?? [];
    ruleArr.push(rule);
    ctx.luckysheetfile[index].luckysheet_conditionformat_save = ruleArr;
}

export function applyDataBarPreset(ctx: Context, presetKey: string) {
    // same as above with type: 'dataBar'
}
```

`updateItem(ctx, 'delSheet')` → call `clearSheetRules`. Drop the rest of
`updateItem` (it was always broken).

### 3. Add submenus to `ConditionalFormat`

`packages/fortune-sheet/src/components/ConditionFormat/index.tsx`:

Add two new branches:

```tsx
if (name === 'colorGradation') {
    return (
        <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>{conditionformat[name]}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {COLOR_GRADATION_PRESETS.map((preset) => (
                    <DropdownMenuItem key={preset} onClick={() => {
                        setContext((ctx) => applyColorScalePreset(ctx, preset));
                    }}>
                        <ColorScaleSwatch presetKey={preset} />
                        <span>{conditionformat[preset as keyof typeof conditionformat]}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

if (name === 'dataBar') {
    // analogous for solidColorDataBar_* + gradientDataBar_*
}
```

`COLOR_GRADATION_PRESETS = ['colorGradation_1', ..., 'colorGradation_12']`
in module scope.

`ColorScaleSwatch` is a tiny component that renders a flex row of color
chips per the format array, e.g.:

```tsx
function ColorScaleSwatch({ presetKey }: { presetKey: string }) {
    const colors = CF_PRESETS[presetKey] ?? [];
    return (
        <div className="flex w-12 h-4 mr-2 rounded-sm overflow-hidden">
            {colors.map((c, i) => (
                <div key={i} className="flex-1" style={{ backgroundColor: c }} />
            ))}
        </div>
    );
}
```

### 4. Wire into the toolbar

`packages/fortune-sheet/src/components/Toolbar/index.tsx:515`:

```diff
- const items = ['highlightCellRules', 'itemSelectionRules', '-', 'deleteRule'];
+ const items = [
+     'highlightCellRules',
+     'itemSelectionRules',
+     'colorGradation',
+     'dataBar',
+     '-',
+     'deleteRule',
+ ];
```

### 5. Tests

- **Engine tests**: already cover `colorGradation` (3-color + 2-color) and
  `dataBar`, plus the regression for the if-arm bug. No new engine tests
  needed.
- **Component tests**: skip — the UI is shadcn DropdownMenu + click handlers,
  unit-testing it is low-value.
- **Manual smoke**: run `bun serve:sheets`, select a numeric column, open
  Conditional Format → Color Scales → "Green-yellow-red", confirm canvas
  shows the gradient. Repeat with Data Bars. Then layer a `greaterThan` rule
  on top of a colorGradation to confirm the original bug stays fixed
  end-to-end (cells should keep the gradient colour, not blank out).

## Files to touch

| File                                                                         | Change |
| ---------------------------------------------------------------------------- | ------ |
| `packages/fortune-sheet/src/state/modules/conditionFormat.ts`                | Add `CF_PRESETS` table; replace `updateItem` with `clearSheetRules` + `applyColorScalePreset` + `applyDataBarPreset`; export from the state barrel. |
| `packages/fortune-sheet/src/components/ConditionFormat/index.tsx`            | Add `colorGradation` and `dataBar` submenu branches; new `ColorScaleSwatch` / `DataBarSwatch` components inline (small enough not to extract). |
| `packages/fortune-sheet/src/components/Toolbar/index.tsx`                    | Add `'colorGradation'` and `'dataBar'` to the `items` array at line 515. |
| `packages/fortune-sheet/src/state/index.ts` (if not already exporting)       | Re-export the new producer functions if they need to be reachable from app code (probably already covered by `export * from './modules'`). |

## Constraints

- Match existing patterns: the new submenus mirror `highlightCellRules` /
  `itemSelectionRules` exactly. Same `DropdownMenuSub` shape, same
  `setContext((ctx) => ...)` invocation.
- No new shadcn components — the submenu, items, and swatches are
  composed from existing primitives.
- Follow CODE-STANDARDS.md: comments only for WHY (the preset table
  warrants none — the names speak for themselves), no over-engineering
  (one preset table, one swatch component).
- Don't break the engine API: `evaluateConditionalFormat` already accepts
  the rule shapes we'll emit. The runtime branches haven't changed.

## Out of scope

- Custom color picker for arbitrary gradient stops (12 presets cover the
  common cases — defer until user demand).
- Icon sets (`type: 'icons'`) — engine has a stub but no real
  implementation. Separate proposal.
- Striped data bars (`gradientDataBar_*` rendered with stripes vs. solid)
  — current canvas painter draws solid bars; presets would all look the
  same. Either drop the gradient presets from the menu, or implement
  striped rendering in `state/canvas.ts::drawDataBar`. Recommend dropping
  for v1.
- Three-color data bars / negative axis customisation.

## Risk

Low. The engine is already verified by tests. The producer functions are
new (no backwards-compatibility constraints). The UI changes are additive.
The only failure mode is colour values not matching expectations — easily
fixed by tweaking `CF_PRESETS`.
