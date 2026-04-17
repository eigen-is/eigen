import {v4 as uuidv4} from "uuid";
import React from "react";
import type {Cell, CellMatrix} from "../engine/types";
import {Selection, Sheet} from "./types";

export type Hooks = {
    beforeUpdateCell?: (r: number, c: number, value: any) => boolean;
    afterUpdateCell?: (
        row: number,
        column: number,
        oldValue: any,
        newValue: any
    ) => void;
    afterSelectionChange?: (sheetId: string, selection: Selection) => void;
    beforeRenderRowHeaderCell?: (
        rowNumber: string,
        rowIndex: number,
        top: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D
    ) => boolean;
    afterRenderRowHeaderCell?: (
        rowNumber: string,
        rowIndex: number,
        top: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D
    ) => void;
    beforeRenderColumnHeaderCell?: (
        columnChar: string,
        columnIndex: number,
        left: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D
    ) => boolean;
    afterRenderColumnHeaderCell?: (
        columnChar: string,
        columnIndex: number,
        left: number,
        width: number,
        height: number,
        ctx: CanvasRenderingContext2D
    ) => void;
    beforeRenderCellArea?: (
        cells: CellMatrix,
        ctx: CanvasRenderingContext2D
    ) => boolean;
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
        ctx: CanvasRenderingContext2D
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
        ctx: CanvasRenderingContext2D
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
        }
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
        }
    ) => void;
    beforePaste?: (
        selection: Selection[] | undefined,
        content: string
    ) => boolean;
    beforeAddSheet?: (sheet: Sheet) => boolean;
    afterAddSheet?: (sheet: Sheet) => void;
    beforeActivateSheet?: (id: string) => boolean;
    afterActivateSheet?: (id: string) => void;
    beforeDeleteSheet?: (id: string) => boolean;
    afterDeleteSheet?: (id: string) => void;
    beforeUpdateSheetName?: (
        id: string,
        oldName: string,
        newName: string
    ) => boolean;
    afterUpdateSheetName?: (id: string, oldName: string, newName: string) => void;
    onAddComment?: (row: number, column: number) => void;
    onViewComment?: (row: number, column: number) => void;
    onDeleteComment?: (row: number, column: number) => void;
    onCommentColor?: (row: number, column: number, color: string | null) => void;
    onCommentResolve?: (row: number, column: number) => void;
    onCommentReopen?: (row: number, column: number) => void;
    getCommentInfo?: (row: number, column: number) => { color: string | null; indicatorColor?: string | null; status: 'open' | 'resolved' } | null;
    onInsertImage?: () => void;
    resolveImageUrl?: (mediaName: string) => string | null;
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
    config?: any;
    devicePixelRatio?: number;
    lang?: string | null;
    forceCalculation?: boolean;
    rowHeaderWidth?: number;
    columnHeaderHeight?: number;
    defaultColWidth?: number;
    defaultRowHeight?: number;
    defaultFontSize?: number;
    toolbarItems?: string[];
    cellContextMenu?: string[];
    headerContextMenu?: string[];
    sheetTabContextMenu?: string[];
    filterContextMenu?: string[];
    generateSheetId?: () => string;
    hooks?: Hooks;
    customToolbarItems?: {
        key: string;
        tooltip?: string;
        children?: React.ReactNode;
        iconName?: string;
        icon?: React.ReactNode;
        onClick?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
    }[];
    currency?: string;
    fontList?: any[];
};

export const defaultSettings: Required<Settings> = {
    column: 60, // default number of columns for an empty sheet
    row: 84, // default number of rows for an empty sheet
    addRows: 50, // It will add the rows when we click on add row button
    showToolbar: true, // whether to show the toolbar
    showFormulaBar: true, // whether to show the formula bar
    showSheetTabs: true, // whether to show the sheet tab area at the bottom
    data: [], // client-side sheet data [sheet1, sheet2, sheet3]
    config: {}, // settings for row height, column width, merged cells, formulas, etc.
    devicePixelRatio: 0, // device pixel ratio; higher value gives sharper rendering, 0 means auto
    allowEdit: true, // whether to allow editing in the frontend
    lang: null, // language
    forceCalculation: false, // force formula recalculation; may cause performance issues with many formulas, use with caution
    rowHeaderWidth: 46,
    columnHeaderHeight: 20,
    defaultColWidth: 73,
    defaultRowHeight: 19,
    defaultFontSize: 10,
    toolbarItems: [
        "undo",
        "redo",
        "format-painter",
        "clear-format",
        "|",
        "currency-format",
        "percentage-format",
        "number-decrease",
        "number-increase",
        "format",
        "|",
        "font",
        "|",
        "font-size",
        "|",
        "bold",
        "italic",
        "strike-through",
        "underline",
        "|",
        "font-color",
        "background",
        "border",
        "merge-cell",
        "|",
        "horizontal-align",
        "vertical-align",
        "text-wrap",
        "text-rotation",
        "|",
        "freeze",
        "conditionFormat",
        "filter",
        "link",
        "image",
        "quick-formula",
        "dataVerification",
        "splitColumn",
        "locationCondition",
        "screenshot",
        "search",
    ], // custom toolbar
    cellContextMenu: [
        "copy", // copy
        "paste", // paste
        "|",
        "insert-row", // insert row
        "insert-column", // insert column
        "delete-row", // delete selected row(s)
        "delete-column", // delete selected column(s)
        "delete-cell", // delete cell
        "hide-row", // hide/show selected row(s)
        "hide-column", // hide/show selected column(s)
        "set-row-height", // set row height
        "set-column-width", // set column width
        "|",
        "clear", // clear content
        "sort", // sort selection
        "|",
        "comment",
        "|",
        "orderAZ", // sort ascending
        "orderZA", // sort descending
        "filter", // filter selection
        "chart", // generate chart
        "image", // insert image
        "link", // insert link
        "data", // data validation
        "cell-format", // set cell format
    ], // custom cell right-click menu
    headerContextMenu: [
        "copy", // copy
        "paste", // paste
        "|",
        "insert-row", // insert row
        "insert-column", // insert column
        "delete-row", // delete selected row(s)
        "delete-column", // delete selected column(s)
        "delete-cell", // delete cell
        "hide-row", // hide/show selected row(s)
        "hide-column", // hide/show selected column(s)
        "set-row-height", // set row height
        "set-column-width", // set column width
        "|",
        "clear", // clear content
        "sort", // sort selection
        "orderAZ", // sort ascending
        "orderZA", // sort descending
    ], // header context menu
    sheetTabContextMenu: [
        "delete",
        "copy",
        "rename",
        "color",
        "hide",
        "|",
        "move",
        // "focus",
    ], // custom sheet tab right-click menu
    filterContextMenu: [
        "sort-by-asc",
        "sort-by-desc",
        "|",
        "filter-by-color",
        "|",
        // "filter-by-condition",
        // "|",
        "filter-by-value",
    ], // filter context menu
    generateSheetId: () => uuidv4(),
    hooks: {},
    customToolbarItems: [],
    currency: "€",
    fontList: [],
};
