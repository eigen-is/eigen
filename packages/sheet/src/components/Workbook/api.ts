// The Workbook's imperative API, what a host app calls through the Workbook's ref: a peer's ops and a replay of the op
// log, undo and redo, the floating images and charts, search and replace. Its writes run as recipes on the workbook's
// context, as the editor's own edits do. A write applies at its call, so a read right after it, such as getFlowdata,
// sees it.

import type { CellRangeRef, ChartLook, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import type { Box, ZOp } from '@workspace/lib/vector';
import { current } from 'immer';
import type { SetContextOptions } from '../../context';
import { createArrayResolver } from '../../engine/cell-resolver';
import type { ChartRangeRefusal } from '../../engine/chart-range';
import { setUpChartRange } from '../../engine/chart-range';
import { isRowColOp } from '../../engine/replay-ops';
import type { Cell } from '../../engine/types';
import type {
    ChartInsertBox,
    Context,
    FloatingRef,
    GlobalCache,
    History,
    Op,
    Presence,
    SearchHighlight,
    SearchResult,
    Selection,
    Sheet,
} from '../../state';
import {
    api,
    applyOpBatch,
    cancelNormalSelected,
    collectMatches,
    deleteFloatingObject,
    dropStructuralEntries,
    getFlowdata,
    initSheetData,
    insertChart,
    insertImage,
    removeImageByMediaName,
    reorderFloatingObject,
    replaceAllMatches,
    replaceImageMediaName,
    replaceMediaNameInHistory,
    replaceSearchMatch,
    revealSearchMatch,
    setChartDataRange,
    setChartLook,
    setChartSpec,
    setSearchHighlights,
    settleCurrentSheet,
    shiftEntries,
    updateFloatingBox,
    warmFormulaGraphOnIdle,
} from '../../state';

type Stacks = Pick<GlobalCache, 'undoList' | 'redoList' | 'cutByPeer'>;

// A peer's batch only ever shortens a stack, so a shorter one is a stack it took something from.
function setStacksAfterPeer(history: Stacks, undoList: History[], redoList: History[]) {
    history.cutByPeer = {
        undo: history.cutByPeer?.undo || undoList.length < history.undoList.length,
        redo: history.cutByPeer?.redo || redoList.length < history.redoList.length,
    };
    history.undoList = undoList;
    history.redoList = redoList;
}

function holdsSelections(sheets: Sheet[], sheetId: string, selections: Selection[] | undefined): boolean {
    if (!selections) return true;
    const data = sheets.find(({ id }) => id === sheetId)?.data;
    return data != null && selections.every(({ row, column }) => row[1] < data.length && column[1] < data[0].length);
}

export function generateAPIs(
    getContext: () => Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    history: Stacks & Pick<GlobalCache, 'undoGesture'>,
) {
    return {
        // A batch with an op that fails is rolled back whole.
        applyOp: (ops: Op[]) => {
            const selected = getContext().selections != null;
            setContext(
                (draftCtx) => {
                    const applied = applyOpBatch(current(draftCtx), ops);
                    if (!applied) return;
                    Object.assign(draftCtx, applied.ctx);
                    // An entry holds formula text naming tabs, so a peer's rename empties both stacks. It is rare.
                    if (ops.some(({ op }) => op === 'renameSheet')) {
                        setStacksAfterPeer(history, [], []);
                        return;
                    }
                    let undoList = dropStructuralEntries(history.undoList);
                    let redoList = dropStructuralEntries(history.redoList);
                    for (const { move, sheets } of applied.moved) {
                        undoList = shiftEntries(undoList, move, sheets);
                        redoList = shiftEntries(redoList, move, sheets);
                    }
                    setStacksAfterPeer(history, undoList, redoList);
                },
                { noHistory: true },
            );
            // A delete of the editor's cell drops the selection, and the grid gives up the focus too, as a replay
            // that loses the selection does, so a keystroke writes nowhere.
            if (selected && !getContext().selections) getContext().getRefs().cellInput.current?.blur();
        },

        // Only the `fresh` batches move the view again, and the undo and redo entries fit an order that is gone, so
        // both stacks empty.
        replayOps: (base: Sheet[], batches: Op[][], fresh: ReadonlySet<Op[]>) => {
            // A fresh batch that moves rows ahead of an applied one: the tab can't tell where a selection there went.
            const overtaken = (sheetId: string) => {
                const movesRows = (ops: Op[]) => ops.some((op) => isRowColOp(op) && op.id === sheetId);
                const firstMove = batches.findIndex((ops) => fresh.has(ops) && movesRows(ops));
                return firstMove !== -1 && batches.slice(firstMove).some((ops) => !fresh.has(ops) && movesRows(ops));
            };
            // The formula engine starts empty, so a replay of cell edits builds no formula graph, and it is built once
            // the browser is idle. A batch with a sheet or row op builds it for its recompute.
            getContext().formulaCache.resetEngine();
            setContext(
                (draftCtx) => {
                    // Sheets decoded from a snapshot hold no matrix yet, so they enter as at the mount.
                    const sheets = base.map((sheet) => ({ ...sheet }));
                    for (const sheet of sheets) initSheetData(sheet);
                    let next: Context = { ...current(draftCtx), sheets };
                    for (const ops of batches) {
                        const applied = applyOpBatch(next, ops, fresh.has(ops));
                        if (applied) next = applied.ctx;
                    }
                    Object.assign(draftCtx, next);
                    // A new snapshot's grid can end before a selection made on the old one, which then has no cell.
                    const lost = (sheetId: string, selections: Selection[] | undefined) =>
                        overtaken(sheetId) || !holdsSelections(next.sheets, sheetId, selections);
                    if (lost(next.currentSheetId, next.selections)) {
                        cancelNormalSelected(draftCtx);
                        draftCtx.selections = undefined;
                    }
                    for (const [sheetId, left] of Object.entries(draftCtx.sheetViewRecord)) {
                        if (lost(sheetId, left.selections)) left.selections = undefined;
                    }
                    settleCurrentSheet(draftCtx);
                },
                { noHistory: true },
            );
            if (!getContext().selections) getContext().getRefs().cellInput.current?.blur();
            warmFormulaGraphOnIdle(getContext);
            setStacksAfterPeer(history, [], []);
        },

        setCellFormat: <K extends keyof Cell>(
            row: number,
            column: number,
            attr: K,
            value: Cell[K],
            options: api.SheetLookup = {},
        ) => setContext((draftCtx) => api.setCellFormat(draftCtx, row, column, attr, value, options)),

        getAllSheets: () => getContext().sheets,

        // The live set, whole each time, so a window that left is gone.
        setPresences: (presences: Presence[]) => {
            setContext((draftCtx) => {
                draftCtx.presences = presences;
            });
        },

        insertImage: (mediaName: string, width: number, height: number, angle?: number) =>
            setContext((draftCtx) => insertImage(draftCtx, mediaName, width, height, angle)),

        // Swaps a pending image for the stored one once its upload or paste settles. That is a fixup, not the user's
        // step, so noUndo sends the op to peers and records no undo entry.
        replaceImageMediaName: (oldName: string, newName: string) => {
            setContext((draftCtx) => replaceImageMediaName(draftCtx, oldName, newName), { noUndo: true });
            replaceMediaNameInHistory(history, oldName, newName);
        },

        removeImageByMediaName: (name: string) =>
            setContext((draftCtx) => removeImageByMediaName(draftCtx, name), { noUndo: true }),

        // One op and one undo step, such as a move, a resize or rotate from the grips, or a number typed in the
        // properties panel.
        updateFloatingBox: (ref: FloatingRef, fields: Partial<Box>) =>
            setContext((draftCtx) => updateFloatingBox(draftCtx, ref, fields)),

        reorderFloatingObject: (ref: FloatingRef, op: ZOp) =>
            setContext((draftCtx) => reorderFloatingObject(draftCtx, ref, op)),

        deleteFloatingObject: (ref: FloatingRef) => setContext((draftCtx) => deleteFloatingObject(draftCtx, ref)),

        // One op and one undo step on the current sheet. The id is made here so the caller can select the new chart.
        // A viewer or a missing sheet inserts nothing and returns null.
        insertChart: (box: ChartInsertBox, spec: ChartSpec): string | null => {
            const id = crypto.randomUUID();
            const { sheets } = getContext();
            setContext((draftCtx) => insertChart(draftCtx, id, box, spec));
            return getContext().sheets === sheets ? null : id;
        },

        setChartSpec: (id: string, change: ChartSpecChange) =>
            setContext((draftCtx) => setChartSpec(draftCtx, id, change)),

        setChartLook: (id: string, look: Partial<ChartLook>) =>
            setContext((draftCtx) => setChartLook(draftCtx, id, look)),

        // Sets the range up, or says why it holds no chart and writes nothing.
        setChartDataRange: (id: string, ref: CellRangeRef): ChartRangeRefusal | undefined => {
            const setup = setUpChartRange(ref, createArrayResolver(getContext().sheets));
            if (typeof setup === 'string') return setup;
            setContext((draftCtx) => setChartDataRange(draftCtx, id, ref));
        },

        // Opens one undo step that every write of a panel edit joins, and returns the function that closes it.
        beginGesture: () => {
            const gesture = {};
            history.undoGesture = gesture;
            return () => {
                if (history.undoGesture === gesture) history.undoGesture = undefined;
            };
        },

        undo: handleUndo,
        redo: handleRedo,

        getFlowdata: (id?: string | null) => getFlowdata(getContext(), id),

        searchAll: (query: string, opts: DocSearchOptions): SearchResult[] => collectMatches(getContext(), query, opts),

        setSearchHighlights: (cells: SearchHighlight[]) =>
            setContext((draftCtx) => setSearchHighlights(draftCtx, cells), { noHistory: true }),

        revealSearchMatch: (cell: SearchHighlight) =>
            setContext((draftCtx) => revealSearchMatch(draftCtx, cell), { noHistory: true }),

        // Gives the keys back to the grid after a control outside it took the focus.
        focusGrid: () => getContext().getRefs().cellInput.current?.focus({ preventScroll: true }),

        // Replace rewrites every occurrence in one cell, and replaceAll every match. Each is one recipe, so one undo
        // step and one op batch. Both return the matches the edit leaves, which the provider adopts without a search.
        replace: (
            cell: SearchHighlight,
            query: string,
            replacement: string,
            opts: DocSearchOptions,
            preserveCase: boolean,
        ): SearchResult[] => {
            setContext((draftCtx) => {
                replaceSearchMatch(draftCtx, cell, query, replacement, opts, preserveCase);
            });
            return collectMatches(getContext(), query, opts);
        },

        replaceAll: (
            query: string,
            replacement: string,
            opts: DocSearchOptions,
            preserveCase: boolean,
        ): { replaced: number; matches: SearchResult[] } => {
            let replaced = 0;
            setContext((draftCtx) => {
                replaced = replaceAllMatches(draftCtx, query, replacement, opts, preserveCase);
            });
            return { replaced, matches: collectMatches(getContext(), query, opts) };
        },
    };
}
