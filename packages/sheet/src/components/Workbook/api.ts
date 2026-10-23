import type { CellRangeRef, ChartLook, ChartSpec } from '@workspace/lib/types/chart';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import type { Box, ZOp } from '@workspace/lib/vector';
import { applyPatches, produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type { SetContextOptions } from '../../context';
import { type ChartRangeRefusal, setUpChartRange } from '../../engine/chart-range';
import { RowColError } from '../../engine/rowcol';
import type { Cell } from '../../engine/types';
import {
    addSheet,
    api,
    type ChartInsertBox,
    type Context,
    collectMatches,
    createContextResolver,
    createFilterOptions,
    deleteActiveObject,
    deleteFloatingObject,
    deleteRowCol,
    deleteSheet,
    type FloatingRef,
    type GlobalCache,
    getFlowdata,
    getSheetIndex,
    insertChart,
    insertImage,
    insertRowCol,
    leaveCurrentSheet,
    type Op,
    opToPatch,
    type Presence,
    type Range,
    registerSheetFormulas,
    removeImageByMediaName,
    reorderFloatingObject,
    replaceAllMatches,
    replaceImageMediaName,
    replaceMediaNameInHistory,
    replaceSearchMatch,
    revealSearchMatch,
    type SearchHighlight,
    type SearchResult,
    type Settings,
    selectFloatingObject,
    setChartDataRange,
    setChartLook,
    setChartSpec,
    setSearchHighlights,
    updateFloatingBox,
} from '../../state';

export function generateAPIs(
    context: Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    settings: Required<Settings>,
    history: Pick<GlobalCache, 'undoList' | 'redoList'>,
) {
    return {
        applyOp: (ops: Op[]) => {
            setContext(
                (ctx_) => {
                    const [patches, specialOps] = opToPatch(ctx_, ops);
                    for (const specialOp of specialOps) {
                        if (specialOp.op === 'insertRowCol') {
                            try {
                                // force: this is an authoritative remote op — mirror the data shift
                                // even for read-only viewers, or the grid diverges from the metadata
                                // patches applied below (api.ts).
                                insertRowCol(ctx_, specialOp.value, false, true);
                            } catch (e) {
                                if (!(e instanceof RowColError)) throw e;
                                console.warn('[sheet] insertRowCol op skipped:', e.code);
                            }
                        } else if (specialOp.op === 'deleteRowCol') {
                            try {
                                deleteRowCol(ctx_, specialOp.value, true);
                            } catch (e) {
                                if (!(e instanceof RowColError)) throw e;
                                console.warn('[sheet] deleteRowCol op skipped:', e.code);
                            }
                        } else if (specialOp.op === 'addSheet') {
                            // The name comes from sheetData: opToPatch prefixes every patch path with 'sheets'.
                            if (specialOp.value.id) {
                                addSheet(ctx_, settings, specialOp.value.id, false, undefined, specialOp.value, true);
                            }
                            const { id } = specialOp.value;
                            const fileIndex = getSheetIndex(ctx_, id);
                            if (fileIndex == null) continue;
                            registerSheetFormulas(ctx_, id, api.initSheetData(ctx_, fileIndex, specialOp.value));
                        } else if (specialOp.op === 'deleteSheet') {
                            deleteSheet(ctx_, specialOp.value.id, true);
                            patches.length = 0;
                        }
                    }
                    if (ops[0]?.path?.[0] === 'filterRange') ctx_.filterRange = ops[0].value;
                    else if (ops[0]?.path?.[0] === 'hide' && ops[0].id === ctx_.currentSheetId) {
                        leaveCurrentSheet(ctx_, ops[0].id);
                    }
                    createFilterOptions(ctx_, ctx_.filterRange, ops[0]?.id);
                    if (patches.length === 0) return;
                    try {
                        applyPatches(ctx_, patches);
                    } catch (e) {
                        console.error(e);
                    }
                    ctx_.formulaCache.updateFormulaCache(ctx_, { patches, inversePatches: [] }, 'redo');
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

        deleteActiveObject: () => setContext(deleteActiveObject),

        openChartEditor: (id: string) =>
            setContext((draftCtx) => selectFloatingObject(draftCtx, { kind: 'chart', id }, true)),

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

        setChartSpec: (id: string, spec: ChartSpec) => setContext((draftCtx) => setChartSpec(draftCtx, id, spec)),

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
