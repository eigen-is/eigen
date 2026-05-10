import type { BorderInfo, DataVerificationRule, MergeCell, Op } from '@workspace/lib/sheets';
import type { Patch as ImmerPatch } from 'immer';
import type { Cell, CellMatrix, CellWithRowAndCol, Range, SingleRange } from '../engine/types';
import type { PatchOptions } from './utils';

// Shared sheet data shapes (Cell, CellMatrix, CellWithRowAndCol, SingleRange,
// Range, …) live in @workspace/lib/sheets and are re-exported through
// ../engine/types — surfaced here so state-side consumers don't have to know
// the canonical home. `Op`, `BorderInfo`, and `DataVerificationRule` live in
// lib too (the BE document reader replays ops without the engine, the HTML
// export reads borderInfo, and data-validation rules are touched by the
// editor + canvas painter); none is engine-conceptual so they're re-exported
// directly from lib here.
export type {
    BorderInfo,
    Cell,
    CellMatrix,
    CellWithRowAndCol,
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
// keeps borderInfo loosely typed (`any[]`) because state producer sites (paste,
// rowcol, toolbar, selection, dropCell, api/cell) push raw object literals whose
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
    borderInfo?: any[];
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

// Editor-runtime Sheet. Field overlap with lib's `Sheet` (name / id / config /
// data / celldata / showGridLines / luckysheet_conditionformat_save) — same TODO
// #1 caveat as SheetConfig. State producer code in conditionFormat.ts pushes
// untyped rules, hence the `any[]` on luckysheet_conditionformat_save; the wire
// shape is `ConditionalFormatRule[]` in lib.
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
    calcChain?: any[];
    defaultRowHeight?: number;
    defaultColWidth?: number;
    showGridLines?: boolean | number;
    pivotTable?: any;
    isPivotTable?: boolean;
    filter?: Record<string, any>;
    filter_select?: { row: number[]; column: number[] };
    luckysheet_conditionformat_save?: any[];
    luckysheet_alternateformat_save?: any[];
    dataVerification?: Record<string, DataVerificationRule>;
    hyperlink?: Record<string, { linkType: string; linkAddress: string }>;
    dynamicArray_compute?: any;
    dynamicArray?: any[];
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

export type Freezen = {
    horizontal?: { freezenhorizontaldata: any[]; top: number };
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
