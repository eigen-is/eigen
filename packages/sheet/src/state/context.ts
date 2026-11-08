// The editor's state: one Context object holding the sheets, the selection, the open edit, the view and
// the caches every module reads and writes through immer. defaultContext builds a fresh one, and the
// helpers here reach a sheet's matrix and config through it.

import {
    SHEET_COLUMN_HEADER_HEIGHT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
    SHEET_ROW_HEADER_WIDTH,
} from '@workspace/lib/sheets';
import { isNil, sortBy } from 'es-toolkit/compat';
import type { Cell, CellMatrix } from '../engine/types';
import { FormulaCache } from './modules';
import type { CellGlyph } from './modules/cell-glyph';
import type { FloatingRef } from './modules/floating';
import { normalizeSelection } from './modules/selection';
import type { Hooks } from './settings';
import type {
    FilterOptions,
    GlobalCache,
    LinkCardProps,
    Presence,
    Rect,
    SearchHighlight,
    Selection,
    Sheet,
    SingleRange,
} from './types';
import { getSheetIndex, sheetOrder } from './utils';

type MutableRefObject<T> = {
    current: T;
};

export type FunctionCandidate = {
    n: string;
    d?: string;
};

type RefValues = {
    globalCache: GlobalCache;
    cellInput: MutableRefObject<HTMLDivElement | null>;
    fxInput: MutableRefObject<HTMLDivElement | null>;
    canvas: MutableRefObject<HTMLCanvasElement | null>;
    cellArea: MutableRefObject<HTMLDivElement | null>;
    workbookContainer: MutableRefObject<HTMLDivElement | null>;
};

export type Context = {
    sheets: Sheet[];
    devicePixelRatio: number;
    activeObject?: FloatingRef;
    presences?: Presence[];
    // The find highlights. They live only here, because an op carries only what is under sheets.
    searchHighlights?: SearchHighlight[];
    searchActive?: SearchHighlight | null;
    linkCard?: LinkCardProps;
    // Whether a range picker is open. While it is, the cell editor and the link card keep out of the way of the pick.
    // A notice for the overlay to show, such as why an edit was refused. A write sets it, and the
    // overlay opens the notice and clears it.
    warnDialog?: string;
    validationListOpen?: boolean;

    filterContextMenu?: {
        x: number;
        y: number;
        col: number;
        startRow: number;
        endRow: number;
        startCol: number;
        endCol: number;
    };

    currentSheetId: string;

    visibledatarow: number[];
    visibledatacolumn: number[];
    ch_width: number;
    rh_height: number;

    cellmainWidth: number;
    cellmainHeight: number;
    tableContentSize: number[];

    defaultcollen: number;
    defaultrowlen: number;

    scrollLeft: number;
    scrollTop: number;

    // A scroll the code asks for, such as following the selection. scrollLeft and scrollTop only mirror the live
    // position, so a fresh object here is what tells the effect to scroll.
    scrollRequest?: { left?: number; top?: number };

    sheetScrollRecord: Record<
        string,
        {
            scrollLeft: number;
            scrollTop: number;
            selectionActive: boolean;
        }
    >;

    selectionActive: boolean;
    selections: Sheet['selections'];
    formulaRangeSelections: SingleRange[];
    formulaRangeHighlight: ({
        rangeIndex: number;
        backgroundColor: string;
    } & Rect)[];
    formulaRangeSelect: ({ rangeIndex: number } & Rect) | undefined;
    functionCandidates: FunctionCandidate[];
    functionHint: string | null | undefined;

    // The workbook's last copy or cut of cells. A paste is that copy exactly when the clipboard's table carries its id.
    copyState?: {
        id: string;
        cut: boolean;
        dataSheetId: string;
        copyRange: { row: number[]; column: number[] }[];
    };
    // The range the format painter took, while the painter is on.
    painterSource?: { sheetId: string; range: { row: number[]; column: number[] } };

    filterOptions?: FilterOptions;
    filterButtonHover?: number;
    cellGlyphHover?: CellGlyph;

    scrolling: boolean;

    rowsSelected: boolean;
    colsSelected: boolean;
    rowsResizing: boolean;
    rowsResizeStart: number[];
    colsResizing: boolean;
    colsResizeStart: number[];
    colsFreezeDragging: boolean;
    rowsFreezeDragging: boolean;

    editingCellPosition: number[];

    shiftKeyDown: boolean;
    shiftAnchor: Selection | undefined;

    cellSelectMoving: boolean;
    cellSelectMoveIndex: number[];

    cellSelectExtending: boolean;
    cellSelectExtendIndex: number[];

    showGridLines: boolean;
    allowEdit: boolean;

    defaultCell: Cell;

    groupValuesRefreshData: {
        r: number;
        c: number;
        v: Cell['v'];
        f: string;
        id: string;
    }[];
    formulaCache: FormulaCache;
    hooks: Hooks;

    sheetFocused: boolean;

    getRefs: () => RefValues;
};

