// Shared sheets types used across the backend import/export pipeline and the frontend
// editor. The fortune-sheet workspace package has its own, richer types for the editor's
// internal needs; these are the structural subset that flows over workspace boundaries.

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

export type Cell = CellStyle & {
    v?: string | number | boolean;
    m?: string | number;
    mc?: { r: number; c: number; rs?: number; cs?: number };
    f?: string;
    ct?: { fa?: string; t?: string; s?: unknown };
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

export type SheetConfig = {
    merge?: Record<string, { r: number; c: number; rs: number; cs: number }>;
    rowlen?: Record<string, number>;
    columnlen?: Record<string, number>;
    rowhidden?: Record<string, number>;
    colhidden?: Record<string, number>;
};

export type Sheet = {
    name: string;
    id?: string;
    order?: number;
    config?: SheetConfig;
    celldata?: CellWithRowAndCol[];
};
