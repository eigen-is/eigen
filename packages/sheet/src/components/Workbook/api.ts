// The Workbook's imperative API, what a host app calls through the Workbook's ref: a peer's ops and a replay of the op
// log, undo and redo, the floating images and charts, search and replace. Its writes run as recipes on the workbook's
// context, as the editor's own edits do. A write applies at its call, so a read right after it, such as getFlowdata,
// sees it.

import type { CellRangeRef, ChartLook, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import type { Box, ZOp } from '@workspace/lib/vector';
import { current } from 'immer';
import type { SetContextOptions } from '../../context';
import type { ChartRangeRefusal } from '../../engine/chart-range';
import { setUpChartRange } from '../../engine/chart-range';
import { isRowColOp } from '../../engine/replay-ops';
import type { Cell } from '../../engine/types';
import type {
    ChartInsertBox,
    Context,
    FloatingRef,
    GlobalCache,
    Op,
    Presence,
    SearchHighlight,
    SearchResult,
    Sheet,
} from '../../state';
import {
    api,
    applyOpBatch,
    cancelNormalSelected,
    collectMatches,
    createContextResolver,
    deleteFloatingObject,
    dropStructuralEntries,
    getFlowdata,
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
    warmFormulaCellInfoMapOnIdle,
} from '../../state';

export function generateAPIs(
    getContext: () => Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    history: Pick<GlobalCache, 'undoList' | 'redoList' | 'undoGesture'>,
) {
    return {
        // True when the batch applied, false when an op failed and the whole batch was rolled back.
        applyOp: (ops: Op[]): boolean => {
            let accepted = false;
            setContext(
                (ctx_) => {
                    const applied = applyOpBatch(current(ctx_), ops);
                    if (!applied) return;
                    accepted = true;
                    Object.assign(ctx_, applied.ctx);
                    history.undoList = dropStructuralEntries(history.undoList);
                    history.redoList = dropStructuralEntries(history.redoList);
                    for (const { op, sheets } of applied.moved) {
                        history.undoList = shiftEntries(history.undoList, op, sheets);
                        history.redoList = shiftEntries(history.redoList, op, sheets);
                    }
                },
                { noHistory: true },
            );
            return accepted;
        },

        // Puts the workbook back to `base`, sheets an earlier getAllSheets returned, and applies `batches` on it in
        // order. The tab's view moved with the batches it applied before, so only the `fresh` ones move it again. A
        // fresh batch that moves a sheet's rows ahead of an applied one that moves them leaves the tab unable to tell
        // where its selection on that sheet went, so it goes, and on the current sheet the editor too. The undo and redo
        // entries fit an order that is gone, so both stacks empty. True when every batch applied.
        replayOps: (base: Sheet[], batches: Op[][], fresh: ReadonlySet<Op[]>): boolean => {
            let accepted = true;
            const { currentSheetId } = getContext();
            const overtaken = (sheetId: string) => {
                const movesRows = (ops: Op[]) => ops.some((op) => isRowColOp(op) && op.id === sheetId);
                const firstMove = batches.findIndex((ops) => fresh.has(ops) && movesRows(ops));
                return firstMove !== -1 && batches.slice(firstMove).some((ops) => !fresh.has(ops) && movesRows(ops));
            };
            const lost = overtaken(currentSheetId);
            // The formula engine starts empty, so the replay skips the formula map, and it is built once the browser
            // is idle.
            getContext().formulaCache.resetEngine();
            setContext(
                (ctx_) => {
                    if (lost) {
                        cancelNormalSelected(ctx_);
                        ctx_.selections = undefined;
                    }
                    for (const [sheetId, left] of Object.entries(ctx_.sheetViewRecord)) {
                        if (overtaken(sheetId)) left.selections = undefined;
                    }
                    let next: Context = { ...current(ctx_), sheets: base };
                    for (const ops of batches) {
                        const applied = applyOpBatch(next, ops, fresh.has(ops));
                        if (applied) next = applied.ctx;
                        else accepted = false;
                    }
                    Object.assign(ctx_, next);
                    settleCurrentSheet(ctx_);
                },
                { noHistory: true },
            );
            if (lost) getContext().getRefs().cellInput.current?.blur();
            warmFormulaCellInfoMapOnIdle(getContext);
            history.undoList = [];
            history.redoList = [];
            return accepted;
        },

        setCellFormat: <K extends keyof Cell>(
            row: number,
            column: number,
            attr: K,
            value: Cell[K],
            options: api.SheetLookup = {},
        ) => setContext((draftCtx) => api.setCellFormat(draftCtx, row, column, attr, value, options)),

        getAllSheets: () => api.getAllSheets(getContext()),

        addPresences: (newPresences: Presence[]) => {
            setContext((draftCtx) => {
                const newKeys = new Set(newPresences.map(presenceKey));
                draftCtx.presences = (draftCtx.presences ?? [])
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
                    const removeKeys = new Set(arr.map(presenceKey));
                    draftCtx.presences = draftCtx.presences.filter((v) => !removeKeys.has(presenceKey(v)));
                }
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
            const setup = setUpChartRange(ref, createContextResolver(getContext()));
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

        // Replace rewrites every occurrence in one cell, and replaceAll every match. Each is one recipe, so one undo
        // step and one op batch. Both return the matches the edit leaves, which the provider adopts without a search.
        replace: (
            cell: SearchHighlight,
            query: string,
            replacement: string,
            opts: DocSearchOptions,
            preserveCase: boolean,
        ): SearchResult[] => {
            setContext((ctx_) => {
                replaceSearchMatch(ctx_, cell, query, replacement, opts, preserveCase);
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
            setContext((ctx_) => {
                replaced = replaceAllMatches(ctx_, query, replacement, opts, preserveCase);
            });
            return { replaced, matches: collectMatches(getContext(), query, opts) };
        },
    };
}

// A collaborator's key: the user id, or the name for a presence that has none.
const presenceKey = (presence: { username: string; userId?: string }) => presence.userId ?? presence.username;
