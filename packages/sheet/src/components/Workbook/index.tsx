import {
    buildImageClipboardItem,
    buildTextClipboardItem,
    classifyPaste,
    clipboardTextItemHasContent,
    svgToImageFile,
    writeEigenClipboard,
} from '@workspace/lib/clipboard';
import type {
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import { cloneDeep } from 'es-toolkit/compat';
import { applyPatches, enablePatches, type Patch, produce, produceWithPatches } from 'immer';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { type RefValues, type SetContextOptions, WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { normalizeSheetConfig } from '../../engine/replay-ops';
import type { CellMatrix } from '../../engine/types';
import {
    api,
    type CellWithRowAndCol,
    COPY_ACTION_TABLE_MARKER,
    type Context,
    defaultContext,
    defaultSettings,
    ensureSheetIndex,
    filterPatch,
    type GlobalCache,
    getFlowdata,
    getSheetIndex,
    groupValuesRefresh,
    handleGlobalKeyDown,
    handlePaste,
    initSheetIndex,
    insertRowCol,
    inverseRowColOptions,
    type Op,
    patchToOp,
    type Settings,
    type Sheet as SheetType,
    warmFormulaCellInfoMap,
} from '../../state';
import { consumePendingCopy } from '../../state/modules/clipboard';
import { FilterMenu } from '../ContextMenu/FilterMenu';
import { FxEditor } from '../FxEditor';
import { MenuBar } from '../MenuBar';
import { Sheet } from '../Sheet';
import { SheetTab } from '../SheetTab';
import { generateAPIs } from './api';

enablePatches();

export type WorkbookInstance = ReturnType<typeof generateAPIs>;

type AdditionalProps = {
    onChange?: (data: SheetType[]) => void;
    onOp?: (op: Op[]) => void;
    toolbarLeftItems?: React.ReactNode;
    toolbarRightItems?: React.ReactNode;
};

// The copied cell range as a text item. Every clipboard item carries its rendered box, and sheets'
// document-space units are px (no zoom), so the cumulative edge arrays give both dims directly. The
// anchor cell's font size rides along so a consumer that honours the box (slides) renders the text
// at the size it had here rather than at its own much larger default, which the box would clip.
// A staged copy always has a selection (handleCopy bails without one); the [0, 0] only satisfies TS.
function buildCellRangeClipboardItem(ctx: Context, text: string): EigenClipboardTextItem {
    const [r1, r2] = ctx.selections?.[0]?.row ?? [0, 0];
    const [c1, c2] = ctx.selections?.[0]?.column ?? [0, 0];
    return buildTextClipboardItem({
        text,
        box: {
            width: ctx.visibledatacolumn[c2] - (c1 === 0 ? 0 : ctx.visibledatacolumn[c1 - 1]),
            height: ctx.visibledatarow[r2] - (r1 === 0 ? 0 : ctx.visibledatarow[r1 - 1]),
        },
        typography: { fontSize: getFlowdata(ctx)?.[r1]?.[c1]?.fs ?? 10 }, // 10 = the default cell size
    });
}

const triggerGroupValuesRefresh = (ctx: Context) => {
    if (ctx.groupValuesRefreshData.length > 0) {
        groupValuesRefresh(ctx);
    }
};

const concatProducer = (...producers: ((ctx: Context) => void)[]) => {
    return (ctx: Context) => {
        for (const producer of producers) {
            producer(ctx);
        }
    };
};

function dataToCelldata(data: CellMatrix) {
    const cellData: CellWithRowAndCol[] = [];
    for (let row = 0; row < data?.length; row += 1) {
        for (let col = 0; col < data[row]?.length; col += 1) {
            if (data[row][col] !== null) {
                cellData.push({
                    r: row,
                    c: col,
                    v: data[row][col],
                });
            }
        }
    }
    return cellData;
}

function reduceUndoList(ctx: Context, ctxBefore: Context, globalCache: React.MutableRefObject<GlobalCache>) {
    const sheetsId = ctx.sheets.map((sheet) => sheet.id);
    const sheetDeletedByMe = globalCache.current.undoList
        .filter((undo) => undo.options?.deleteSheetOp)
        .map((item) => item.options?.deleteSheetOp?.id);
    globalCache.current.undoList = globalCache.current.undoList.filter(
        (undo) =>
            undo.options?.deleteSheetOp ||
            undo.options?.id === undefined ||
            sheetsId.indexOf(undo.options?.id) !== -1 ||
            sheetDeletedByMe.indexOf(undo.options?.id) !== -1,
    );
    if (ctxBefore.sheets.length > ctx.sheets.length) {
        const sheetDeleted = ctxBefore.sheets
            .filter((oneSheet) => sheetsId.indexOf(oneSheet.id) === -1)
            .map((item) => getSheetIndex(ctxBefore, item.id as string));
        const deletedIndex = sheetDeleted[0];
        globalCache.current.undoList = globalCache.current.undoList.map((oneStep) => {
            oneStep.patches = oneStep.patches.map((onePatch) => {
                if (typeof onePatch.path[1] === 'number' && onePatch.path[1] > (deletedIndex as number)) {
                    onePatch.path[1] -= 1;
                }
                return onePatch;
            });
            oneStep.inversePatches = oneStep.inversePatches.map((onePatch) => {
                if (typeof onePatch.path[1] === 'number' && onePatch.path[1] > (deletedIndex as number)) {
                    onePatch.path[1] -= 1;
                }
                return onePatch;
            });
            return oneStep;
        });
    }
}

export const Workbook = React.forwardRef<WorkbookInstance, Settings & AdditionalProps>(
    ({ onChange, onOp, toolbarLeftItems, toolbarRightItems, data: originalData, ...props }, ref) => {
        const scrollListeners = useRef(new Set<() => void>());
        const globalCache = useRef<GlobalCache>({
            undoList: [],
            redoList: [],
            scrollLeft: 0,
            scrollTop: 0,
            scrollListeners: scrollListeners.current,
            notifyScrollListeners: () => {
                for (const fn of scrollListeners.current) fn();
            },
        });
        const cellInput = useRef<HTMLDivElement>(null);
        const fxInput = useRef<HTMLDivElement>(null);
        const canvas = useRef<HTMLCanvasElement>(null);
        const cellArea = useRef<HTMLDivElement>(null);
        const workbookContainer = useRef<HTMLDivElement>(null);

        const refs: RefValues = useMemo(
            () => ({
                globalCache: globalCache.current,
                cellInput,
                fxInput,
                canvas,
                cellArea,
                workbookContainer,
            }),
            [],
        );

        const [context, setContext] = useState(defaultContext(refs));

        // biome-ignore lint/correctness/useExhaustiveDependencies: deps spread from Object.values(props) — biome can't see through the spread
        const mergedSettings = useMemo(
            () => Object.assign(cloneDeep(defaultSettings), props) as Required<Settings>,
            [...Object.values(props)],
        );

        // Build the formula dependency map off the interaction path once the sheet
        // has loaded, so the first edit on a large workbook doesn't pay the
        // multi-second inline rebuild. One-shot per mount; no-op if an edit already
        // built the map.
        const warmSheetIdx = getSheetIndex(context, context.currentSheetId);
        const dataReady = warmSheetIdx != null && (context.sheets?.[warmSheetIdx]?.data?.length ?? 0) > 0;
        // biome-ignore lint/correctness/useExhaustiveDependencies: warm once when data first loads; depending on `context` would re-run and cancel the scheduled idle build on every selection change
        useEffect(() => {
            if (!dataReady) return;
            const run = () => warmFormulaCellInfoMap(context);
            if (typeof requestIdleCallback === 'function') {
                const id = requestIdleCallback(run, { timeout: 2000 });
                return () => cancelIdleCallback(id);
            }
            const id = setTimeout(run, 200);
            return () => clearTimeout(id);
        }, [dataReady]);

        const emitOp = useCallback(
            (ctx: Context, patches: Patch[], options?: SetContextOptions, undo: boolean = false) => {
                if (onOp) {
                    onOp(patchToOp(ctx, patches, options, undo));
                }
            },
            [onOp],
        );

        const setContextWithProduce = useCallback(
            (recipe: (ctx: Context) => void, options: SetContextOptions = {}) => {
                setContext((ctx_) => {
                    // Sync scroll position from globalCache into the immer draft.
                    // Scroll state lives in globalCache to avoid re-rendering all
                    // context consumers on every scroll tick. We lazily sync it here
                    // so that business logic (e.g. handleCellAreaMouseDown) that reads
                    // ctx.scrollLeft/ctx.scrollTop inside recipes gets fresh values.
                    const syncScroll = (ctx: Context) => {
                        ctx.scrollLeft = globalCache.current.scrollLeft;
                        ctx.scrollTop = globalCache.current.scrollTop;
                    };

                    // Fast path: skip expensive produceWithPatches when no undo
                    // history is needed (e.g. mouse-move during drag selection).
                    // produceWithPatches generates JSON patches for every mutation,
                    // but selection changes are filtered out by filterPatch anyway.
                    if (options.noHistory) {
                        return produce(ctx_, concatProducer(syncScroll, recipe, triggerGroupValuesRefresh));
                    }

                    const [result, patches, inversePatches] = produceWithPatches(
                        ctx_,
                        concatProducer(syncScroll, recipe, triggerGroupValuesRefresh),
                    );
                    if (patches.length > 0 && !options.noHistory) {
                        if (options.logPatch) {
                            console.info('patch', patches);
                        }
                        const filteredPatches = filterPatch(patches);
                        let filteredInversePatches = filterPatch(inversePatches);
                        if (filteredInversePatches.length > 0) {
                            options.id = ctx_.currentSheetId;
                            if (options.deleteSheetOp) {
                                const target = ctx_.sheets.filter((sheet) => sheet.id === options.deleteSheetOp?.id);
                                if (target) {
                                    const index = getSheetIndex(ctx_, options.deleteSheetOp.id as string) as number;
                                    options.deletedSheet = {
                                        id: options.deleteSheetOp.id as string,
                                        index: index as number,
                                        value: cloneDeep(ctx_.sheets[index]),
                                    };
                                    options.deletedSheet!.value!.celldata = dataToCelldata(
                                        options.deletedSheet!.value!.data as CellMatrix,
                                    );
                                    delete options.deletedSheet!.value!.data;
                                    options.deletedSheet.value!.status = 0;
                                    filteredInversePatches = [
                                        {
                                            op: 'add',
                                            path: ['sheets', 0],
                                            value: options.deletedSheet.value,
                                        },
                                    ];
                                }
                            } else if (options.addSheetOp) {
                                options.addSheet = {};
                                options.addSheet!.id = result.sheets[result.sheets.length - 1].id;
                            }
                            // noUndo: emit the op (peers need the swap/correction) but record no local
                            // undo entry, so a cross-mount paste stays a single ⌘Z.
                            if (!options.noUndo) {
                                globalCache.current.undoList.push({
                                    patches: filteredPatches,
                                    inversePatches: filteredInversePatches,
                                    options,
                                });
                                globalCache.current.redoList = [];
                            }
                            emitOp(result, filteredPatches, options);
                        }
                    } else {
                        if (patches?.[0]?.value?.length < ctx_?.sheets?.length) {
                            reduceUndoList(result, ctx_, globalCache);
                        }
                    }
                    return result;
                });
            },
            [emitOp],
        );

        const handleUndo = useCallback(() => {
            if (context.allowEdit === false) return;
            const history = globalCache.current.undoList.pop();
            if (history) {
                setContext((ctx_) => {
                    if (history.options?.deleteSheetOp) {
                        history.inversePatches[0].path[1] = ctx_.sheets.length;
                        const order = history.options.deletedSheet?.value?.order as number;
                        const sheetsRight = ctx_.sheets.filter(
                            (sheet) =>
                                (sheet?.order as number) >= (order as number) &&
                                sheet.id !== history?.options?.deleteSheetOp?.id,
                        );
                        for (const sheet of sheetsRight) {
                            history.inversePatches.push({
                                op: 'replace',
                                path: ['sheets', getSheetIndex(ctx_, sheet.id as string) as number, 'order'],
                                value: (sheet?.order as number) + 1,
                            } as Patch);
                        }
                    }
                    let newContext = applyPatches(ctx_, history.inversePatches);
                    const si = getSheetIndex(newContext, newContext.currentSheetId);
                    if (si != null) {
                        newContext = produce(newContext, (draft: Context) => {
                            draft.insertedImgs = draft.sheets[si].images;
                        });
                    }
                    globalCache.current.redoList.push(history);
                    const inversedOptions = inverseRowColOptions(history.options);
                    if (inversedOptions?.insertRowColOp) {
                        inversedOptions.restoreDeletedCells = true;
                    }
                    if (history.options?.addSheetOp) {
                        const index = getSheetIndex(ctx_, history.options.addSheet!.id as string) as number;
                        inversedOptions!.addSheet = {
                            id: history.options.addSheet!.id as string,
                            index: index as number,
                            value: cloneDeep(ctx_.sheets[index]),
                        };
                        inversedOptions!.addSheet!.value!.celldata = dataToCelldata(
                            inversedOptions!.addSheet!.value?.data as CellMatrix,
                        );
                        delete inversedOptions!.addSheet!.value!.data;
                    }
                    emitOp(newContext, history.inversePatches, inversedOptions, true);
                    if (
                        history.options?.deleteRowColOp ||
                        history.options?.insertRowColOp ||
                        history.options?.restoreDeletedCells
                    )
                        newContext.formulaCache.formulaCellInfoMap = null;
                    else newContext.formulaCache.updateFormulaCache(newContext, history, 'undo');
                    return newContext;
                });
            }
        }, [emitOp, context.allowEdit]);

        const handleRedo = useCallback(() => {
            if (context.allowEdit === false) return;
            const history = globalCache.current.redoList.pop();
            if (history) {
                setContext((ctx_) => {
                    let newContext = applyPatches(ctx_, history.patches);
                    const si = getSheetIndex(newContext, newContext.currentSheetId);
                    if (si != null) {
                        newContext = produce(newContext, (draft: Context) => {
                            draft.insertedImgs = draft.sheets[si].images;
                        });
                    }
                    globalCache.current.undoList.push(history);
                    emitOp(newContext, history.patches, history.options);

                    if (
                        history.options?.deleteRowColOp ||
                        history.options?.insertRowColOp ||
                        history.options?.restoreDeletedCells
                    )
                        newContext.formulaCache.formulaCellInfoMap = null;
                    else newContext.formulaCache.updateFormulaCache(newContext, history, 'redo');
                    return newContext;
                });
            }
        }, [emitOp, context.allowEdit]);

        useEffect(() => {
            if (context.selections != null) {
                mergedSettings.hooks?.afterSelectionChange?.(context.currentSheetId, context.selections[0]);
            }
        }, [context.currentSheetId, context.selections, mergedSettings.hooks]);

        // Surface the active floating image to the app so it can mount its properties panel. Fires on
        // select/deselect and after a geometry commit (insertedImgs changes); `find` returns a stable
        // reference while unchanged, so the app's setState bails when nothing moved.
        useEffect(() => {
            const active = context.insertedImgs?.find((img) => img.id === context.activeImg) ?? null;
            mergedSettings.hooks?.onActiveImageChange?.(active);
        }, [context.activeImg, context.insertedImgs, mergedSettings.hooks]);

        const providerValue = useMemo(
            () => ({
                context,
                setContext: setContextWithProduce,
                settings: mergedSettings,
                handleUndo,
                handleRedo,
                refs,
            }),
            [context, handleRedo, handleUndo, mergedSettings, refs, setContextWithProduce],
        );

        useEffect(() => {
            if (context.sheets.length > 0) {
                onChange?.(context.sheets);
            }
        }, [context.sheets, onChange]);

        // biome-ignore lint/correctness/useExhaustiveDependencies: context.currentSheetId + context.sheets.length are intentional re-trigger deps — body reads via draftCtx, but we want this effect to re-sync settings whenever the user switches sheets or sheets are added/removed
        useEffect(() => {
            setContextWithProduce(
                (draftCtx) => {
                    draftCtx.defaultcolumnNum = mergedSettings.column;
                    draftCtx.defaultrowNum = mergedSettings.row;
                    draftCtx.defaultFontSize = mergedSettings.defaultFontSize;
                    if (draftCtx.sheets.length === 0) {
                        // Shallow-clone the sheet wrappers — NOT the heavy celldata/data,
                        // which stay shared by reference (avoids the ~900ms deep clone on a
                        // 48MB xlsx import). The init below only sets top-level props
                        // (id/status/data/celldata/config/calcChain), and fresh wrappers keep
                        // those writable — so a Workbook remount (key={snapshotVersion}) can
                        // safely re-run this init. Immer still freezes the shared data/celldata
                        // (auto-freeze copies their refs into the draft), but that's fine: for
                        // already-populated sheets initSheetData is skipped (guarded below by
                        // !sheet.data || length === 0), so their frozen contents are never mutated.
                        draftCtx.sheets = originalData.map((sheet) => ({ ...sheet }));
                        ensureSheetIndex(draftCtx.sheets, mergedSettings.generateSheetId);
                        for (const newDatum of draftCtx.sheets) {
                            const index = getSheetIndex(draftCtx, newDatum.id!) as number;
                            const sheet = draftCtx.sheets[index];
                            if (!sheet.data || sheet.data.length === 0) {
                                api.initSheetData(draftCtx, index, sheet);
                            } else {
                                // The replay materializes `data` for any sheet an op touched, so
                                // initSheetData is skipped here — but the config collections it
                                // also guarantees must still exist, or this client's own first
                                // config write goes out as a whole collection.
                                normalizeSheetConfig(sheet);
                            }
                        }
                        // Just seed calcChain (the list of formula cells) — don't
                        // re-evaluate. Excel-imported sheets carry the last computed
                        // values, persisted sheets were saved post-recompute, and an
                        // edit lazily kicks the engine for the affected sub-graph.
                        api.seedCalcChain(draftCtx);
                    }
                    if (mergedSettings.devicePixelRatio > 0) {
                        draftCtx.devicePixelRatio = mergedSettings.devicePixelRatio;
                    }
                    draftCtx.allowEdit = mergedSettings.allowEdit;
                    draftCtx.hooks = mergedSettings.hooks;
                    draftCtx.fontList = mergedSettings.fontList;
                    if (!draftCtx.currentSheetId) {
                        initSheetIndex(draftCtx);
                    }
                    let sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
                    if (sheetIdx == null) {
                        if ((draftCtx.sheets?.length ?? 0) > 0) {
                            sheetIdx = 0;
                            draftCtx.currentSheetId = draftCtx.sheets[0].id!;
                        }
                    }
                    if (sheetIdx == null) return;

                    const sheet = draftCtx.sheets?.[sheetIdx];
                    if (!sheet) return;

                    if (!sheet.data || sheet.data.length === 0) {
                        api.initSheetData(draftCtx, sheetIdx, sheet);
                    } else {
                        normalizeSheetConfig(sheet);
                    }

                    if (
                        (!draftCtx.selections || draftCtx.selections.length === 0) &&
                        sheet.selections &&
                        sheet.selections.length > 0
                    ) {
                        draftCtx.selections = sheet.selections;
                    }
                    // A fresh sheet with no persisted selection is seeded once by the
                    // SheetOverlay mount effect (api.setSelection) — the single canonical seed.

                    draftCtx.insertedImgs = sheet.images;
                    draftCtx.currency = mergedSettings.currency || '€';

                    draftCtx.rowHeaderWidth = mergedSettings.rowHeaderWidth;
                    draftCtx.columnHeaderHeight = mergedSettings.columnHeaderHeight;

                    if (sheet.defaultRowHeight != null) {
                        draftCtx.defaultrowlen = Number(sheet.defaultRowHeight);
                    } else {
                        draftCtx.defaultrowlen = mergedSettings.defaultRowHeight;
                    }

                    if (sheet.addRows != null) {
                        draftCtx.addDefaultRows = Number(sheet.addRows);
                    } else {
                        draftCtx.addDefaultRows = mergedSettings.addRows;
                    }

                    if (sheet.defaultColWidth != null) {
                        draftCtx.defaultcollen = Number(sheet.defaultColWidth);
                    } else {
                        draftCtx.defaultcollen = mergedSettings.defaultColWidth;
                    }

                    if (sheet.showGridLines != null) {
                        const { showGridLines } = sheet;
                        if (showGridLines === 0 || showGridLines === false) {
                            draftCtx.showGridLines = false;
                        } else {
                            draftCtx.showGridLines = true;
                        }
                    } else {
                        draftCtx.showGridLines = true;
                    }
                },
                { noHistory: true },
            );
        }, [
            context.currentSheetId,
            context.sheets.length,
            originalData,
            mergedSettings.defaultRowHeight,
            mergedSettings.defaultColWidth,
            mergedSettings.column,
            mergedSettings.row,
            mergedSettings.defaultFontSize,
            mergedSettings.devicePixelRatio,
            mergedSettings.allowEdit,
            mergedSettings.hooks,
            mergedSettings.generateSheetId,
            setContextWithProduce,
            mergedSettings.rowHeaderWidth,
            mergedSettings.columnHeaderHeight,
            mergedSettings.addRows,
            mergedSettings.currency,
            mergedSettings.fontList,
        ]);

        const onKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLDivElement>) => {
                // Portaled UI (menus, popovers, dialogs) renders outside this div but still
                // bubbles keydown through the React tree. The grid only owns keys from its
                // own DOM subtree — without this, menu roving moves the selection and the
                // handler's tail steals focus out of the open menu.
                if (!e.currentTarget.contains(e.target as Node)) return;
                const { nativeEvent } = e;
                // handling undo and redo ahead because handleUndo and handleRedo
                // themselves are calling setContext, and should not be nested
                // in setContextWithProduce.
                if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
                    if (e.shiftKey) {
                        handleRedo();
                    } else {
                        handleUndo();
                    }
                    e.stopPropagation();
                    return;
                }
                if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
                    handleRedo();
                    e.stopPropagation();
                    e.preventDefault();
                    return;
                }
                setContextWithProduce((draftCtx) => {
                    handleGlobalKeyDown(
                        draftCtx,
                        cellInput.current!,
                        fxInput.current!,
                        nativeEvent,
                        globalCache.current!,
                        handleUndo, // still passing handleUndo and handleRedo here to satisfy API
                        handleRedo,
                        canvas.current!.getContext('2d')!,
                    );
                });
            },
            [handleRedo, handleUndo, setContextWithProduce],
        );

        const onCopy = useCallback(
            (e: ClipboardEvent) => {
                // A selected floating image takes precedence over the pending cell copy: its
                // copy is a pure image — eigen JSON only, no text/plain and no png (matching vector's
                // v1 flavor; a native copy event can't await a media/ blob fetch, so png is dropped).
                const activeImg = context.insertedImgs?.find((img) => img.id === context.activeImg);
                if (activeImg) {
                    const source = mergedSettings.hooks?.resolveImagePath?.(activeImg.mediaName);
                    if (source) {
                        e.preventDefault();
                        // Drop any cell table the keyboard copy staged, so a later native-menu copy
                        // with no image active can't emit this stale table.
                        consumePendingCopy();
                        const item = buildImageClipboardItem({
                            mediaName: activeImg.mediaName,
                            source,
                            box: { width: activeImg.width, height: activeImg.height, angle: activeImg.angle },
                        });
                        writeEigenClipboard(e, { version: 1, items: [item] });
                        return;
                    }
                }

                const pending = consumePendingCopy();
                if (!pending) return;

                e.preventDefault();

                // Cell text as an eigen text item, carried on the same wire as the image branch above:
                // the sheet's HTML table rides after the marker span so a non-eigen consumer still pastes
                // a real table, and the custom MIME lands for same-origin reads.
                const eigenData: EigenClipboardData = {
                    version: 1,
                    items: [buildCellRangeClipboardItem(context, pending.plainText)],
                };
                writeEigenClipboard(e, eigenData, pending.plainText, pending.html);
            },
            [context, mergedSettings.hooks],
        );

        const onPaste = useCallback(
            (e: ClipboardEvent) => {
                // deal with multi instance case, only the focused sheet handles the paste
                if (
                    cellInput.current === document.activeElement ||
                    document.activeElement?.className === 'sheet-overlay'
                ) {
                    const { clipboardData } = e;
                    if (!clipboardData) return;

                    // A same-tab sheet→sheet copy tags text/html with COPY_ACTION_TABLE_MARKER and is
                    // served from ctx.copyState (formulas/formats), not the eigen wire — the classifier
                    // suppresses the eigen + svg flavours for it, so those rungs skip and we fall through
                    // to the native table paste below. Every other producer flows through the rungs.
                    const paste = classifyPaste(clipboardData, { internalMarkerText: COPY_ACTION_TABLE_MARKER });

                    // A vector SVG payload (or a pasted SVG document) becomes a floating image through the
                    // app's exact image-file path — stored in media/, served as-is, rendered by <image>.
                    // Ahead of the eigen-items split so a vector selection lands as one image, not as empty
                    // shape carriers. An image-bearing selection's svg references its images BY NAME
                    // (eigen-media:), so it rides onPasteSvgFile — the app materializes each into its media/
                    // before storing the svg; an image-free svg rides onPasteImageFile as today.
                    if (paste.svg) {
                        const svgImageItems = paste.svg.items.filter(
                            (item): item is EigenClipboardImageItem => item.type === 'image',
                        );
                        const onPasteSvgFile = mergedSettings.hooks?.onPasteSvgFile;
                        const onPasteImageFile = mergedSettings.hooks?.onPasteImageFile;
                        if (onPasteSvgFile) {
                            // Always materialize (even with no image items) so a forged/dangling
                            // eigen-media ref is stripped before the svg is stored — same as docs/slides.
                            e.preventDefault();
                            onPasteSvgFile(paste.svg.svg, svgImageItems);
                            return;
                        }
                        if (onPasteImageFile) {
                            e.preventDefault();
                            onPasteImageFile(svgToImageFile(paste.svg.svg));
                            return;
                        }
                    }

                    if (paste.eigen) {
                        // Mixed eigen payloads split by kind: image items become floating images,
                        // text items land in cells. Both apply when both are present. The image
                        // insert is app-owned (typed size + cross-mount re-upload), gated on its hook.
                        const onPasteEigenImage = mergedSettings.hooks?.onPasteEigenImage;
                        const imageItems = onPasteEigenImage
                            ? paste.eigen.items.filter((item): item is EigenClipboardImageItem => item.type === 'image')
                            : [];
                        // Extract text from eigen clipboard items and paste as plain text. Empty
                        // carriers (vector shapes ride as empty text items) must not paste as blank
                        // cells over existing content.
                        const textParts = paste.eigen.items
                            .filter(
                                (item): item is EigenClipboardTextItem =>
                                    item.type === 'text' && clipboardTextItemHasContent(item),
                            )
                            .map((item) => item.text);
                        if (imageItems.length > 0 || textParts.length > 0) {
                            e.preventDefault();
                            for (const item of imageItems) onPasteEigenImage?.(item);
                            if (textParts.length > 0) {
                                // Create a synthetic paste with the text — let handlePaste process it
                                const syntheticTransfer = new DataTransfer();
                                syntheticTransfer.setData('text/plain', textParts.join('\n'));
                                const syntheticEvent = new ClipboardEvent('paste', {
                                    clipboardData: syntheticTransfer,
                                });
                                setContextWithProduce((draftCtx) => {
                                    try {
                                        handlePaste(draftCtx, syntheticEvent);
                                    } catch (err) {
                                        console.error(err);
                                    }
                                });
                            }
                            return;
                        }
                    }

                    const txtdata = paste.html || paste.text;
                    const ele = document.createElement('div');
                    ele.innerHTML = txtdata;

                    const trList = ele.querySelectorAll('table tr');
                    const maxRow = trList.length + context.selections![0].row[0];
                    const rowToBeAdded =
                        maxRow -
                        context.sheets[getSheetIndex(context, context!.currentSheetId! as string) as number].data!
                            .length;
                    const range = context.selections;
                    if (rowToBeAdded > 0) {
                        const insertRowColOp: SetContextOptions['insertRowColOp'] = {
                            type: 'row',
                            index:
                                context.sheets[getSheetIndex(context, context!.currentSheetId! as string) as number]
                                    .data!.length - 1,
                            count: rowToBeAdded,
                            direction: 'rightbottom',
                            id: context.currentSheetId,
                        };
                        setContextWithProduce(
                            (draftCtx) => {
                                insertRowCol(draftCtx, insertRowColOp);
                                draftCtx.selections = range;
                            },
                            {
                                insertRowColOp,
                            },
                        );
                    }
                    setContextWithProduce((draftCtx) => {
                        try {
                            handlePaste(draftCtx, e);
                        } catch (err) {
                            console.error(err);
                        }
                    });
                }
            },
            [context, setContextWithProduce, mergedSettings.hooks],
        );

        useEffect(() => {
            document.addEventListener('copy', onCopy);
            document.addEventListener('cut', onCopy);
            document.addEventListener('paste', onPaste);
            return () => {
                document.removeEventListener('copy', onCopy);
                document.removeEventListener('cut', onCopy);
                document.removeEventListener('paste', onPaste);
            };
        }, [onCopy, onPaste]);

        // expose APIs
        useImperativeHandle(
            ref,
            () => generateAPIs(context, setContextWithProduce, handleUndo, handleRedo, mergedSettings),
            [context, setContextWithProduce, handleUndo, handleRedo, mergedSettings],
        );

        const i = getSheetIndex(context, context.currentSheetId);
        if (i == null) {
            return null;
        }
        const sheet = context.sheets?.[i];
        if (!sheet) {
            return null;
        }

        return (
            <WorkbookContext.Provider value={providerValue}>
                <ModalProvider>
                    <div
                        className="flex flex-col w-full h-full m-0 p-0 font-[inherit] bg-background relative overflow-hidden"
                        ref={workbookContainer}
                        onKeyDown={onKeyDown}
                    >
                        <section
                            aria-labelledby="shortcuts-heading"
                            id="shortcut-list"
                            className="sr-only"
                            tabIndex={0}
                            aria-live="polite"
                        >
                            <h2 id="shortcuts-heading">Keyboard Shortcuts</h2>
                            <ul>
                                <li>Toggle sheet focus lock: Shift, Control, F.</li>
                                <li>Select range: Shift, arrow keys.</li>
                                <li>Auto-fill selection down from first cell: Control or Meta key, D.</li>
                                <li>Auto-fill selection right from first cell: Control or Meta key, R.</li>
                                <li>Bold text: Control or Meta key, B.</li>
                                <li>Copy: Control or Meta key, C.</li>
                                <li>Paste: Control or Meta key, V.</li>
                                <li>Undo: Control or Meta key, Z.</li>
                                <li>Redo: Control or Meta key, Shift, Z.</li>
                                <li>Delete cell content: Delete or Backspace.</li>
                                <li>Confirm cell edit and move down: Enter.</li>
                                <li>Move right: Tab.</li>
                                <li>Move left: Shift, Tab.</li>
                            </ul>
                        </section>
                        <div className="w-full">
                            {mergedSettings.showToolbar && (
                                <MenuBar leftItems={toolbarLeftItems} rightItems={toolbarRightItems} />
                            )}
                            {mergedSettings.showFormulaBar && <FxEditor />}
                        </div>
                        <Sheet sheet={sheet} />
                        {mergedSettings.showSheetTabs && <SheetTab />}
                        <FilterMenu />
                    </div>
                </ModalProvider>
            </WorkbookContext.Provider>
        );
    },
);
