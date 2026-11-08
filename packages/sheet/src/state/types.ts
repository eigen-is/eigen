// The editor's own types: the context's parts, such as the sheet with its editor-only fields, an undo entry and the
// caches beside the context. The sheet's stored shapes are lib's and the engine's, re-exported here so state code
// imports from one place.

import type {
    ConditionalFormatRule,
    DataValidationRule,
    Sheet as LibSheet,
    SheetConfig as LibSheetConfig,
    MergeCell,
    Op,
    SheetChart,
    SheetValidation,
} from '@workspace/lib/sheets';
import type { ChartSpecTexts } from '@workspace/lib/types/chart';
import type { Patch as ImmerPatch } from 'immer';
import type {
    AncestorFormulaCell,
    CalcChainEntry,
    Cell,
    CellMatrix,
    CellWithRowAndCol,
    EditorSheetConfigExtras,
    FilterCondition,
    FilterConditionName,
    FilterEntry,
    Range,
    SingleRange,
} from '../engine/types';
import type { ConditionRuleType } from './modules/condition-format';
import type { PatchOptions } from './utils';

// Re-exported so state code needn't know where each type lives. The cell and range shapes
// are lib's and reach this file through the engine's types. Op and the conditional-format and
// validation rules come from lib directly, because the server reads them without the engine.
export type {
    AncestorFormulaCell,
    CalcChainEntry,
    Cell,
    CellMatrix,
    CellWithRowAndCol,
    ConditionalFormatRule,
    DataValidationRule,
    FilterCondition,
    FilterConditionName,
    FilterEntry,
    MergeCell,
    Op,
    Range,
    SheetValidation,
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

// A range being picked into a formula. `[null, null]` on one axis means the whole axis: `row: [null, null]` is a
// whole-column reference, and `column: [null, null]` a whole-row one.
export type RangeOrWholeAxis =
    | SingleRange
    | { row: [null, null]; column: number[] }
    | { row: number[]; column: [null, null] };

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

export type SheetConfig = LibSheetConfig & EditorSheetConfigExtras;

// The sheet as the editor holds it: lib's stored fields plus editor-only ones, such as the selections, the calc chain
// and the filter criteria, which never reach the stored shape. `config` widens to the editor's SheetConfig. `id` is
// required, because the editor names every sheet by it. A stored sheet may lack one: the Workbook takes lib's Sheet in
// its `data` and gives such a sheet an id when it mounts. Fields that persist, such as the frozen panes, the hyperlinks
// and the tab colour, live on lib's Sheet, since the server reads them too.
export type Sheet = Omit<LibSheet, 'config' | 'id'> & {
    id: string;
    config?: SheetConfig;
    status?: number;
    selections?: Selection[];
    calcChain?: CalcChainEntry[];
    filter?: Record<string, FilterEntry>;
    // Dynamic-array formula source list — entries describe spill ranges; engine
    // pushes here when a `=A1:A3*2`-style formula is evaluated. Same r/c/id
    // shape as calcChain; `id` is optional for legacy entries.
    dynamicArray_compute?: CalcChainEntry[];
    dynamicArray?: { r: number; c: number; id?: string }[];
};

export type SearchResult = {
    r: number;
    c: number;
    sheetName: string;
    sheetId: string;
    cellPosition: string;
    value: string;
};

export type SearchHighlight = {
    sheetId: string;
    r: number;
    c: number;
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
};

// The rule the data-validation dialog edits, every field set, with '' or false where the rule has none, and the range
// the user typed or picked for it, which OK leaves off the stored rule.
export type DataValidationDraft = Required<DataValidationRule> & { rangeTxt: string };

export type ConditionRulesProps = {
    rulesType: ConditionRuleType;
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
    // One button per visible column, in the rect the canvas paints and the mousedown hit test reads.
    items: (Rect & { col: number })[];
};

// One undo step: the edit's patches and their inverse. A cell or field path names its sheet by id,
// ['sheets', id, field, …], so another sheet's add or delete moves nothing (recordEntry).
export type History = {
    patches: ImmerPatch[];
    inversePatches: ImmerPatch[];
    options?: PatchOptions;
    gesture?: object;
};

export type FreezenAxisData = {
    pos: number; // pixel position of the freeze boundary (visibledatarow/col at row_st/col_st)
    boundary: number; // first row/col index immediately past the freeze boundary
    scroll: number; // scroll offset captured at freeze init (currently always 0)
    cumulative: number[]; // post-boundary cumulative pixel offsets, passed to sortedIndex to map scroll → row/col
    edge: number; // viewport edge px: boundary pos − 2 + header dimension
};

export type Freezen = {
    horizontal?: { freezenhorizontaldata: FreezenAxisData };
    vertical?: { freezenverticaldata: FreezenAxisData };
};

export type GlobalCache = {
    overwriteCell?: boolean;
    ignoreWriteCell?: boolean;
    doNotFocus?: boolean;
    doNotUpdateCell?: boolean;
    recentTextColor?: string;
    recentBackgroundColor?: string;
    undoList: History[];
    redoList: History[];
    // An open panel edit (a typed title): its writes merge into one undo entry.
    undoGesture?: object;
    // The chart this workbook last copied: the inline parts it put on the clipboard and the chart itself, with its
    // ranges, which a paste of those same parts here keeps, as the wire carries only what every other app can read.
    copiedChart?: { inline: ChartSpecTexts; chart: SheetChart };
    freezen?: Record<string, Freezen>;

    // Kept outside React and immer, so a scroll tick doesn't render every reader of the context.
    scrollLeft: number;
    scrollTop: number;
    scrollListeners: Set<() => void>;
    notifyScrollListeners: () => void;
    linkCard?: {
        mouseEnter?: boolean;
    };
    dragCellStartPos?: {
        x: number;
        y: number;
    };
    // The last press on the grid landed while a menu was open, so it only closes the menu. Read on the mousedown,
    // after Radix has closed the menu on the press's pointerdown.
    pressClosedMenu?: boolean;
};

export type FormulaCell = {
    r: number;
    c: number;
    id: string;
    parent?: AncestorFormulaCell;
    func?: [boolean, number, string];
    color?: string;
    children?: AncestorFormulaCell;
    times?: number;
};
