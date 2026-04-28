// Canonical sheet data shapes shared between the fortune-sheet engine, the editor's
// state layer, and the apps/api backend. Lives here (not in fortune-sheet) because
// fortune-sheet depends on @workspace/lib, not the other way around — keeping these
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
    commentChatNames?: string[];
};

export type CellMatrix = (Cell | null)[][];

export type CellWithRowAndCol = {
    r: number;
    c: number;
    v: Cell | null;
};

// Single rectangular range in row/column coordinates. Used both as a CF rule's
// `cellrange` element and as the engine's range descriptor.
export type SingleRange = { row: number[]; column: number[] };
export type Range = SingleRange[];

export type BorderSide = { style: number; color: string };
export type CellBorderInfo = {
    rangeType: 'cell';
    value: {
        row_index: number;
        col_index: number;
        l?: BorderSide;
        r?: BorderSide;
        t?: BorderSide;
        b?: BorderSide;
    };
};
export type RangeBorderInfo = {
    rangeType: 'range';
    borderType: string;
    color: string;
    style: number;
    range: SingleRange[];
};
export type BorderInfo = CellBorderInfo | RangeBorderInfo;

export type SheetConfig = {
    merge?: Record<string, { r: number; c: number; rs: number; cs: number }>;
    rowlen?: Record<string, number>;
    columnlen?: Record<string, number>;
    rowhidden?: Record<string, number>;
    colhidden?: Record<string, number>;
    borderInfo?: BorderInfo[];
};

// Conditional-format rule shape, produced by the editor's state layer
// (state/modules/conditionFormat.ts) and consumed by the engine's
// `evaluateConditionalFormat` (canvas painter + apps/api HTML export).
export type ConditionalFormatConditionName =
    | 'greaterThan'
    | 'lessThan'
    | 'equal'
    | 'textContains'
    | 'between'
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
    showGridLines?: boolean | number;
    luckysheet_conditionformat_save?: ConditionalFormatRule[];
};
