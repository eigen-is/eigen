// The Workbook: the sheet editor's root component and the context every part of the grid reads. Each edit runs as a
// recipe through setContextWithProduce, which records the tab's undo entry and sends the edit's ops through onOp. It
// also owns undo and redo, the clipboard listeners and the imperative API a host reaches through its ref.

import { formatWithLabels, matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import { isSketchCapped, newSheetChartSpecParts, readChartSpec } from '@workspace/lib/charts';
import {
    buildImageClipboardItem,
    buildTextClipboardItem,
    classifyPaste,
    clipboardTextItemHasContent,
    pastedChartFields,
    svgToImageFile,
    writeEigenClipboard,
} from '@workspace/lib/clipboard';
import type { SheetFloatingItem } from '@workspace/lib/sheets';
import type {
    EigenClipboardChartItem,
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import { isTypingTarget } from '@workspace/ui/hooks/is-typing-target';
import { cloneDeep, isEqual } from 'es-toolkit/compat';
import { enablePatches, produce, produceWithPatches } from 'immer';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { RefValues, SetContextOptions } from '../../context';
import { WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { copySheetChartSpec, resolveRangeChartData, seriesName } from '../../engine/chart-data';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { ChartPanelState, Context, GlobalCache, History, Op, Settings, Sheet as SheetType } from '../../state';
import {
    api,
    applySheetView,
    COPY_ACTION_TABLE_MARKER,
    createContextResolver,
    defaultContext,
    defaultSettings,
    deleteActiveObject,
    ensureSheetIndex,
    filterPatch,
    getFlowdata,
    getSheetIndex,
    groupValuesRefresh,
    handleGlobalKeyDown,
    handlePaste,
    initSheetData,
    initSheetIndex,
    insertRowCol,
    pasteChart,
    patchToOp,
    pushEntry,
    recordEntry,
    redoEntry,
    runStyleOf,
    SHEET_HOTKEYS,
    selectionCache,
    sheetChartClipboardItem,
    undoEntry,
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
// anchor cell's font size rides along so a consumer that honors the box (slides) renders the text
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
        typography: { fontSize: runStyleOf(getFlowdata(ctx)?.[r1]?.[c1]).fs },
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
                        const filteredInversePatches = filterPatch(inversePatches);
                        if (filteredInversePatches.length > 0) {
                            const entry = recordEntry(ctx_, result, filteredPatches, filteredInversePatches, options);
                            // noUndo: emit the op (peers need the swap/correction) but record no local
                            // undo entry, so a cross-mount paste stays a single ⌘Z.
                            if (!options.noUndo) {
                                const { undoList, undoGesture } = globalCache.current;
                                const last = undoList.at(-1);
                                if (undoGesture && last?.gesture === undoGesture) {
                                    const [patch] = entry.patches;
                                    const previous = last.patches.at(-1);
                                    // A field typed key by key keeps its first old value and its latest new one.
                                    if (
                                        entry.patches.length === 1 &&
                                        patch.op === 'replace' &&
                                        previous?.op === 'replace' &&
                                        isEqual(previous.path, patch.path)
                                    ) {
                                        last.patches[last.patches.length - 1] = patch;
                                    } else {
                                        last.patches.push(...entry.patches);
                                        last.inversePatches.unshift(...entry.inversePatches);
                                    }
                                } else {
                                    pushEntry(undoList, { ...entry, gesture: undoGesture });
                                }
                                globalCache.current.redoList = [];
                            }
                            onOp?.(patchToOp(result, filteredPatches, entry.options));
                        }
                    }
                    return result;
                });
            },
            [onOp],
        );

        // The entry moves to the other stack in the updater, as a peer batch shifts the stacks in its own, so the two
        // happen in call order. React may run an updater twice, and the entry moves once.
        const handleUndo = useCallback(() => {
            if (context.allowEdit === false) return;
            let moved = false;
            let entry: History | undefined;
            setContext((ctx_) => {
                if (!moved) {
                    moved = true;
                    const { undoList, redoList } = globalCache.current;
                    entry = undoList.pop();
                    if (entry) redoList.push(entry);
                }
                if (!entry) return ctx_;
                const { ctx, ops } = undoEntry(ctx_, entry);
                if (ops.length > 0) onOp?.(ops);
                return ctx;
            });
        }, [onOp, context.allowEdit]);

        const handleRedo = useCallback(() => {
            if (context.allowEdit === false) return;
            let moved = false;
            let entry: History | undefined;
            setContext((ctx_) => {
                if (!moved) {
                    moved = true;
                    const { undoList, redoList } = globalCache.current;
                    entry = redoList.pop();
                    if (entry) undoList.push(entry);
                }
                if (!entry) return ctx_;
                const { ctx, ops } = redoEntry(ctx_, entry);
                if (ops.length > 0) onOp?.(ops);
                return ctx;
            });
        }, [onOp, context.allowEdit]);

        useEffect(() => {
            if (context.selections != null) {
                mergedSettings.hooks?.afterSelectionChange?.(context.currentSheetId, context.selections[0]);
            }
        }, [context.currentSheetId, context.selections, mergedSettings.hooks]);

        // Surface the selected image or chart to the app so it can mount its properties panel. Fires on
        // select and deselect and after a write; immer keeps the record's reference while it is unchanged,
        // and the item is memoized on it, so the app's setState bails when nothing moved.
        const currentSheetIndex = getSheetIndex(context, context.currentSheetId);
        const currentSheet = context.sheets[currentSheetIndex ?? -1];
        const { activeObject } = context;
        const activeImage = activeObject?.kind === 'image' ? currentSheet?.images?.[activeObject.id] : undefined;
        const activeChart = activeObject?.kind === 'chart' ? currentSheet?.charts?.[activeObject.id] : undefined;
        const activeItem = useMemo((): SheetFloatingItem | null => {
            if (activeImage) return { kind: 'image', object: activeImage };
            if (activeChart) return { kind: 'chart', object: activeChart };
            return null;
        }, [activeImage, activeChart]);
        useEffect(() => {
            mergedSettings.hooks?.onActiveObjectChange?.(activeItem);
        }, [activeItem, mergedSettings.hooks]);

        // Rebuilt on every sheet change while a chart is selected: a renamed sheet renames its data range,
        // and an edited cell its slices. Memoized, so the app's setState bails out when nothing changed.
        // biome-ignore lint/correctness/useExhaustiveDependencies: the resolver reads context.sheets alone; depending on `context` would rebuild on every selection and scroll
        const chartPanel = useMemo((): ChartPanelState | null => {
            if (!activeChart) return null;
            const { spec } = readChartSpec(activeChart);
            const data = spec?.data;
            const resolver = createContextResolver(context);
            const resolved = data?.source === 'range' ? resolveRangeChartData(data, resolver) : data;
            return {
                chart: activeChart,
                sheetId: context.currentSheetId,
                sheets: context.sheets.map(({ id, name }) => ({ id: id ?? '', name })),
                categories: typeof resolved === 'object' ? resolved.categories : [],
                seriesNames: data?.source === 'range' ? data.series.map((s) => seriesName(s.name, resolver)) : [],
                sketchCapped: spec !== null && typeof resolved === 'object' && isSketchCapped(spec, resolved),
            };
        }, [activeChart, context.currentSheetId, context.sheets]);
        useEffect(() => {
            mergedSettings.hooks?.onChartPanelChange?.(chartPanel);
        }, [chartPanel, mergedSettings.hooks]);

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
                    // Only a load or newly created sheet data needs the view here; a switch derives its own.
                    let viewStale = false;
                    if (draftCtx.sheets.length === 0) {
                        viewStale = true;
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
                        for (const [index, sheet] of draftCtx.sheets.entries()) {
                            if (!sheet.data || sheet.data.length === 0) {
                                initSheetData(draftCtx, index, sheet);
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
                    const sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
                    if (sheetIdx == null) return;
                    const sheet = draftCtx.sheets[sheetIdx];

                    if (!sheet.data || sheet.data.length === 0) {
                        initSheetData(draftCtx, sheetIdx, sheet);
                        viewStale = true;
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

                    draftCtx.currency = mergedSettings.currency || '€';

                    draftCtx.rowHeaderWidth = mergedSettings.rowHeaderWidth;
                    draftCtx.columnHeaderHeight = mergedSettings.columnHeaderHeight;

                    if (sheet.addRows != null) {
                        draftCtx.addDefaultRows = Number(sheet.addRows);
                    } else {
                        draftCtx.addDefaultRows = mergedSettings.addRows;
                    }

                    if (viewStale) applySheetView(draftCtx);
                },
                { noHistory: true },
            );
        }, [
            context.currentSheetId,
            context.sheets.length,
            originalData,
            mergedSettings.column,
            mergedSettings.row,
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
                // Undo and redo run ahead of the grid's handler: handleUndo and handleRedo call setContext
                // themselves and can't nest in setContextWithProduce. An open cell editor leaves them to the
                // browser, which undoes the typing, as Google Sheets does.
                if (context.editingCellPosition.length === 0) {
                    if (matchesKeyboardEvent(nativeEvent, SHEET_HOTKEYS.undo)) {
                        handleUndo();
                        e.stopPropagation();
                        return;
                    }
                    if (matchesKeyboardEvent(nativeEvent, SHEET_HOTKEYS.redo)) {
                        handleRedo();
                        e.stopPropagation();
                        return;
                    }
                    if (matchesKeyboardEvent(nativeEvent, SHEET_HOTKEYS.redoAlt)) {
                        handleRedo();
                        e.stopPropagation();
                        e.preventDefault();
                        return;
                    }
                }
                setContextWithProduce((draftCtx) => {
                    const input = cellInput.current;
                    if (!input) return;
                    handleGlobalKeyDown(
                        draftCtx,
                        input,
                        fxInput.current,
                        nativeEvent,
                        globalCache.current,
                        canvas.current?.getContext('2d') ?? undefined,
                    );
                });
            },
            [context.editingCellPosition.length, handleRedo, handleUndo, setContextWithProduce],
        );

        const onCopy = useCallback(
            (e: ClipboardEvent) => {
                // A text field beside a selected chart or image (the chart panel's title, the image panel's
                // width) copies its own text.
                const floating = !isTypingTarget();
                // A selected chart copies itself with its ranges read into inline data, the one thing every
                // other app can draw; this workbook keeps its ranges for a paste here. A chart that draws
                // #REF! or too much data copies nothing. A cut deletes it, as Google's does. Read from
                // ctx.sheets, not the editable current sheet, so a viewer copies too.
                if (activeChart && floating) {
                    const item = sheetChartClipboardItem(context, activeChart);
                    if (!item) return;
                    e.preventDefault();
                    writeEigenClipboard(e, { version: 1, items: [item] });
                    globalCache.current.copiedChart = { inline: item.parts, chart: activeChart };
                    if (e.type === 'cut' && context.allowEdit !== false) setContextWithProduce(deleteActiveObject);
                    return;
                }
                // A selected floating image takes precedence over the pending cell copy: its
                // copy is a pure image — eigen JSON only, no text/plain and no png, as vector's is (a
                // native copy event can't await a media/ blob fetch, so png is dropped). A cut deletes it.
                if (activeImage && floating) {
                    const source = mergedSettings.hooks?.resolveImagePath?.(activeImage.mediaName);
                    if (source) {
                        e.preventDefault();
                        // Drop any cell table the keyboard copy staged, so a later native-menu copy
                        // with no image active can't emit this stale table.
                        consumePendingCopy();
                        const item = buildImageClipboardItem({
                            mediaName: activeImage.mediaName,
                            source,
                            box: { width: activeImage.width, height: activeImage.height, angle: activeImage.angle },
                        });
                        writeEigenClipboard(e, { version: 1, items: [item] });
                        if (e.type === 'cut' && context.allowEdit !== false) setContextWithProduce(deleteActiveObject);
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
                    items: [buildCellRangeClipboardItem(context, pending.cellText)],
                };
                writeEigenClipboard(e, eigenData, pending.plainText, pending.html);
            },
            [activeChart, activeImage, context, mergedSettings.hooks, setContextWithProduce],
        );

        const onPaste = useCallback(
            (e: ClipboardEvent) => {
                // deal with multi instance case, only the focused sheet handles the paste; a selected image or
                // chart holds the focus
                const { activeElement } = document;
                if (
                    cellInput.current === activeElement ||
                    activeElement?.className === 'sheet-overlay' ||
                    (activeElement?.matches('[data-floating-id]') && workbookContainer.current?.contains(activeElement))
                ) {
                    // The open cell editor pastes into itself, as text. A ⌘V on the grid waits for its paste in
                    // selectionCache, and a paste the grid passes on or takes without handlePaste ends that wait,
                    // so a later paste into the editor can't become a grid paste that closes it.
                    const { clipboardData } = e;
                    if (!clipboardData || context.editingCellPosition.length > 0) {
                        selectionCache.isPasteAction = false;
                        return;
                    }

                    // A same-tab sheet→sheet copy tags text/html with COPY_ACTION_TABLE_MARKER and is
                    // served from ctx.copyState (formulas/formats), not the eigen wire — the classifier
                    // suppresses the eigen + svg flavors for it, so those rungs skip and we fall through
                    // to the native table paste below. Every other producer flows through the rungs.
                    const paste = classifyPaste(clipboardData, { internalMarkerText: COPY_ACTION_TABLE_MARKER });

                    // A vector SVG payload (or a pasted SVG document) becomes a floating image through the
                    // app's exact image-file path — stored in media/, served as-is, rendered by <image>.
                    // Ahead of the eigen-items split so a vector selection lands as one image, not as its
                    // separate items. An image-bearing selection's svg references its images BY NAME
                    // (eigen-media:), so it rides onPasteSvgFile — the app materializes each into its media/
                    // before storing the svg; an image-free svg rides onPasteImageFile.
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
                            selectionCache.isPasteAction = false;
                            onPasteSvgFile(paste.svg.svg, svgImageItems);
                            return;
                        }
                        if (onPasteImageFile) {
                            e.preventDefault();
                            selectionCache.isPasteAction = false;
                            onPasteImageFile(svgToImageFile(paste.svg.svg));
                            return;
                        }
                    }

                    if (paste.eigen) {
                        // Mixed eigen payloads split by kind: image and chart items become floating objects,
                        // text items land in cells. All apply when all are present. The image
                        // insert is app-owned (typed size + cross-mount re-upload), gated on its hook.
                        const onPasteEigenImage = mergedSettings.hooks?.onPasteEigenImage;
                        const imageItems = onPasteEigenImage
                            ? paste.eigen.items.filter((item): item is EigenClipboardImageItem => item.type === 'image')
                            : [];
                        // Empty carriers must not paste as blank cells over existing content.
                        const textParts = paste.eigen.items
                            .filter(
                                (item): item is EigenClipboardTextItem =>
                                    item.type === 'text' && clipboardTextItemHasContent(item),
                            )
                            .map((item) => item.text);
                        const chartItems = paste.eigen.items.filter(
                            (item): item is EigenClipboardChartItem => item.type === 'chart',
                        );
                        if (imageItems.length > 0 || chartItems.length > 0 || textParts.length > 0) {
                            e.preventDefault();
                            if (textParts.length === 0) selectionCache.isPasteAction = false;
                            for (const item of imageItems) onPasteEigenImage?.(item);
                            // This workbook's own copy keeps the ranges it was copied with.
                            const copied = globalCache.current.copiedChart;
                            if (chartItems.length > 0) {
                                setContextWithProduce((draftCtx) => {
                                    for (const { parts, width, height, look } of chartItems) {
                                        const own = copied && isEqual(copied.inline, parts);
                                        const fields = own
                                            ? copySheetChartSpec(copied.chart)
                                            : pastedChartFields(parts, newSheetChartSpecParts);
                                        if (!fields) continue;
                                        pasteChart(draftCtx, uuidv4(), fields, { width, height }, look);
                                    }
                                });
                            }
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
                    // Parse into an inert document, never a live <div>: txtdata is OS clipboard HTML
                    // and a live element's innerHTML loads <img> and fires its onerror even detached.
                    const trList = new DOMParser().parseFromString(txtdata, 'text/html').querySelectorAll('table tr');
                    const rowCount = getFlowdata(context)?.length ?? 0;
                    const range = context.selections;
                    const firstRow = range?.[0]?.row[0];
                    const rowToBeAdded = firstRow == null ? 0 : trList.length + firstRow - rowCount;
                    if (rowToBeAdded > 0) {
                        const insertRowColOp: SetContextOptions['insertRowColOp'] = {
                            type: 'row',
                            index: rowCount - 1,
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
            () => generateAPIs(context, setContextWithProduce, handleUndo, handleRedo, globalCache.current),
            [context, setContextWithProduce, handleUndo, handleRedo],
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
                                <li>Toggle sheet focus lock: {formatWithLabels(SHEET_HOTKEYS.focusLock)}.</li>
                                <li>Select range: Shift, arrow keys.</li>
                                <li>Fill down from the first cell: {formatWithLabels(SHEET_HOTKEYS.fillDown)}.</li>
                                <li>Fill right from the first cell: {formatWithLabels(SHEET_HOTKEYS.fillRight)}.</li>
                                <li>Bold text: {formatWithLabels(SHEET_HOTKEYS.bold)}.</li>
                                <li>Italic text: {formatWithLabels(SHEET_HOTKEYS.italic)}.</li>
                                <li>Underline text: {formatWithLabels(SHEET_HOTKEYS.underline)}.</li>
                                <li>Cut: {formatWithLabels(SHEET_HOTKEYS.cut)}.</li>
                                <li>Copy: {formatWithLabels(SHEET_HOTKEYS.copy)}.</li>
                                <li>Paste: {formatWithLabels(SHEET_HOTKEYS.paste)}.</li>
                                <li>Undo: {formatWithLabels(SHEET_HOTKEYS.undo)}.</li>
                                <li>Redo: {formatWithLabels(SHEET_HOTKEYS.redo)}.</li>
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
