// The Workbook's imperative API, what a host app calls through the Workbook's ref: a peer's ops, undo and redo, the
// floating images and charts, search and replace. Its writes run as recipes on the workbook's context, as the
// editor's own edits do.

import type { CellRangeRef, ChartLook, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import type { Box, ZOp } from '@workspace/lib/vector';
import { current, produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type { SetContextOptions } from '../../context';
import type { ChartRangeRefusal } from '../../engine/chart-range';
import { setUpChartRange } from '../../engine/chart-range';
import type { Cell } from '../../engine/types';
import type {
    ChartInsertBox,
    Context,
    FloatingRef,
    GlobalCache,
    Op,
    Presence,
    Range,
    SearchHighlight,
    SearchResult,
} from '../../state';
import {
    api,
    applyOpBatch,
    collectMatches,
    createContextResolver,
    deleteFloatingObject,
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
    shiftEntries,
    updateFloatingBox,
} from '../../state';

export function generateAPIs(
    context: Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    history: Pick<GlobalCache, 'undoList' | 'redoList'>,
) {
    return {
        applyOp: (ops: Op[]) => {
            // A peer's row or column op moves the cells under this tab's undo and redo entries. They shift now, in
            // call order, so an undo called before this batch keeps the entry it was called with.
            for (const op of ops) {
                if (op.op !== 'insertRowCol' && op.op !== 'deleteRowCol') continue;
                history.undoList = shiftEntries(history.undoList, op, context.sheets, 'undo');
                history.redoList = shiftEntries(history.redoList, op, context.sheets, 'redo');
            }
            setContext(
                (ctx_) => {
                    const next = applyOpBatch(current(ctx_), ops);
                    if (next) Object.assign(ctx_, next);
                },
                { noHistory: true },
            );
        },

        setCellFormat: (
            row: number,
            column: number,
            attr: keyof Cell,
            value: unknown,
            options: api.CommonOptions = {},
        ) => setContext((draftCtx) => api.setCellFormat(draftCtx, row, column, attr, value, options)),

        setSelection: (range: Range, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.setSelection(draftCtx, range, options)),

        mergeCells: (ranges: Range, type: string, options: api.CommonOptions = {}) =>
            setContext((draftCtx) => api.mergeCells(draftCtx, ranges, type, options)),

        getAllSheets: () => api.getAllSheets(context),

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

        insertImage: (mediaName: string, width: number, height: number, angle?: number) =>
            setContext((draftCtx) => insertImage(draftCtx, mediaName, width, height, angle)),

        // Pending→real swap after an upload/paste settles — a technical fixup, never the user's own
        // undo step (noUndo emits the op to peers but records no local undo entry).
        replaceImageMediaName: (oldName: string, newName: string) => {
            setContext((draftCtx) => replaceImageMediaName(draftCtx, oldName, newName), { noUndo: true });
            replaceMediaNameInHistory(history, oldName, newName);
        },

        removeImageByMediaName: (name: string) =>
            setContext((draftCtx) => removeImageByMediaName(draftCtx, name), { noUndo: true }),

        // A move, the ObjectTransform resize/rotate commit and a properties-panel numeric edit: one op and
        // undo step each.
        updateFloatingBox: (ref: FloatingRef, fields: Partial<Box>) =>
            setContext((draftCtx) => updateFloatingBox(draftCtx, ref, fields)),

        reorderFloatingObject: (ref: FloatingRef, op: ZOp) =>
            setContext((draftCtx) => reorderFloatingObject(draftCtx, ref, op)),

        deleteFloatingObject: (ref: FloatingRef) => setContext((draftCtx) => deleteFloatingObject(draftCtx, ref)),

        // One op + undo step each, on the current sheet. The id is made here so the caller can
        // select the new chart; the recipe runs later, so a dry run on this state tells a viewer or
        // a missing sheet apart, which inserts nothing and returns null.
        insertChart: (box: ChartInsertBox, spec: ChartSpec): string | null => {
            const id = uuidv4();
            const recipe = (draftCtx: Context) => insertChart(draftCtx, id, box, spec);
            if (produce(context, recipe) === context) return null;
            setContext(recipe);
            return id;
        },

        setChartSpec: (id: string, change: ChartSpecChange) =>
            setContext((draftCtx) => setChartSpec(draftCtx, id, change)),

        setChartLook: (id: string, look: Partial<ChartLook>) =>
            setContext((draftCtx) => setChartLook(draftCtx, id, look)),

        // Sets the range up, or says why it holds no chart and writes nothing.
        setChartDataRange: (id: string, ref: CellRangeRef): ChartRangeRefusal | undefined => {
            const setup = setUpChartRange(ref, createContextResolver(context));
            if (typeof setup === 'string') return setup;
            setContext((draftCtx) => setChartDataRange(draftCtx, id, ref));
        },

        // Opens one undo step for a panel edit and returns its release (PropertyGestureContext).
        beginGesture: () => {
            const gesture = {};
            const cache = context.getRefs().globalCache;
            cache.undoGesture = gesture;
            return () => {
                if (cache.undoGesture === gesture) cache.undoGesture = undefined;
            };
        },

        undo: handleUndo,
        redo: handleRedo,

        getFlowdata: (id?: string | null) => getFlowdata(context, id),

        searchAll: (query: string, opts: DocSearchOptions): SearchResult[] => collectMatches(context, query, opts),

        setSearchHighlights: (cells: SearchHighlight[]) =>
            setContext((draftCtx) => setSearchHighlights(draftCtx, cells), { noHistory: true }),

        revealSearchMatch: (cell: SearchHighlight) =>
            setContext((draftCtx) => revealSearchMatch(draftCtx, cell), { noHistory: true }),

        // Replace rewrites every occurrence in the one targeted cell; replaceAll sweeps every match —
        // each in ONE setContext recipe (one undo, one op batch). React state updates a render later,
        // so the fresh post-edit match list is computed on a synchronously produced next-state (the
        // same pure recipe) and returned; the provider adopts it instead of re-searching stale state.
        replace: (
            cell: SearchHighlight,
            query: string,
            replacement: string,
            opts: DocSearchOptions,
            preserveCase: boolean,
        ): SearchResult[] => {
            const recipe = (ctx_: Context) => {
                replaceSearchMatch(ctx_, cell, query, replacement, opts, preserveCase);
            };
            setContext(recipe);
            return collectMatches(produce(context, recipe), query, opts);
        },

        replaceAll: (
            query: string,
            replacement: string,
            opts: DocSearchOptions,
            preserveCase: boolean,
        ): { replaced: number; matches: SearchResult[] } => {
            let replaced = 0;
            const recipe = (ctx_: Context) => {
                replaced = replaceAllMatches(ctx_, query, replacement, opts, preserveCase);
            };
            setContext(recipe);
            const next = produce(context, recipe);
            return { replaced, matches: collectMatches(next, query, opts) };
        },
    };
}
