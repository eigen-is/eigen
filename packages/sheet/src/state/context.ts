import { isNil, sortBy } from 'es-toolkit/compat';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from '../engine/defaults';
import type { Cell, CellMatrix } from '../engine/types';
import { FormulaCache } from './modules';
import { normalizeSelection } from './modules/selection';
import type { Hooks } from './settings';
import type {
    ConditionRulesProps,
    DataRegulationProps,
    FilterEntry,
    FilterOptions,
    GlobalCache,
    Image,
    LinkCardProps,
    Presence,
    RangeDialogProps,
    Rect,
    SearchHighlight,
    Selection,
    Sheet,
} from './types';
import { getSheetIndex } from './utils';

interface MutableRefObject<T> {
    current: T;
}

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
    defaultcolumnNum: number;
    defaultrowNum: number;
    addDefaultRows: number;
    fullscreenmode: boolean;
    devicePixelRatio: number;
    insertedImgs?: Image[];
    editingInsertedImgs?: Image;
    activeImg?: string;
    presences?: Presence[];
    // Transient find highlight state (UI-only, never persisted/synced — like
    // formulaRangeHighlight; filterPatch drops non-sheets[*] patches).
    searchHighlights?: SearchHighlight[];
    searchActive?: SearchHighlight | null;
    linkCard?: LinkCardProps;
    rangeDialog?: RangeDialogProps; // coordinate range mouse selection
    // warning dialog
    warnDialog?: string;
    currency?: string;
    dataVerification?: {
        selectStatus: boolean;
        selectRange: [];
        dataRegulation?: DataRegulationProps; // data validation rule
    };
    // data validation dropdown list
    dataVerificationDropDownList?: boolean;
    conditionRules: ConditionRulesProps; // conditional formatting

    filterContextMenu?: {
        x: number;
        y: number;
        col: number;
        startRow: number;
        endRow: number;
        startCol: number;
        endCol: number;
        hiddenRows: number[];
    };

    currentSheetId: string;
    calculateSheetId: string;

    visibledatarow: number[];
    visibledatacolumn: number[];
    ch_width: number;
    rh_height: number;

    cellmainWidth: number;
    cellmainHeight: number;
    toolbarHeight: number;
    infobarHeight: number;
    calculatebarHeight: number;
    rowHeaderWidth: number;
    columnHeaderHeight: number;
    cellMainSrollBarSize: number;
    tableContentSize: number[];

    defaultcollen: number;
    defaultrowlen: number;

    scrollLeft: number;
    scrollTop: number;

    // Explicit programmatic-scroll intent (selection-follow, freeze reset,
    // sheet-switch restore), distinct from scrollLeft/scrollTop which is the
    // live-position mirror that syncScroll updates every recipe for hit-testing.
    // A fresh object per request lets the apply effect fire only when set.
    scrollRequest?: { left?: number; top?: number };

    sheetScrollRecord: Record<
        string,
        {
            scrollLeft: number;
            scrollTop: number;
            selectionActive: boolean;
            selections: Sheet['selections'];
            formulaRangeSelections: Sheet['formulaRangeSelections'];
        }
    >;

    selectionActive: boolean;
    selections: Sheet['selections'];
    formulaRangeSelections: Sheet['formulaRangeSelections'];
    formulaRangeHighlight: ({
        rangeIndex: number;
        backgroundColor: string;
    } & Rect)[];
    formulaRangeSelect: ({ rangeIndex: number } & Rect) | undefined;
    functionCandidates: FunctionCandidate[];
    functionHint: string | null | undefined;

    copyState?: {
        dataSheetId: string;
        copyRange: { row: number[]; column: number[] }[];
        RowlChange: boolean;
        HasMC: boolean;
    }; // copy/paste
    pasteIsCut: boolean;

    filterchage: boolean; // filter
    filterOptions?: FilterOptions;
    filterRange?: { row: number[]; column: number[] } | undefined;
    filter: Record<string, FilterEntry>;
    // Transient hover column for the canvas-drawn filter buttons.
    filterButtonHover?: number;

    sheetTabDragging: boolean;
    sheetTabDragData: unknown[];
    scrolling: boolean;

    currentSheetIsPivot: boolean;

    rowsSelected: boolean; // row/column header related parameters
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

    iscopyself: boolean;

    orderbyindex: number; // sort index

    modalDragging: boolean; // modal drag
    modalDragXY: number[];
    modalDragTarget: unknown;

    cellSelectMoving: boolean; // selection drag-replace
    cellSelectMoveIndex: number[];

    cellSelectExtending: boolean; // selection fill-down
    cellSelectExtendIndex: number[];

    chart_selection: unknown;

    showGridLines: boolean;
    allowEdit: boolean;

    fontList: unknown[];
    defaultFontSize: number;

    formatPainterOn: boolean;
    formatPainterOnce: boolean;

    // default cell
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
    // in read-only mode, force-highlight cells referenced by formulas
    forceFormulaRef?: boolean;

    sheetFocused: boolean; // property to track sheet focus for keyboard navigation

    getRefs: () => RefValues;
};

