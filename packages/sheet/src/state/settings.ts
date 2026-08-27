import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from '../engine/defaults';
import type { Cell, CellMatrix } from '../engine/types';
import type { Image, Selection, Sheet, SheetConfig } from './types';

// Cell value as accepted by setCellValue / surfaced through update hooks. Covers
// raw scalar input from the formula bar / paste path plus the `Cell` object form
// passed by callers like `api.setCellValue(0, 0, { f: '=SUM(A1:B1)', bg: '#0188fb' })`.
export type CellValueInput = Cell | string | number | boolean | null | undefined;

// Returned by the `getCommentInfo` hook for menu rendering (card/entry) and
// canvas rendering (indicatorColor for the cell-corner triangle).
export type CommentInfo = {
    card: CommentCard;
    entry: CommentEntry | undefined;
    indicatorColor: string | null;
};

export type Hooks = {
    beforeUpdateCell?: (r: number, c: number, value: CellValueInput) => boolean;
    afterUpdateCell?: (row: number, column: number, oldValue: CellValueInput, newValue: CellValueInput) => void;
    afterSelectionChange?: (sheetId: string, selection: Selection) => void;
    beforeRenderRowHeaderCell?: (
        rowNumber: string,
        rowIndex: number,
        top: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D,
    ) => boolean;
    afterRenderRowHeaderCell?: (
        rowNumber: string,
        rowIndex: number,
        top: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D,
    ) => void;
    beforeRenderColumnHeaderCell?: (
        columnChar: string,
        columnIndex: number,
        left: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D,
    ) => boolean;
    afterRenderColumnHeaderCell?: (
        columnChar: string,
        columnIndex: number,
        left: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D,
    ) => void;
    beforeRenderCellArea?: (cells: CellMatrix, ctx: CanvasRenderingContext2D) => boolean;
    beforeRenderCell?: (
        cell: Cell | null,
        cellInfo: {
            row: number;
            column: number;
            startX: number;
            startY: number;
            endX: number;
            endY: number;
        },
        ctx: CanvasRenderingContext2D,
    ) => boolean;
    afterRenderCell?: (
        cell: Cell | null,
        cellInfo: {
            row: number;
            column: number;
            startX: number;
            startY: number;
            endX: number;
            endY: number;
        },
        ctx: CanvasRenderingContext2D,
    ) => void;
    beforeCellMouseDown?: (
        cell: Cell | null,
        cellInfo: {
            row: number;
            column: number;
            startRow: number;
            startColumn: number;
            endRow: number;
            endColumn: number;
        },
    ) => boolean;
    afterCellMouseDown?: (
        cell: Cell | null,
        cellInfo: {
            row: number;
            column: number;
            startRow: number;
            startColumn: number;
            endRow: number;
            endColumn: number;
        },
    ) => void;
    beforePaste?: (selection: Selection[] | undefined, content: string) => boolean;
    beforeAddSheet?: (sheet: Sheet) => boolean;
    afterAddSheet?: (sheet: Sheet) => void;
    beforeActivateSheet?: (id: string) => boolean;
    afterActivateSheet?: (id: string) => void;
    beforeDeleteSheet?: (id: string) => boolean;
    afterDeleteSheet?: (id: string) => void;
    beforeUpdateSheetName?: (id: string, oldName: string, newName: string) => boolean;
    afterUpdateSheetName?: (id: string, oldName: string, newName: string) => void;
    onAddComment?: (row: number, column: number) => void;
    onDeleteComment?: (row: number, column: number) => void;
    commentLifecycle?: ReturnType<typeof useCommentLifecycle>;
    getCommentInfo?: (row: number, column: number) => CommentInfo | null;
    onInsertImage?: () => void;
    resolveImageUrl?: (mediaName: string) => string | null;
    // Resolve a floating image's mediaName to its portable DrivePath, so an image copy can carry a
    // cross-mount source path (U5c produce). `undefined` when the media isn't resolvable yet (a
    // still-pending upload) — the copy then falls through to the pending-cell path.
    resolveImagePath?: (mediaName: string) => DrivePath | undefined;
    // Insert a pasted eigen image item as a floating image at its TYPED size (never fit-to-pane),
    // handling the cross-mount re-upload + pending→real mediaName swap app-side (U5c consume).
    onPasteEigenImage?: (item: EigenClipboardImageItem) => void;
    // Paste of an OS image file (no eigen payload) — the app runs its fit-to-pane insert + upload
    // (the same path as the Insert menu and OS-file drop) (U5c OS branch).
    onPasteImageFile?: (file: File) => void;
    // Fired whenever the active floating image changes (selected, deselected, or its geometry
    // committed), so the app can mount/refresh its image properties panel. `null` when nothing is
    // active.
    onActiveImageChange?: (image: Image | null) => void;
};

export type Settings = {
    column?: number;
    row?: number;
    addRows?: number;
    allowEdit?: boolean;
    showToolbar?: boolean;
    showFormulaBar?: boolean;
    showSheetTabs?: boolean;
    data: Sheet[];
    config?: SheetConfig;
    devicePixelRatio?: number;
    forceCalculation?: boolean;
    rowHeaderWidth?: number;
    columnHeaderHeight?: number;
    defaultColWidth?: number;
    defaultRowHeight?: number;
    defaultFontSize?: number;
    sheetTabContextMenu?: string[];
    filterContextMenu?: string[];
    generateSheetId?: () => string;
    hooks?: Hooks;
    currency?: string;
    fontList?: unknown[];
    // Ephemeral aspect-lock state for the active image's ObjectTransform (U4b/D8c). The app owns it
    // (via `useAspectLock`) so the same ON/OFF drives both the canvas handles and the panel checkbox;
    // never stored on an element.
    imageAspectLocked?: boolean;
};

export const defaultSettings: Required<Settings> = {
    column: DEFAULT_SHEET_COLUMN_COUNT, // default number of columns for an empty sheet
    row: DEFAULT_SHEET_ROW_COUNT, // default number of rows for an empty sheet
    addRows: 50, // It will add the rows when we click on add row button
    showToolbar: true, // whether to show the toolbar
    showFormulaBar: true, // whether to show the formula bar
    showSheetTabs: true, // whether to show the sheet tab area at the bottom
    data: [], // client-side sheet data [sheet1, sheet2, sheet3]
    config: {}, // settings for row height, column width, merged cells, formulas, etc.
    devicePixelRatio: 0, // device pixel ratio; higher value gives sharper rendering, 0 means auto
    allowEdit: true, // whether to allow editing in the frontend
    forceCalculation: false, // force formula recalculation; may cause performance issues with many formulas, use with caution
    rowHeaderWidth: 46,
    columnHeaderHeight: 20,
    defaultColWidth: 73,
    defaultRowHeight: 19,
    defaultFontSize: 10,
    sheetTabContextMenu: [
        'delete',
        'copy',
        'rename',
        'color',
        'hide',
        '|',
        'move',
        // "focus",
    ], // custom sheet tab right-click menu
    filterContextMenu: [
        'sort-by-asc',
        'sort-by-desc',
        '|',
        'filter-by-color',
        '|',
        'filter-by-condition',
        '|',
        'filter-by-value',
    ], // filter context menu
    generateSheetId: () => uuidv4(),
    hooks: {},
    currency: '€',
    fontList: [],
    imageAspectLocked: false,
};