export function defaultContext(refs: RefValues): Context {
    return {
        sheets: [],
        devicePixelRatio: globalThis.devicePixelRatio,

        currentSheetId: '',
        warnDialog: undefined,

        validationListOpen: false,

        visibledatarow: [],
        visibledatacolumn: [],
        ch_width: 0,
        rh_height: 0,

        cellmainWidth: 0,
        cellmainHeight: 0,
        tableContentSize: [0, 0],

        defaultcollen: SHEET_DEFAULT_COL_WIDTH,
        defaultrowlen: SHEET_DEFAULT_ROW_HEIGHT,

        scrollLeft: 0,
        scrollTop: 0,
        scrollRequest: undefined,

        sheetScrollRecord: {},

        selectionActive: false,
        selections: undefined,
        formulaRangeSelections: [],
        formulaRangeHighlight: [],
        formulaRangeSelect: undefined,
        functionCandidates: [],
        functionHint: null,

        scrolling: false,

        rowsSelected: false,
        colsSelected: false,
        rowsResizing: false,
        rowsResizeStart: [],
        colsResizing: false,
        colsResizeStart: [],
        colsFreezeDragging: false,
        rowsFreezeDragging: false,

        editingCellPosition: [],

        shiftKeyDown: false,
        shiftAnchor: undefined,

        cellSelectMoving: false,
        cellSelectMoveIndex: [],

        cellSelectExtending: false,
        cellSelectExtendIndex: [],

        showGridLines: true,
        allowEdit: true,

        sheetFocused: true,

        defaultCell: {
            bl: 0,
            ct: { fa: 'General', t: 'n' },
            fc: 'rgb(51, 51, 51)',
            ff: 0,
            fs: 11,
            ht: 1,
            it: 0,
            vt: 1,
            m: '',
            v: '',
        },

        groupValuesRefreshData: [],
        // Immer doesn't freeze a class, so this stays mutable inside and outside a recipe.
        formulaCache: new FormulaCache(),
        hooks: {},

        getRefs: () => refs,
    };
}

export function getFlowdata(ctx?: Context, id?: string | null) {
    if (!ctx) return null;
    const i = getSheetIndex(ctx, id || ctx.currentSheetId);
    if (isNil(i)) {
        return null;
    }
    return ctx.sheets?.[i]?.data;
}

export function getSheetConfig(ctx?: Context, id?: string | null) {
    if (!ctx) return undefined;
    const i = getSheetIndex(ctx, id || ctx.currentSheetId);
    if (isNil(i)) {
        return undefined;
    }
    return ctx.sheets?.[i]?.config;
}

// Accumulated in locals and assigned once: per-row writes through the immer draft cost ~3x on 100k rows. A track is its
// stored size with the gridline drawn on its last pixel, as Excel counts it and the export draws it.
function calcRowColSize(ctx: Context, rowCount: number, colCount: number) {
    const cfg = getSheetConfig(ctx);
    const rowlen = cfg?.rowlen;
    const rowhidden = cfg?.rowhidden;
    const columnlen = cfg?.columnlen;
    const colhidden = cfg?.colhidden;
    const { defaultrowlen, defaultcollen } = ctx;

    const visibledatarow: number[] = [];
    let rh_height = 0;
    for (let r = 0; r < rowCount; r += 1) {
        if (rowhidden?.[r] == null) rh_height += rowlen?.[r] || defaultrowlen;
        visibledatarow.push(rh_height);
    }
    ctx.visibledatarow = visibledatarow;
    ctx.rh_height = rh_height + 80; // add blank space at the very bottom

    const firstRow = getFlowdata(ctx)?.[0];
    const visibledatacolumn: number[] = [];
    let ch_width = 0;
    for (let c = 0; c < colCount; c += 1) {
        let width = columnlen?.[c] || defaultcollen;
        // Clamp a very wide imported default column width for layout only. This is a
        // geometry recompute — persisting the clamp would ship an op and take an undo
        // entry from a render pass, on every client independently.
        if (!columnlen?.[c] && firstRow?.[c] && width > 300) width = 300;
        if (colhidden?.[c] == null) ch_width += width;
        visibledatacolumn.push(ch_width);
    }
    ctx.visibledatacolumn = visibledatacolumn;
    ctx.ch_width = ch_width + 120; // add blank space at the far right
}

// Gives a sheet whose id another sheet already has a fresh one, and leaves exactly one sheet active: the first one
// marked active, or else the first sheet.
export function ensureSheetIndex(data: Sheet[]) {
    if (data.length === 0) return;
    const ids = new Set<string>();
    let hasActive = false;
    for (const item of data) {
        if (ids.has(item.id)) item.id = crypto.randomUUID();
        else ids.add(item.id);
        item.status ??= 0;
        if (item.status === 1) {
            if (hasActive) item.status = 0;
            else hasActive = true;
        }
    }
    if (!hasActive) data[0].status = 1;
}

export function firstVisibleSheetId(ctx: Context, excludeId?: string) {
    const shown = ctx.sheets.filter((sheet) => sheet.hide !== 1 && sheet.id !== excludeId);
    return sortBy(shown, sheetOrder)[0]?.id;
}

export function initSheetIndex(ctx: Context) {
    const id = ctx.sheets.find((sheet) => sheet.status === 1 && sheet.hide !== 1)?.id ?? firstVisibleSheetId(ctx);
    if (id != null) ctx.currentSheetId = id;
}

export function updateContextWithSheetData(ctx: Context, data: CellMatrix) {
    const rowCount = data.length;
    const colCount = rowCount === 0 ? 0 : data[0].length;

    calcRowColSize(ctx, rowCount, colCount);
    normalizeSelection(ctx, ctx.selections);
}

export function updateContextWithCanvas(ctx: Context, canvas: HTMLCanvasElement, placeholder: HTMLDivElement) {
    ctx.tableContentSize = [placeholder.clientWidth, placeholder.clientHeight];
    ctx.cellmainHeight = placeholder.clientHeight - SHEET_COLUMN_HEADER_HEIGHT;
    ctx.cellmainWidth = placeholder.clientWidth - SHEET_ROW_HEADER_WIDTH;

    canvas.style.width = `${ctx.tableContentSize[0]}px`;
    canvas.style.height = `${ctx.tableContentSize[1]}px`;

    canvas.width = Math.ceil(ctx.tableContentSize[0] * ctx.devicePixelRatio);
    canvas.height = Math.ceil(ctx.tableContentSize[1] * ctx.devicePixelRatio);
}
