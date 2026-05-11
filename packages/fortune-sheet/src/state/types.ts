import type { BorderInfo, ConditionalFormatRule, DataVerificationRule, MergeCell, Op } from '@workspace/lib/sheets';
import type { Patch as ImmerPatch } from 'immer';
import type { Cell, CellMatrix, CellWithRowAndCol, Range, SingleRange } from '../engine/types';
import type { PatchOptions } from './utils';

// Shared sheet data shapes (Cell, CellMatrix, CellWithRowAndCol, SingleRange,
// Range, …) live in @workspace/lib/sheets and are re-exported through
// ../engine/types — surfaced here so state-side consumers don't have to know
// the canonical home. `Op`, `BorderInfo`, `ConditionalFormatRule`, and
// `DataVerificationRule` live in lib too (the BE document reader replays ops
// without the engine, the HTML export reads borderInfo and CF rules, and
// data-validation rules are touched by the editor + canvas painter); none is
// engine-conceptual so they're re-exported directly from lib here.
export type {
    BorderInfo,
    Cell,
    CellMatrix,
    CellWithRowAndCol,
    ConditionalFormatRule,
    DataVerificationRule,
    MergeCell,
    Op,
    Range,
    SingleRange,
};

export type Rect = {
    top: number;
    left: number;
    width: number;
    height: number;
};

export type Selection = {
    left?: number;
    width?: number;
    top?: number;
    height?: number;
    left_move?: number;
    width_move?: number;
    top_move?: number;
    height_move?: number;
    row: number[];
    column: number[];
    row_focus?: number;
    column_focus?: number;
    moveXY?: { x: number; y: number };
    row_select?: boolean;
    column_select?: boolean;
};

export type Presence = {
    sheetId: string;
    username: string;
    userId?: string;
    color: string;
    selection: {
        r: number;
        c: number;
    };
};

// Editor-runtime SheetConfig. Some fields (merge / rowlen / columnlen / rowhidden /
// colhidden / borderInfo) overlap with lib's API-shape `SheetConfig`; the editor
// keeps borderInfo loosely typed because state producer sites (paste, rowcol,
// toolbar, selection, dropCell, api/cell) push raw object literals whose
// `rangeType: 'cell' | 'range'` discriminator isn't `as const`-tagged. Tightening
// to `BorderInfo[]` is part of TODO #1 — at that point this type should collapse
// into `Omit<ApiSheetConfig, ...> & { editor extras }`. Readers (border.ts,
// canvas.ts) narrow at the use-site via assignment to a `BorderInfo[]` local.
export type SheetConfig = {
    merge?: Record<string, MergeCell>;
    rowlen?: Record<string, number>; // row heights
    columnlen?: Record<string, number>; // column widths
    rowhidden?: Record<string, number>; // hidden rows
    colhidden?: Record<string, number>; // hidden columns
    customHeight?: Record<string, number>;
    customWidth?: Record<string, number>;
    // biome-ignore lint/suspicious/noExplicitAny: see the SheetConfig doc above — TODO #1
    borderInfo?: any[];
    // Sheet protection settings — read by protection.ts as a flag bag with
    // varied shapes (mode-dependent). Tightening requires inverting the field
    // set across all protection modes.
    // biome-ignore lint/suspicious/noExplicitAny: cascade-blocked, see comment
    authority?: any;
    rowReadOnly?: Record<number, number>;
    colReadOnly?: Record<number, number>;
};

export type Image = {
    id: string;
    width: number;
    height: number;
    left: number;
    top: number;
    mediaName: string;
};

// Calc-chain entry: dependency-graph node for a formula cell. Engine producers
// always stamp `id`; consumers in state/modules/rowcol.ts treat the entry as
// assignable to FormulaCell (which requires id).
export type CalcChainEntry = { r: number; c: number; id: string; index?: number };

// Per-column filter rule state. Producers in state/modules/filter.ts /
// rowcol.ts set every field. Variable-shape rule details (FilterMethod,
// FilterCustomDetail, …) flow through the `[key]: unknown` overflow.
export type FilterEntry = {
    caljs: unknown;
    rowhidden: Record<string, number>;
    optionstate: boolean;
    str: number;
    edr: number;
    cindex: number;
    stc: number;
    edc: number;
    [key: string]: unknown;
};

// Alternate-format placeholder entry. The feature never landed; rowcol shifts
// the cellrange but the array is otherwise empty (see state/modules/cell.ts
// :1143 where consumers initialise an empty `checksAF: string[]`).
export type AlternateFormatEntry = {
    cellrange: { row: [number, number]; column: [number, number] };
};

