import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { applyPatches, produce } from 'immer';
import type { SetContextOptions } from '../../context';
import { RowColError } from '../../engine/rowcol';
import type { Cell } from '../../engine/types';
import {
    addSheet,
    api,
    type Context,
    collectMatches,
    createFilterOptions,
    deleteRowCol,
    deleteSheet,
    getFlowdata,
    getSheetIndex,
    type Image,
    insertImage,
    insertRowCol,
    type Op,
    opToPatch,
    type Presence,
    type Range,
    removeActiveImage,
    removeImageByMediaName,
    replaceAllMatches,
    replaceImageMediaName,
    replaceSearchMatch,
    revealSearchMatch,
    type SearchHighlight,
    type SearchResult,
    type Settings,
    setSearchHighlights,
    updateImage,
} from '../../state';

export function generateAPIs(
    context: Context,
    setContext: (recipe: (ctx: Context) => void, options?: SetContextOptions) => void,
    handleUndo: () => void,
    handleRedo: () => void,
    settings: Required<Settings>,
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

        insertImage: (mediaName: string, width: number, height: number) =>
            setContext((draftCtx) => insertImage(draftCtx, mediaName, width, height)),

        replaceImageMediaName: (oldName: string, newName: string) =>
            setContext((draftCtx) => replaceImageMediaName(draftCtx, oldName, newName)),

        removeImageByMediaName: (name: string) => setContext((draftCtx) => removeImageByMediaName(draftCtx, name)),

        // ObjectTransform resize/rotate commit + properties-panel numeric edits — one op + undo step
        // each (default setContext).
        updateImage: (id: string, fields: Partial<Pick<Image, 'x' | 'y' | 'width' | 'height' | 'angle'>>) =>
            setContext((draftCtx) => updateImage(draftCtx, id, fields)),

        removeActiveImage: () => setContext((draftCtx) => removeActiveImage(draftCtx)),

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
