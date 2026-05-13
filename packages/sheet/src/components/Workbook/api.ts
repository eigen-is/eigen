import { cloneDeep } from 'es-toolkit/compat';
import { applyPatches } from 'immer';
import type { SetContextOptions } from '../../context';
import { RowColError } from '../../engine';
import type { Cell, CellMatrix } from '../../engine/types';
import {
    addSheet,
    api,
    type CellWithRowAndCol,
    type Context,
    createFilterOptions,
    deleteRowCol,
    deleteSheet,
    getFlowdata,
    getSheetIndex,
    insertImage,
    insertRowCol,
    type Op,
    opToPatch,
    type Presence,
    type Range,
    removeImageByMediaName,
    replaceImageMediaName,
    type Selection,
    type Settings,
    type Sheet,
    type SingleRange,
} from '../../state';

export function generateAPIs(
    context: Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    settings: Required<Settings>,
    cellInput: HTMLDivElement | null,
    scrollbarX: HTMLDivElement | null,
    scrollbarY: HTMLDivElement | null,
) {
    type ApiCall = {
        name: string;
        args: unknown[];
    };
    return {
        applyOp: (ops: Op[]) => {
            setContext(
                (ctx_) => {
                    const [patches, specialOps] = opToPatch(ctx_, ops);
                    for (const specialOp of specialOps) {
                        if (specialOp.op === 'insertRowCol') {
                            try {
                                insertRowCol(ctx_, specialOp.value, false);
                            } catch (e) {
                                if (!(e instanceof RowColError)) throw e;
                                console.warn('[sheet] insertRowCol op skipped:', e.code);
                            }
                        } else if (specialOp.op === 'deleteRowCol') {
                            try {
                                deleteRowCol(ctx_, specialOp.value);
                            } catch (e) {
                                if (!(e instanceof RowColError)) throw e;
                                console.warn('[sheet] deleteRowCol op skipped:', e.code);
                            }
                        } else if (specialOp.op === 'addSheet') {
                            // opToPatch prefixes every immer-patch path with 'sheets', so the
                            // pre-existing `patches.filter(path[0] === 'name')` lookup was always empty.
                            // addSheet pulls the name from `specialOp.value.name` (sheetData) directly.
                            if (specialOp.value?.id) {
                                addSheet(ctx_, settings, specialOp.value.id, false, undefined, specialOp.value);
                            }
                            const fileIndex = getSheetIndex(ctx_, specialOp.value.id) as number;
                            api.initSheetData(ctx_, fileIndex, specialOp.value);
                        } else if (specialOp.op === 'deleteSheet') {
                            deleteSheet(ctx_, specialOp.value.id);
                            patches.length = 0;
                        }
                    }
                    if (ops[0]?.path?.[0] === 'filterRange') ctx_.filterRange = ops[0].value;
                    else if (ops[0]?.path?.[0] === 'hide') {
                        // Hide sheet
                        if (ctx_.currentSheetId === ops[0].id) {
                            const shownSheets = ctx_.sheets.filter(
                                (sheet) => (sheet.hide === undefined || sheet.hide !== 1) && sheet.id !== ops[0].id,
                            );
                            const sorted = [...shownSheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                            if (sorted.length > 0) {
                                ctx_.currentSheetId = sorted[0].id as string;
                            }
                        }
                    }
                    createFilterOptions(ctx_, ctx_.filterRange, ops[0]?.id);
                    if (patches.length === 0) return;
                    try {
                        applyPatches(ctx_, patches);
                    } catch (e) {
                        console.error(e);
                    }
                },
                { noHistory: true },
            );
        },

        getCellValue: (row: number, column: number, options: api.CommonOptions & { type?: keyof Cell } = {}) =>
            api.getCellValue(context, row, column, options),

        setCellValue: (
            row: number,
            column: number,
            value: unknown,
            options: api.CommonOptions & { type?: keyof Cell } = {},
        ) =>
            setContext((draftCtx) =>
                api.setCellValue(
                    draftCtx,
                    row,
                    column,
                    value as Cell | string | number | boolean | null | undefined,
                    cellInput,
                    options,
                ),
            ),

        clearCell: (row: number, column: number, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.clearCell(draftCtx, row, column, options)),

        setCellFormat: (
            row: number,
            column: number,
            attr: keyof Cell,
            value: unknown,
            options: api.CommonOptions = {},
        ) => setContext((draftCtx) => api.setCellFormat(draftCtx, row, column, attr, value, options)),

        autoFillCell: (copyRange: SingleRange, applyRange: SingleRange, direction: 'up' | 'down' | 'left' | 'right') =>
            setContext((draftCtx) => api.autoFillCell(draftCtx, copyRange, applyRange, direction)),

        freeze: (
            type: 'row' | 'column' | 'both',
            range: { row: number; column: number },
            options: api.CommonOptions = {},
        ) => setContext((draftCtx) => api.freeze(draftCtx, type, range, options)),

        insertRowOrColumn: (
            type: 'row' | 'column',
            index: number,
            count: number,
            direction: 'lefttop' | 'rightbottom' = 'rightbottom',
            options: api.CommonOptions = {},
        ) => setContext((draftCtx) => api.insertRowOrColumn(draftCtx, type, index, count, direction, options)),

        deleteRowOrColumn: (type: 'row' | 'column', start: number, end: number, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.deleteRowOrColumn(draftCtx, type, start, end, options)),

        hideRowOrColumn: (rowOrColInfo: string[], type: 'row' | 'column') =>
            setContext((draftCtx) => api.hideRowOrColumn(draftCtx, rowOrColInfo, type)),

        showRowOrColumn: (rowOrColInfo: string[], type: 'row' | 'column') =>
            setContext((draftCtx) => api.showRowOrColumn(draftCtx, rowOrColInfo, type)),

        setRowHeight: (rowInfo: Record<string, number>, options: api.CommonOptions = {}, custom: boolean = false) =>
            setContext((draftCtx) => api.setRowHeight(draftCtx, rowInfo, options, custom)),

        setColumnWidth: (
            columnInfo: Record<string, number>,
            options: api.CommonOptions = {},
            custom: boolean = false,
        ) => setContext((draftCtx) => api.setColumnWidth(draftCtx, columnInfo, options, custom)),

        getRowHeight: (rows: number[], options: api.CommonOptions = {}) => api.getRowHeight(context, rows, options),

        getColumnWidth: (columns: number[], options: api.CommonOptions = {}) =>
            api.getColumnWidth(context, columns, options),

        getSelection: () => api.getSelection(context),

        getFlattenRange: (range: Range) => api.getFlattenRange(context, range),

        getCellsByFlattenRange: (range?: { r: number; c: number }[]) => api.getCellsByFlattenRange(context, range),

        getSelectionCoordinates: () => api.getSelectionCoordinates(context),

        getCellsByRange: (range: Selection, options: api.CommonOptions = {}) =>
            api.getCellsByRange(context, range, options),

        getHtmlByRange: (range: Range, options: api.CommonOptions = {}) => api.getHtmlByRange(context, range, options),

        setSelection: (range: Range, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.setSelection(draftCtx, range, options)),

        setCellValuesByRange: (data: unknown[][], range: SingleRange, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.setCellValuesByRange(draftCtx, data, range, cellInput, options)),

        setCellFormatByRange: (
            attr: keyof Cell,
            value: unknown,
            range: Range | SingleRange,
            options: api.CommonOptions = {},
        ) => setContext((draftCtx) => api.setCellFormatByRange(draftCtx, attr, value, range, options)),

        mergeCells: (ranges: Range, type: string, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.mergeCells(draftCtx, ranges, type, options)),

        cancelMerge: (ranges: Range, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.cancelMerge(draftCtx, ranges, options)),

        getAllSheets: () => api.getAllSheets(context),

        getSheet: (options: api.CommonOptions = {}) => api.getSheetWithLatestCelldata(context, options),

        addSheet: (sheetId?: string) => {
            const existingSheetIds = api.getAllSheets(context).map((sheet) => sheet.id || '');
            if (sheetId && existingSheetIds.includes(sheetId)) {
                console.error(
                    `Failed to add new sheet: A sheet with the id "${sheetId}" already exists. Please use a unique sheet id.`,
                );
            } else {
                setContext((draftCtx) => api.addSheet(draftCtx, settings, sheetId));
            }
        },

        deleteSheet: (options: api.CommonOptions = {}) => setContext((draftCtx) => api.deleteSheet(draftCtx, options)),

        updateSheet: (data: Sheet[]) => setContext((draftCtx) => api.updateSheet(draftCtx, cloneDeep(data))),

        activateSheet: (options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.activateSheet(draftCtx, options)),

        setSheetName: (name: string, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.setSheetName(draftCtx, name, options)),

        setSheetOrder: (orderList: Record<string, number>) =>
            setContext((draftCtx) => api.setSheetOrder(draftCtx, orderList)),

        scroll: (options: { scrollLeft?: number; scrollTop?: number; targetRow?: number; targetColumn?: number }) =>
            api.scroll(context, scrollbarX, scrollbarY, options),

        addPresences: (newPresences: Presence[]) => {
            setContext((draftCtx) => {
                const presenceKey = (v: { username: string; userId?: string }) =>
                    v.userId == null ? v.username : v.userId;
                const newKeys = new Set(newPresences.map(presenceKey));
                draftCtx.presences = (draftCtx.presences || [])
                    .filter((v) => !newKeys.has(presenceKey(v)))
                    .concat(newPresences);
            });
        },

        removePresences: (
            arr: {
                username: string;
                userId?: string;
            }[],
        ) => {
            setContext((draftCtx) => {
                if (draftCtx.presences != null) {
                    const presenceKey = (v: { username: string; userId?: string }) =>
                        v.userId == null ? v.username : v.userId;
                    const removeKeys = new Set(arr.map(presenceKey));
                    draftCtx.presences = draftCtx.presences.filter((v) => !removeKeys.has(presenceKey(v)));
                }
            });
        },

        insertImage: (mediaName: string, width: number, height: number) =>
            setContext((draftCtx) => insertImage(draftCtx, mediaName, width, height)),

        replaceImageMediaName: (oldName: string, newName: string) =>
            setContext((draftCtx) => replaceImageMediaName(draftCtx, oldName, newName)),

        removeImageByMediaName: (name: string) => setContext((draftCtx) => removeImageByMediaName(draftCtx, name)),

        handleUndo,
        handleRedo,

        getFlowdata: (id?: string | null) => getFlowdata(context, id),

        calculateFormula: (id?: string, range?: SingleRange) => {
            setContext((draftCtx) => {
                api.calculateFormula(draftCtx, id, range);
            });
        },

        dataToCelldata: (data: CellMatrix | undefined) => {
            return api.dataToCelldata(data);
        },

        celldataToData: (celldata: CellWithRowAndCol[], rowCount?: number, colCount?: number) => {
            return api.celldataToData(celldata, rowCount, colCount);
        },

        batchCallApis: (apiCalls: ApiCall[]) => {
            setContext((draftCtx) => {
                for (const apiCall of apiCalls) {
                    const { name, args } = apiCall;
                    const fn = (api as unknown as Record<string, (...fnArgs: unknown[]) => unknown>)[name];
                    if (typeof fn === 'function') {
                        fn(draftCtx, ...args);
                    } else {
                        console.warn(`API ${name} does not exist`);
                    }
                }
            });
        },
    };
}