// Editor-runtime Sheet. Field overlap with lib's `Sheet` (name / id / config /
// data / celldata / showGridLines / luckysheet_conditionformat_save) — same TODO
// #1 caveat as SheetConfig. CF rules use the canonical `ConditionalFormatRule`
// discriminated union from lib; producers in conditionFormat.ts annotate their
// rule literals explicitly so the discriminator narrows.
export type Sheet = {
    name: string;
    config?: SheetConfig;
    order?: number;
    color?: string;
    data?: CellMatrix;
    celldata?: CellWithRowAndCol[];
    id?: string;
    images?: Image[];
    column?: number;
    row?: number;
    addRows?: number;
    status?: number;
    hide?: number;
    luckysheet_select_save?: Selection[];
    luckysheet_selection_range?: {
        row: number[];
        column: number[];
    }[];
    calcChain?: CalcChainEntry[];
    defaultRowHeight?: number;
    defaultColWidth?: number;
    showGridLines?: boolean | number;
    // Pivot-table config — currently unreferenced in active code (only commented-
    // out callers in toolbar.ts / merge.ts); kept on the type for upstream
    // workbook-import compatibility.
    pivotTable?: unknown;
    isPivotTable?: boolean;
    filter?: Record<string, FilterEntry>;
    filter_select?: { row: number[]; column: number[] };
    luckysheet_conditionformat_save?: ConditionalFormatRule[];
    luckysheet_alternateformat_save?: AlternateFormatEntry[];
    dataVerification?: Record<string, DataVerificationRule>;
    hyperlink?: Record<string, { linkType: string; linkAddress: string }>;
    // Dynamic-array formula source list — entries describe spill ranges; engine
    // pushes here when a `=A1:A3*2`-style formula is evaluated. Same r/c/id
    // shape as calcChain; `id` is optional for legacy entries.
    dynamicArray_compute?: CalcChainEntry[];
    dynamicArray?: { r: number; c: number; id?: string }[];
    frozen?: {
        type: 'row' | 'column' | 'both' | 'rangeRow' | 'rangeColumn' | 'rangeBoth';
        range?: { row_focus: number; column_focus: number };
    };
};

export type SearchResult = {
    r: number;
    c: number;
    sheetName: string;
    sheetId: string;
    cellPosition: string;
    value: string;
};

export type LinkCardProps = {
    sheetId: string;
    r: number;
    c: number;
    rc: string;
    originText: string;
    originType: string;
    originAddress: string;
    position: { cellLeft: number; cellBottom: number };
    isEditing: boolean;
    selectingCellRange?: boolean;
};

export type RangeDialogProps = {
    show: boolean;
    rangeTxt: string;
    type: string;
    singleSelect: boolean;
};

// Editor-form draft of a single data-validation rule. Producers (the default
// initializer in context.ts and the dialog `confirm` handler) set every field
// with a sentinel default (`''` / `false`), then spread the draft into the
// stored `DataVerificationRule`. `rangeTxt` is dialog-only — carries the
// user-typed target range expression.
export type DataRegulationProps = {
    type: string;
    type2: string;
    rangeTxt: string;
    value1: string;
    value2: string;
    validity: string;
    remote: boolean;
    prohibitInput: boolean;
    hintShow: boolean;
    hintValue: string;
};

export type ConditionRulesProps = {
    rulesType: string;
    rulesValue: string;
    textColor: { check: boolean; color: string };
    cellColor: { check: boolean; color: string };
    betweenValue: { value1: string; value2: string };
    dateValue: string;
    repeatValue: string;
    projectValue: string;
};

export type FilterOptions = {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    left: number;
    top: number;
    width: number;
    height: number;
    items: {
        col: number;
        left: number;
        top: number;
    }[];
};

export type History = {
    patches: ImmerPatch[];
    inversePatches: ImmerPatch[];
    options?: PatchOptions;
};

// Pre-computed pixel offsets the freeze line uses to redraw above/below the
// frozen pane. Producer in state/modules/freeze.ts builds a 5-element array
// mixing numbers and number[] (positions, scroll offsets, cumulative per-col
// offsets). The mixed shape is awkward to encode as a tuple because consumers
// in Sheet/index.tsx pass it to helpers expecting plain `number[]`; tightening
// is a follow-up.
export type Freezen = {
    // biome-ignore lint/suspicious/noExplicitAny: producer/consumer divergence — see comment above
    horizontal?: { freezenhorizontaldata: any[]; top: number };
    // biome-ignore lint/suspicious/noExplicitAny: producer/consumer divergence — see comment above
    vertical?: { freezenverticaldata: any[]; left: number };
};

export type GlobalCache = {
    verticalScrollLock?: boolean;
    horizontalScrollLock?: boolean;
    overwriteCell?: boolean;
    ignoreWriteCell?: boolean;
    doNotFocus?: boolean;
    doNotUpdateCell?: boolean;
    recentTextColor?: string;
    recentBackgroundColor?: string;
    visibleColumnsUnique?: number[];
    visibleRowsUnique?: number[];
    undoList: History[];
    redoList: History[];
    freezen?: Record<string, Freezen>;

    // Scroll state stored outside React/immer to avoid triggering full
    // re-render cascades across all context consumers on every scroll tick.
    // Components that need scroll position subscribe via scrollListeners.
    scrollLeft: number;
    scrollTop: number;
    scrollListeners: Set<() => void>;
    notifyScrollListeners: () => void;
    image?: {
        imgInitialPosition: Rect | undefined;
        cursorMoveStartPosition: { x: number; y: number } | undefined;
        resizingSide: string | undefined;
    };
    searchDialog?: {
        mouseEnter?: boolean;
        moveProps?: {
            initialPosition: Rect | undefined;
            cursorMoveStartPosition: { x: number; y: number } | undefined;
        };
    };
    linkCard?: {
        mouseEnter?: boolean;
        rangeSelectionModal?: {
            initialPosition: Rect | undefined;
            cursorMoveStartPosition: { x: number; y: number } | undefined;
        };
    };
    dragCellStartPos?: {
        x: number;
        y: number;
    };
    touchMoveStatus?: boolean;
    touchHandleStatus?: boolean;
    touchMoveStartPos?: {
        x: number;
        y: number;
        vy: number;
        moveType: string;
        vy_x?: number;
        vy_y?: number;
        scrollTop?: number;
        scrollLeft?: number;
    };
};

// FORMULA
type AncestorFormulaCell = {
    [rxcxix: string]: number;
};

export type FormulaCell = {
    r: number;
    c: number;
    id: string;
    parent?: AncestorFormulaCell;
    func?: [boolean, number, string];
    color?: string;
    chidren?: AncestorFormulaCell;
    times?: number;
};
