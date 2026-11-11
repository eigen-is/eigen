// The stored shapes of a workbook, such as a cell, a sheet and its frozen pane, and the few helpers that read them.
// The sheet engine, the editor and the API all use them. They live in lib because the sheet package depends on lib,
// not the other way around, so the backend can import them without React.

import { isRecord } from '../core/guards';
import type { ChartLook, ChartSpecPartKey } from '../types/chart';

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
    // Signed degrees in [-90, 90], positive counter-clockwise, or 'vertical' for stacked characters, as Excel's
    // textRotation.
    rt?: number | 'vertical';
    link?: CellLink;
    commentCardIds?: string[];
};

// A link belongs to its cell, so whatever moves the cell moves it.
export type CellLink = { type: CellLinkType; address: string };

export type CellLinkType = 'webpage' | 'cellrange' | 'sheet';

export function isCellLinkType(value: unknown): value is CellLinkType {
    return value === 'webpage' || value === 'cellrange' || value === 'sheet';
}

export type CellMatrix = (Cell | null)[][];

export type CellWithRowAndCol = {
    r: number;
    c: number;
    v: Cell | null;
};

const OP_NAMES = [
    'replace',
    'remove',
    'add',
    'insertRowCol',
    'deleteRowCol',
    'addSheet',
    'deleteSheet',
    'renameSheet',
] as const;

// One edit to a workbook, made by the editor from immer's patches and replayed by every reader. `value` stays `any`
// because it carries a cell, a sheet or a row or column op, with no field that says which.
export type Op = {
    op: (typeof OP_NAMES)[number];
    id?: string;
    path: (string | number)[];
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    value?: any;
};

// Whether a log entry, which a peer can store as anything, is a batch every reader can walk and send on as JSON: each
// op a known kind, its sheet id text, its path text and finite numbers, and no BigInt anywhere in it.
export function isOpBatch(entry: unknown): entry is Op[] {
    return Array.isArray(entry) && entry.every(isOp);
}

function isOp(value: unknown): value is Op {
    if (!isRecord(value)) return false;
    const { op, id, path } = value;
    if (!OP_NAMES.some((name) => name === op) || (id !== undefined && typeof id !== 'string')) return false;
    if (!Array.isArray(path) || !path.every((key) => typeof key === 'string' || Number.isFinite(key))) return false;
    // Walked with a list, since a value nested deep enough would overflow the stack of a walk that calls itself.
    const pending: unknown[] = [value];
    while (pending.length > 0) {
        const next = pending.pop();
        if (typeof next === 'bigint') return false;
        if (typeof next === 'object' && next !== null) for (const held of Object.values(next)) pending.push(held);
    }
    return true;
}

// A batch with a row or column op, or a sheet's add, delete or rename. Such an op ships no values, so every reader's
// replay rewrites the formulas it moves or renames and recomputes what it can affect, which a cell edit never costs.
export function isStructuralBatch(batch: readonly Op[]): boolean {
    return batch.some((op) => !isPatchOp(op));
}

// A cell or field write, which every reader applies as an immer patch. A row, column or sheet op runs its own code.
export function isPatchOp(op: Op): op is Op & { op: 'add' | 'remove' | 'replace' } {
    return op.op === 'add' || op.op === 'remove' || op.op === 'replace';
}

// One rectangle of cells, each span its first and last index. A rule's ranges and the engine's ranges are these.
export type SingleRange = { row: number[]; column: number[] };
export type Range = SingleRange[];

export type BorderSide = { style: number; color: string };
// A border belongs to the cell it was drawn on and is never mirrored onto the neighbor across the edge. `s` is the
// diagonal slash from top left to bottom right, xlsx's diagonalDown.
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

// Unzoomed grid pixels from A1's top-left, rotated about the center by `angle` degrees clockwise. `index` is a
// fractional key that orders images and charts together for painting, ties broken by id.
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

// The spec is stored a field per part and read only through readChartSpec, its range refs naming sheets by id. The
// look is a canvas chart's own fields, each written apart and read through readChartLook.
export type SheetChart = SheetFloatingObject & Partial<ChartLook> & Record<ChartSpecPartKey, string>;

