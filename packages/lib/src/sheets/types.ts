// The stored shapes of a workbook, such as a cell, a sheet and its frozen pane, and the few helpers that read them.
// The sheet engine, the editor and the API all use them. They live in lib because the sheet package depends on lib,
// not the other way around, so the backend can import them without React.

import type { ChartLook, SheetChartSpecParts } from '../types/chart';

export type CellStyle = {
    bl?: number;
    it?: number;
    ff?: number | string;
    fs?: number;
    fc?: string;
    ht?: number;
    vt?: number;
    tb?: string;
    cl?: number;
    un?: number;
};

export type InlineStringSegment = CellStyle & {
    v?: string;
    si?: number;
    measureText?: unknown;
};

export type CellType = {
    fa?: string;
    t?: string;
    s?: InlineStringSegment[];
};

export type Cell = CellStyle & {
    v?: string | number | boolean;
    m?: string | number;
    mc?: { r: number; c: number; rs?: number; cs?: number };
    f?: string;
    ct?: CellType;
    qp?: number;
    bg?: string;
    lo?: number;
    // Text rotation: signed degrees in [-90, 90] (positive = counter-clockwise / "up",
    // negative = clockwise / "down"), or 'vertical' for stacked top-to-bottom characters.
    // Matches Excel/OOXML's textRotation. Undefined or 0 = no rotation.
    rt?: number | 'vertical';
    hl?: { r: number; c: number; id: string };
    commentCardIds?: string[];
};

export type CellMatrix = (Cell | null)[][];

export type CellWithRowAndCol = {
    r: number;
    c: number;
    v: Cell | null;
};

// One edit to a workbook, made by the editor from immer's patches and replayed by the editor and the API.
// `value` stays `any` because the editor passes a cell, a sheet, a row or column op or a calc chain through it,
// with no field that says which.
export type Op = {
    op: 'replace' | 'remove' | 'add' | 'insertRowCol' | 'deleteRowCol' | 'addSheet' | 'deleteSheet';
    id?: string;
    path: (string | number)[];
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    value?: any;
};

// Single rectangular range in row/column coordinates. Used both as a CF rule's
// `cellrange` element and as the engine's range descriptor.
export type SingleRange = { row: number[]; column: number[] };
export type Range = SingleRange[];

export type BorderSide = { style: number; color: string };
// One cell's own borders, keyed `${row}_${col}` in `SheetConfig.borderInfo` like
// `merge`. A border belongs to the cell it was drawn on — nothing is mirrored onto
// the neighbor across the shared edge — and a side that is absent has no border.
// `s` is the editor's diagonal slash (painted top-left → bottom-right); it round-trips to
// xlsx's diagonalDown border.
export type CellBorderSides = {
    l?: BorderSide;
    r?: BorderSide;
    t?: BorderSide;
    b?: BorderSide;
    s?: BorderSide;
};
// The toolbar's border layouts, which the editor expands into each cell's own sides when it writes them.
export type BorderType =
    | 'border-all'
    | 'border-slash'
    | 'border-left'
    | 'border-right'
    | 'border-top'
    | 'border-bottom'
    | 'border-outside'
    | 'border-inside'
    | 'border-horizontal'
    | 'border-vertical'
    | 'border-none';

// The xlsx/OOXML border-style vocabulary (the `ST_BorderStyle` names), the `name`
// side of each `BORDER_STYLES` ordinal.
export type BorderStyleName =
    | 'thin'
    | 'hair'
    | 'dotted'
    | 'dashed'
    | 'dashDot'
    | 'dashDotDot'
    | 'double'
    | 'medium'
    | 'mediumDashed'
    | 'mediumDashDot'
    | 'mediumDashDotDot'
    | 'slantDashDot'
    | 'thick';

export type MergeCell = { r: number; c: number; rs: number; cs: number };

// An image or a chart floating over a sheet: unzoomed grid pixels from A1's top-left, rotated about its center by
// `angle` degrees clockwise, absent reading as 0. `index` orders images and charts together for painting, a
// fractional key with ties broken by id (floatingItems).
export type SheetFloatingObject = {
    id: string;
    index: string;
    x: number;
    y: number;
    width: number;
    height: number;
    angle?: number;
};

// `mediaName` names the file in the document's `media/` folder, which the editor and the server renderers resolve at
// render time.
export type SheetImage = SheetFloatingObject & { mediaName: string };

// The spec is stored a field per part, a keyed part a record of an entry's JSON per key, read only through readChartSpec
// (@workspace/lib/charts); its range refs name sheets by id. The look is a canvas chart's own fields, each written apart
// and read through readChartLook, flat where unset.
export type SheetChart = SheetFloatingObject & Partial<ChartLook> & SheetChartSpecParts;

