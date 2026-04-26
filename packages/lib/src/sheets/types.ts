// Structural subset of fortune-sheet's types. Lives in @workspace/lib so the backend
// import pipeline can reference sheet shapes without pulling in fortune-sheet (React).
// The frontend editor keeps fortune-sheet's richer internal types; this subset is the
// API shape used at the backend/frontend contract.

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
    tr?: string;
};

// Inline-string segment shape mirrors fortune-sheet's `InlineStringSegment` (engine/types.ts).
// Defined locally so this lib stays free of a fortune-sheet dependency, while the structural
// shape matches — Sheet snapshots can be passed straight to fortune-sheet's engine.
export type InlineStringSegment = CellStyle & {
    v?: string;
    si?: number;
    measureText?: unknown;
};

export type Cell = CellStyle & {
    v?: string | number | boolean;
    m?: string | number;
    mc?: { r: number; c: number; rs?: number; cs?: number };
    f?: string;
    ct?: { fa?: string; t?: string; s?: InlineStringSegment[] };
    qp?: number;
    bg?: string;
    lo?: number;
    rt?: number;
    hl?: { r: number; c: number; id: string };
    commentChatNames?: string[];
};

export type CellWithRowAndCol = {
    r: number;
    c: number;
    v: Cell | null;
};

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

export type SheetConfig = {
    merge?: Record<string, { r: number; c: number; rs: number; cs: number }>;
    rowlen?: Record<string, number>;
    columnlen?: Record<string, number>;
    rowhidden?: Record<string, number>;
    colhidden?: Record<string, number>;
    borderInfo?: CellBorderInfo[];
};

export type Sheet = {
    name: string;
    id?: string;
    order?: number;
    config?: SheetConfig;
    celldata?: CellWithRowAndCol[];
    data?: (Cell | null)[][] | null;
    showGridLines?: boolean | number;
    luckysheet_conditionformat_save?: unknown[];
};