// A data-validation rule, such as a list or a number check, which a sheet holds over its ranges. `type` and `type2` are
// plain strings because the dialog sets them from a Select's string value.
export type DataValidationRule = {
    type: string;
    type2: string;
    value1: string;
    value2: string;
    hintShow?: boolean;
    hintValue?: string;
    prohibitInput?: boolean;
};

// What every rule a sheet holds over cells shares. `order` is a fractional key that sorts a sheet's rules of one kind.
export type RangeRule = { ranges: SingleRange[]; order: string };

// One rule over its ranges, stored under an id in `Sheet.dataValidations`. Where two rules cover a cell, the last in
// order has it.
export type SheetValidation = RangeRule & { rule: DataValidationRule };

export type SheetConfig = {
    merge?: Record<string, MergeCell>;
    rowlen?: Record<string, number>;
    columnlen?: Record<string, number>;
    rowhidden?: Record<string, number>;
    colhidden?: Record<string, number>;
    borderInfo?: Record<string, CellBorderSides>;
};

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

type DataBarRule = RangeRule & { type: 'dataBar'; format: string[] };
type ColorGradationRule = RangeRule & { type: 'colorGradation'; format: string[] };
export type DefaultConditionalFormatRule = RangeRule & {
    type: 'default';
    format: { textColor?: string | null; cellColor?: string | null };
    conditionName: ConditionalFormatConditionName;
    conditionRange?: SingleRange[];
    conditionValue: (string | number)[];
};

// A conditional-format rule over its ranges, stored under an id in `Sheet.conditionalFormats`. The rules apply first
// to last in order, so the last rule's colors win a cell.
export type ConditionalFormatRule = DataBarRule | ColorGradationRule | DefaultConditionalFormatRule;

export type Sheet = {
    name: string;
    id: string;
    order?: number;
    // 1 hides the tab (View > Hidden sheets shows it again); the editor opens on a sheet it shows.
    hide?: number;
    // The tab's color, a CSS color.
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
    // Frozen panes. `row_focus` and `column_focus` are the 0-based index of the last frozen row and column.
    // A bare type such as 'row' freezes the same axes as its range form, and its range applies the same way.
    frozen?: {
        type: 'row' | 'column' | 'both' | 'rangeRow' | 'rangeColumn' | 'rangeBoth';
        range?: { row_focus: number; column_focus: number };
    };
    // The autofilter's range, whose header row shows the filter buttons. Each column's criteria live on the
    // editor-only `filter` field.
    filterRange?: SingleRange;
    // The conditional formats and the data-validation rules by id. Every reader gives a sheet both maps, so a rule is
    // written under its own id and two peers editing different rules don't overwrite each other.
    conditionalFormats?: Record<string, ConditionalFormatRule>;
    dataValidations?: Record<string, SheetValidation>;
    // Floating images and charts by id. Materialized like the config collections, because each object is
    // written as its own key and a first write to a missing map would ship the whole map.
    images?: Record<string, SheetImage>;
    charts?: Record<string, SheetChart>;
};

// The sheet fields that hold records by id, each written under its own key. Every reader gives a sheet all of them.
export const SHEET_KEYED_MAPS = ['images', 'charts', 'conditionalFormats', 'dataValidations'] as const;

// Whether a frozen pane freezes rows: 'row', 'both', and their range forms 'rangeRow' and 'rangeBoth'.
export function freezesRows(frozen: Sheet['frozen']): boolean {
    const type = frozen?.type;
    return type === 'row' || type === 'both' || type === 'rangeRow' || type === 'rangeBoth';
}

// Whether a frozen pane freezes columns: 'column', 'both', and their range forms 'rangeColumn' and 'rangeBoth'.
export function freezesColumns(frozen: Sheet['frozen']): boolean {
    const type = frozen?.type;
    return type === 'column' || type === 'both' || type === 'rangeColumn' || type === 'rangeBoth';
}
