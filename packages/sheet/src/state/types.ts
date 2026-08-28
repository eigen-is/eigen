import type {
    BorderInfo,
    ConditionalFormatRule,
    DataVerificationRule,
    Sheet as LibSheet,
    SheetConfig as LibSheetConfig,
    MergeCell,
    Op,
} from '@workspace/lib/sheets';
import type { Patch as ImmerPatch } from 'immer';
import type {
    AncestorFormulaCell,
    CalcChainEntry,
    Cell,
    CellMatrix,
    CellWithRowAndCol,
    EditorSheetConfigExtras,
    Range,
    SingleRange,
} from '../engine/types';
import type { PatchOptions } from './utils';

// Types surfaced here so state-side consumers don't have to know the canonical
// home. Sheet data shapes (Cell, CellMatrix, CellWithRowAndCol, SingleRange,
// Range) live in @workspace/lib/sheets and re-export through ../engine/types;
// Op / BorderInfo / ConditionalFormatRule / DataVerificationRule live in lib
// directly (the BE document reader replays ops without the engine, the HTML
// export reads borderInfo and CF rules, and data-validation rules are touched
// by the editor + canvas painter — none is engine-conceptual). AncestorFormulaCell
// and CalcChainEntry are engine-only (formula dep graph + calc-chain node).
export type {
    AncestorFormulaCell,
    BorderInfo,
    CalcChainEntry,
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

// Formula-edit selection input. The column-header and row-header click handlers
// (`mouse-header.ts`, `formula-range.ts::rangeDragColumn`/`rangeDragRow`) pass
// `[null, null]` as a whole-axis sentinel: `row: [null, null]` denotes a whole-
// column reference, `column: [null, null]` a whole-row reference. `getRangetxt`
// emits `A:A` / `1:1` from the sentinel; the data never escapes that formatter.
// At most one axis is the sentinel (the producers never set both).
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

// Sheet-protection settings. Read-only in this fork: no UI or xlsx-import
// path writes the field today (the upstream luckysheet protect-sheet dialog
// was never ported; locale strings for the other flags are dead).
// protection.ts reads only these five fields: `sheet !== 0` toggles
// protection on; the `selectLockedCells` / `selectunLockedCells` flags allow
// selection when set to `1` (any other value, including undefined, blocks);
// `hintText` overrides `defaultSheetHintText` as the warn-dialog body.
export type SheetAuthority = {
    sheet?: number;
    selectLockedCells?: number;
    selectunLockedCells?: number;
    hintText?: string;
    defaultSheetHintText?: string;
};

// Editor-runtime SheetConfig: lib's canonical fields plus editor-only extras
// shared with the engine's row/col shifter (`EditorSheetConfigExtras`: custom
// row/col size overrides, per-row/col read-only locks) and a state-only
// `authority` (sheet-protection settings; the engine doesn't shift it). None
// of these reach the wire shape.
export type SheetConfig = LibSheetConfig &
    EditorSheetConfigExtras & {
        authority?: SheetAuthority;
    };

export type Image = {
    id: string;
    width: number;
    height: number;
    x: number;
    y: number;
    // Rotation in degrees, center origin. Added with ObjectTransform adoption (U4h). Clean break:
    // images stored before this field read `undefined` and are treated as 0 at the render/commit
    // sites (`img.angle ?? 0`) — value-defaulting, not a BC shim.
    angle?: number;
    mediaName: string;
};

// Filter-by-condition rule names. The names overlapping conditional formatting
// reuse the CF conditionNames (greaterThan, lessThan, equal, between, …); each
// maps 1:1 onto a `conditionCell*` locale string. `values` carries the rule's
// operands: none for is(Not)Empty, one for text/date/compare rules, two for
// (not)between.
export type FilterConditionName =
    | 'isEmpty'
    | 'isNotEmpty'
    | 'textContains'
    | 'textNotContains'
    | 'textStartsWith'
    | 'textEndsWith'
    | 'textEquals'
    | 'dateEqual'
    | 'dateBefore'
    | 'dateAfter'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'equal'
    | 'notEqual'
    | 'between'
    | 'notBetween';

export type FilterCondition = {
    conditionName: FilterConditionName;
    values: string[];
};

// Per-column filter rule state. Producers in state/modules/filter.ts /
// rowcol.ts set every field. `byCondition` is set when the column filters by
// condition instead of by values/color. Legacy snapshot fields (e.g. the
// retired luckysheet `caljs`) flow through the `[key]: unknown` overflow.
export type FilterEntry = {
    byCondition?: FilterCondition;
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
// the cellrange but nothing ever reads the entries.
export type AlternateFormatEntry = {
    cellrange: { row: [number, number]; column: [number, number] };
};

// Editor-runtime Sheet: lib's canonical fields plus state-only extras (selection
// state, calc chain, filter criteria, dynamic-array spill ranges, …) that never
// reach the wire shape. `config` is widened to state's SheetConfig. Frozen panes,
// the autofilter range, data-validation rules and hyperlinks live on the lib
// Sheet — they persist and the xlsx importer emits them.
export type Sheet = Omit<LibSheet, 'config'> & {
    config?: SheetConfig;
    color?: string;
    images?: Image[];
    addRows?: number;
    status?: number;
    hide?: number;
    selections?: Selection[];
    formulaRangeSelections?: SingleRange[];
    calcChain?: CalcChainEntry[];
    defaultRowHeight?: number;
    defaultColWidth?: number;
    // Pivot-table config — currently unreferenced in active code (only commented-
    // out callers in toolbar.ts / merge.ts); kept on the type for upstream
    // workbook-import compatibility.
    pivotTable?: unknown;
    isPivotTable?: boolean;
    filter?: Record<string, FilterEntry>;
    alternateFormatRules?: AlternateFormatEntry[];
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

// Pre-computed offsets the freeze line uses to redraw above/below the frozen
// pane. Built by state/modules/freeze.ts; consumed by event handlers,
// selection-overflow math, and the Sheet canvas-draw helpers.
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
    };
    linkCard?: {
        mouseEnter?: boolean;
    };
    dragCellStartPos?: {
        x: number;
        y: number;
    };
};

// FORMULA
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