export function defaultContext(refs: RefValues): Context {
    return {
        sheets: [],
        defaultcolumnNum: DEFAULT_SHEET_COLUMN_COUNT,
        defaultrowNum: DEFAULT_SHEET_ROW_COUNT,
        addDefaultRows: 50,
        fullscreenmode: true,
        devicePixelRatio: (typeof globalThis !== 'undefined' ? globalThis : window).devicePixelRatio,

        currentSheetId: '',
        calculateSheetId: '',
        // warning dialog
        warnDialog: undefined,
        currency: '€',
        rangeDialog: {
            show: false,
            rangeTxt: '',
            type: '',
            singleSelect: false,
        },

        dataVerification: {
            selectStatus: false,
            selectRange: [],
            dataRegulation: {
                type: '',
                type2: '',
                rangeTxt: '',
                value1: '',
                value2: '',
                validity: '',
                remote: false,
                prohibitInput: false,
                hintShow: false,
                hintValue: '',
            },
        },

        dataVerificationDropDownList: false,

        conditionRules: {
            rulesType: '',
            rulesValue: '',
            textColor: { check: true, color: '#000000' },
            cellColor: { check: true, color: '#000000' },
            betweenValue: { value1: '', value2: '' },
            dateValue: '',
            repeatValue: '0',
            projectValue: '10',
        },

        visibledatarow: [],
        visibledatacolumn: [],
        ch_width: 0,
        rh_height: 0,

        cellmainWidth: 0,
        cellmainHeight: 0,
        toolbarHeight: 41,
        infobarHeight: 57,
        calculatebarHeight: 29,
        rowHeaderWidth: 46,
        columnHeaderHeight: 20,
        cellMainSrollBarSize: 12,
        tableContentSize: [0, 0],

        defaultcollen: 73,
        defaultrowlen: 19,

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

        copyState: undefined, // copy/paste
        pasteIsCut: false,

        filterchage: true, // filter
        filter: {},

        sheetTabDragging: false,
        sheetTabDragData: [],
        scrolling: false,

        currentSheetIsPivot: false,

        rowsSelected: false, // row/column header related parameters
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

        iscopyself: true,
        activeImg: undefined,

        orderbyindex: 0, // sort index

        modalDragging: false, // modal drag
        modalDragXY: [0, 0],
        modalDragTarget: null,

        cellSelectMoving: false, // selection drag-replace
        cellSelectMoveIndex: [],

        cellSelectExtending: false, // selection fill-down
        cellSelectExtendIndex: [],

        chart_selection: {},

        showGridLines: true,
        allowEdit: true,

        fontList: [],
        defaultFontSize: 10,

        formatPainterOn: false,
        formatPainterOnce: false,

        sheetFocused: true,

        // default cell
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
        formulaCache: new FormulaCache(), // class will not be frozen by immer, can be mutated at any time.
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

function calcRowColSize(ctx: Context, rowCount: number, colCount: number) {
    const cfg = getSheetConfig(ctx);

    ctx.visibledatarow = [];
    ctx.rh_height = 0;

    for (let r = 0; r < rowCount; r += 1) {
        let rowlen: number | string = ctx.defaultrowlen;

        if (cfg?.rowlen?.[r]) {
            rowlen = cfg.rowlen[r];
        }

        if (cfg?.rowhidden?.[r] != null) {
            ctx.visibledatarow.push(ctx.rh_height);
            continue;
        }

        ctx.rh_height += (rowlen as number) + 1;

        ctx.visibledatarow.push(ctx.rh_height); // temporary row height distribution
    }

    ctx.rh_height += 80; // add blank space at the very bottom

    ctx.visibledatacolumn = [];
    ctx.ch_width = 0;

    const maxColumnlen = 120;

    const flowdata = getFlowdata(ctx);
    for (let c = 0; c < colCount; c += 1) {
        let firstcolumnlen: number | string = ctx.defaultcollen;

        if (cfg?.columnlen?.[c]) {
            firstcolumnlen = cfg.columnlen[c];
        } else if (flowdata?.[0]?.[c] && firstcolumnlen > 300) {
            // Clamp a very wide imported default column width for layout only. This is a
            // geometry recompute — persisting the clamp would ship an op and take an undo
            // entry from a render pass, on every client independently.
            firstcolumnlen = 300;
        }

        if (cfg?.colhidden?.[c] != null) {
            ctx.visibledatacolumn.push(ctx.ch_width);
            continue;
        }

        ctx.ch_width += (firstcolumnlen as number) + 1;

        ctx.visibledatacolumn.push(ctx.ch_width); // temporary column width distribution
    }

    ctx.ch_width += maxColumnlen;
}

export function ensureSheetIndex(data: Sheet[], generateSheetId: () => string) {
    if (data?.length > 0) {
        let hasActive = false;
        const indexs: (string | number)[] = [];
        for (const item of data) {
            if (item.id == null) {
                item.id = generateSheetId();
            }
            if (indexs.includes(item.id)) {
                item.id = generateSheetId();
            } else {
                indexs.push(item.id);
            }

            if (item.status == null) {
                item.status = 0;
            }
            if (item.status === 1) {
                if (hasActive) {
                    item.status = 0;
                } else {
                    hasActive = true;
                }
            }
        }
        if (!hasActive) {
            data[0].status = 1;
        }
    }
}

export function initSheetIndex(ctx: Context) {
    // get current sheet
    const shownSheets = ctx.sheets.filter((singleSheet) => singleSheet.hide === undefined || singleSheet.hide !== 1);
    ctx.currentSheetId = sortBy(shownSheets, (sheet) => sheet.order)[0].id as string;
    for (let i = 0; i < ctx.sheets.length; i += 1) {
        if (ctx.sheets[i].status === 1 && ctx.sheets[i].hide !== 1) {
            ctx.currentSheetId = ctx.sheets[i].id!;
            break;
        }
    }
}

export function updateContextWithSheetData(ctx: Context, data: CellMatrix) {
    const rowCount = data.length;
    const colCount = rowCount === 0 ? 0 : data[0].length;

    calcRowColSize(ctx, rowCount, colCount);
    normalizeSelection(ctx, ctx.selections);
}

export function updateContextWithCanvas(ctx: Context, canvas: HTMLCanvasElement, placeholder: HTMLDivElement) {
    ctx.tableContentSize = [placeholder.clientWidth, placeholder.clientHeight];
    ctx.cellmainHeight = placeholder.clientHeight - ctx.columnHeaderHeight;
    ctx.cellmainWidth = placeholder.clientWidth - ctx.rowHeaderWidth;

    canvas.style.width = `${ctx.tableContentSize[0]}px`;
    canvas.style.height = `${ctx.tableContentSize[1]}px`;

    canvas.width = Math.ceil(ctx.tableContentSize[0] * ctx.devicePixelRatio);
    canvas.height = Math.ceil(ctx.tableContentSize[1] * ctx.devicePixelRatio);
}
