// Canonical sheet data shapes shared between the sheet engine, the editor's
// state layer, and the apps/api backend. Lives here (not in the sheet package)
// because sheet depends on @workspace/lib, not the other way around — keeping these
// in lib avoids a workspace cycle and lets the backend import them without pulling
// in React.

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

// Sheet operation produced by the editor's state layer (immer patch-to-op step)
// and consumed by both the sheet runtime and the apps/api document reader.
// Lives in lib so the BE can replay ops without pulling in the state barrel.
// `value` stays `any` because the legacy state/ utils (patch.ts, Workbook/api.ts)
// pass it as Cell, Sheet, RowColOp, calcChain, … without a discriminator; tightening
// is part of TODO #1 (enable biome on state/).
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
// the neighbour across the shared edge — and a side that is absent has no border.
// `s` is the editor's diagonal slash; xlsx has no equivalent and skips it.
export type CellBorderSides = {
    l?: BorderSide;
    r?: BorderSide;
    t?: BorderSide;
    b?: BorderSide;
    s?: BorderSide;
};
// Toolbar border layouts, expanded into per-cell sides at write time
// (state/modules/border.ts). Listed here so consumers narrow via `type === '…'`.
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

export type MergeCell = { r: number; c: number; rs: number; cs: number };

// Per-cell data-validation rule, produced by the editor's state layer
// (state/modules/data-verification.ts) and consumed by the canvas painter
// (red-triangle indicator + checkbox draw). Keyed by `${row}_${col}` on
// `Sheet.dataVerification`.
//
// `value1` carries the encoded payload as a string regardless of `type`:
// comma-separated list for `dropdown`, numeric literal for the `number*` and
// `text_length` variants, "selected" label for `checkbox`, ISO date for `date`.
// `value2` is only populated for `between`/`notBetween` ranges and by
// `checkbox` (its not-selected label) and is otherwise blank. A tick box stores
// no checked flag — the cell value answers that (see `isCheckboxChecked`).
// `hintShow` + `hintValue` drive the cell-focus hint popup. `prohibitInput`
// blocks the input when validation fails (read by `updateCell` in cell.ts).
//
// `type` and `type2` are `string` rather than a narrow union: the producer in
// `components/DataVerification/index.tsx` assigns via Radix Select's
// `onValueChange(value: string)` and threading a union through the dialog
// requires runtime narrowing at every callback. Known values today:
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

// Conditional-format rule shape, produced by the editor's state layer
// (state/modules/condition-format.ts) and consumed by the engine's
// `evaluateConditionalFormat` (canvas painter + apps/api HTML export).
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
export type IconsRule = CFRuleBase & { type: 'icons' };
export type DefaultConditionalFormatRule = CFRuleBase & {
    type: 'default';
    format: { textColor?: string | null; cellColor?: string | null };
    conditionName: ConditionalFormatConditionName;
    conditionRange?: SingleRange[];
    conditionValue: (string | number)[];
};

export type ConditionalFormatRule = DataBarRule | ColorGradationRule | IconsRule | DefaultConditionalFormatRule;

export type Sheet = {
    name: string;
    id?: string;
    order?: number;
    config?: SheetConfig;
    celldata?: CellWithRowAndCol[];
    data?: CellMatrix;
    row?: number;
    column?: number;
    showGridLines?: boolean | number;
    conditionalFormatRules?: ConditionalFormatRule[];
    // Frozen panes. `row_focus`/`column_focus` are the 0-based index of the LAST
    // frozen row/column. The bare 'row'|'column'|'both' forms are aliases the
    // editor normalizes to the 'range*' forms at consume time (the range applies
    // either way — see state/modules/freeze.ts::frozenTofreezen).
    frozen?: {
        type: 'row' | 'column' | 'both' | 'rangeRow' | 'rangeColumn' | 'rangeBoth';
        range?: { row_focus: number; column_focus: number };
    };
    // Autofilter span — the rectangle whose header row renders the filter dropdown
    // buttons. Per-column criteria live on the editor-only `filter` field (sheet's
    // state/types.ts); a criteria-less filter — what a fresh enable writes and all
    // the xlsx importer emits — is just this range.
    filterRange?: SingleRange;
    // Data-validation rules keyed "r_c" (0-based). Written by the editor's
    // DataVerification dialog and the xlsx importer; the runtime (cell focus,
    // updateCell, canvas painter) reads them straight off the sheet.
    dataVerification?: Record<string, DataVerificationRule>;
    // Hyperlinks keyed "r_c" (0-based). Written by the editor's LinkEditCard
    // (saveHyperlink) and the xlsx importer; read by the link preview card and
    // goToLink navigation. The linked cell carries the `hl` backref. linkType
    // ∈ webpage | sheet | cellrange (state/modules/hyperlink.ts).
    hyperlink?: Record<string, { linkType: string; linkAddress: string }>;
};