// One cell's data-validation rule, keyed `${row}_${col}` on `Sheet.dataVerification`. The editor writes it, and the
// canvas painter reads it for the red triangle and the tick box.
//
// `value1` carries the encoded payload as a string regardless of `type`:
// comma-separated list for `dropdown`, numeric literal for the `number*` and
// `text_length` variants, "selected" label for `checkbox`, ISO date for `date`.
// `value2` is only populated for `between`/`notBetween` ranges and by
// `checkbox` (its not-selected label) and is otherwise blank. A tick box stores
// no checked flag — the cell value answers that (see `isCheckboxChecked`).
// `hintShow` + `hintValue` drive the cell-focus hint popup. `prohibitInput`
// blocks the input when validation fails (read by `updateCell`).
//
// `type` and `type2` are `string` rather than a narrow union: the `DataVerification` dialog assigns them from Radix
// Select's `onValueChange(value: string)`, and a union would need narrowing at every callback. Known values:
// type  ∈ dropdown | checkbox | number | number_integer | number_decimal |
//         text_content | text_length | date
// type2 ∈ between | notBetween | equal | notEqualTo | moreThanThe | lessThan |
//         greaterOrEqualTo | lessThanOrEqualTo | include | exclude |
//         earlierThan | noEarlierThan | laterThan | noLaterThan | true | ''
export type DataVerificationRule = {
    type: string;
    type2: string;
    value1: string;
    value2: string;
    hintShow?: boolean;
    hintValue?: string;
    prohibitInput?: boolean;
    // Editor-side draft fields preserved on the stored rule because the
    // `DataVerification` dialog spreads `regulation` into the saved item. They
    // have no effect at validation time but must be permitted by the type.
    rangeTxt?: string;
    validity?: string;
    remote?: boolean;
};

export type SheetConfig = {
    merge?: Record<string, MergeCell>;
    rowlen?: Record<string, number>;
    columnlen?: Record<string, number>;
    rowhidden?: Record<string, number>;
    colhidden?: Record<string, number>;
    borderInfo?: Record<string, CellBorderSides>;
};

// A conditional-format rule. The editor writes it, and the engine's `evaluateConditionalFormat` reads it for the
// canvas painter and the API's HTML export.
export type ConditionalFormatConditionName =
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'equal'
    | 'notEqual'
    | 'textContains'
    | 'between'
    | 'notBetween'
    | 'occurrenceDate'
    | 'duplicateValue'
    | 'top10'
    | 'top10_percent'
    | 'last10'
    | 'last10_percent'
    | 'aboveAverage'
    | 'belowAverage'
    | 'formula';

type CFRuleBase = { cellrange: SingleRange[] };

export type DataBarRule = CFRuleBase & { type: 'dataBar'; format: string[] };
export type ColorGradationRule = CFRuleBase & { type: 'colorGradation'; format: string[] };
type IconsRule = CFRuleBase & { type: 'icons' };
export type DefaultConditionalFormatRule = CFRuleBase & {
    type: 'default';
    format: { textColor?: string | null; cellColor?: string | null };
    conditionName: ConditionalFormatConditionName;
    conditionRange?: SingleRange[];
    conditionValue: (string | number)[];
};

export type ConditionalFormatRule = DataBarRule | ColorGradationRule | IconsRule | DefaultConditionalFormatRule;

// A formula cell in the dependency graph. The engine stamps `r`, `c` and `id`, and the editor's ordering adds
// `index`. It is never stored: decoding a snapshot builds the chain again.
export type CalcChainEntry = {
    r: number;
    c: number;
    id: string;
    index?: number;
};

export type Sheet = {
    name: string;
    id?: string;
    order?: number;
    // 1 hides the tab (View > Hidden sheets shows it again); the editor opens on a sheet it shows.
    hide?: number;
    // The tab's colour, a CSS colour.
    color?: string;
    // The CSS pixels of a column or row with no stored size, read through sheetDefaultColWidth/RowHeight.
    defaultColWidth?: number;
    defaultRowHeight?: number;
    config?: SheetConfig;
    celldata?: CellWithRowAndCol[];
    data?: CellMatrix;
    row?: number;
    column?: number;
    showGridLines?: boolean | number;
    conditionalFormatRules?: ConditionalFormatRule[];
    // Frozen panes. `row_focus` and `column_focus` are the 0-based index of the last frozen row and column.
    // A bare type such as 'row' freezes the same axes as its range form, and its range applies the same way.
    frozen?: {
        type: 'row' | 'column' | 'both' | 'rangeRow' | 'rangeColumn' | 'rangeBoth';
        range?: { row_focus: number; column_focus: number };
    };
    // The autofilter's range, whose header row shows the filter buttons. Each column's criteria live on the
    // editor-only `filter` field. A filter without criteria, which a fresh enable and the xlsx importer write, is
    // only this range.
    filterRange?: SingleRange;
    // Data-validation rules keyed "r_c" (0-based). Written by the editor's
    // DataVerification dialog and the xlsx importer; the runtime (cell focus,
    // updateCell, canvas painter) reads them straight off the sheet.
    dataVerification?: Record<string, DataVerificationRule>;
    // Hyperlinks keyed "r_c" (0-based). The editor's `saveHyperlink` and the xlsx importer write them, and the link
    // card and `goToLink` read them. The linked cell carries the `hl` backref. `linkType` is webpage, sheet or
    // cellrange.
    hyperlink?: Record<string, { linkType: string; linkAddress: string }>;
    // Floating images and charts by id. Materialized like the config collections, because each object is
    // written as its own key and a first write to a missing map would ship the whole map.
    images?: Record<string, SheetImage>;
    charts?: Record<string, SheetChart>;
};

// The editor-runtime Sheet: the wire shape plus the calc chain the reader gate keys off.
export type SheetWithCalcChain = Sheet & { calcChain?: CalcChainEntry[] };

// Whether a frozen pane freezes rows: every type but the two that freeze only columns.
export function freezesRows(frozen: Sheet['frozen']): boolean {
    const type = frozen?.type;
    return type === 'row' || type === 'both' || type === 'rangeRow' || type === 'rangeBoth';
}

// Whether a frozen pane freezes columns: every type but the two that freeze only rows.
export function freezesColumns(frozen: Sheet['frozen']): boolean {
    const type = frozen?.type;
    return type === 'column' || type === 'both' || type === 'rangeColumn' || type === 'rangeBoth';
}
