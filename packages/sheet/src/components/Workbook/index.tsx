// The Workbook: the sheet editor's root component and the context every part of the grid reads. Each edit runs as a
// recipe through setContextWithProduce, which applies it at the call, records the tab's undo entry and sends the edit's
// ops through onOp before it returns. React only renders the result. It also owns undo and redo, the clipboard
// listeners and the imperative API a host reaches through its ref.

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
import type { SheetChart, SheetFloatingItem, SheetImage } from '@workspace/lib/sheets';
import type {
    EigenClipboardChartItem,
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import { isTypingTarget } from '@workspace/ui/hooks/is-typing-target';
import { cloneDeep, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { enablePatches, produce, produceWithPatches } from 'immer';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { RefValues, SetContextOptions } from '../../context';
import { WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { copySheetChartSpec, resolveRangeChartData, seriesName } from '../../engine/chart-data';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { ChartPanelState, Context, GlobalCache, Op, Settings, Sheet as SheetType } from '../../state';
import {
    api,
    applySheetView,
    COPY_ACTION_TABLE_MARKER,
    createContextResolver,
    defaultContext,
    defaultSettings,
    deleteActiveObject,
    endPointerDrag,
    ensureSheetIndex,
    filterPatch,
    getFlowdata,
    getSheetIndex,
    groupValuesRefresh,
    handleGlobalKeyDown,
    handlePaste,
    initSheetData,
    initSheetIndex,
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
    ValidationLimitError,
    warmFormulaCellInfoMapOnIdle,
} from '../../state';
import { consumePendingCopy } from '../../state/modules/clipboard';
import { FilterMenu } from '../ContextMenu/FilterMenu';
import { FxEditor } from '../FxEditor';
import { WorkbookMenuBar } from '../MenuBar';
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

// The copied cell range as a text item. Every clipboard item carries its drawn box. A sheet has no zoom, so the row and
// column edges give the box in pixels. The first cell's font size goes along, so an app that keeps the box, such as
// slides, draws the text at the size it had here and not at its own larger default, which the box would clip. A copy
// always has a selection, so the [0, 0] fallback never applies.
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

// The image or chart the person selected on the current sheet. It is read from ctx.sheets, not from the editable
// current sheet, so a viewer's panel and copy see it too.
function activeFloating(ctx: Context): { image?: SheetImage; chart?: SheetChart } {
    const sheet = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) ?? -1];
    const { activeObject } = ctx;
    return {
        image: activeObject?.kind === 'image' ? sheet?.images?.[activeObject.id] : undefined,
        chart: activeObject?.kind === 'chart' ? sheet?.charts?.[activeObject.id] : undefined,
    };
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
        const menuBar = useRef<HTMLDivElement>(null);

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

        const [context, setContext] = useState(() => defaultContext(refs));
        // The workbook with every write so far. A write lands here at its call, and React renders it a moment later.
        // A read outside render, such as the host's getFlowdata or a paste, reads it here, so it sees an edit made just
        // before.
        const contextRef = useRef(context);
        const getContext = useCallback(() => contextRef.current, []);
        const commit = useCallback((next: Context) => {
            contextRef.current = next;
            setContext(next);
        }, []);

        // biome-ignore lint/correctness/useExhaustiveDependencies: deps spread from Object.values(props) — biome can't see through the spread
        const mergedSettings = useMemo(
            () => Object.assign(cloneDeep(defaultSettings), props),
            [...Object.values(props)],
        );

        // The formula map is built once the sheet has loaded, off the interaction path, so the first edit on a large
        // workbook doesn't wait seconds for it.
        const warmSheetIdx = getSheetIndex(context, context.currentSheetId);
        const dataReady = warmSheetIdx != null && (context.sheets?.[warmSheetIdx]?.data?.length ?? 0) > 0;
        useEffect(() => {
            if (dataReady) return warmFormulaCellInfoMapOnIdle(getContext);
        }, [dataReady, getContext]);

        const setContextWithProduce = useCallback(
            (recipe: (ctx: Context) => void, options: SetContextOptions = {}) => {
                const base = contextRef.current;
                // The scroll position lives in globalCache, so a scroll tick doesn't render every reader of the
                // context. A recipe that reads it, such as a click on a cell, gets it copied in here.
                const syncScroll = (ctx: Context) => {
                    ctx.scrollLeft = globalCache.current.scrollLeft;
                    ctx.scrollTop = globalCache.current.scrollTop;
                };

                // An edit that would make a validation rule too complex is refused whole: nothing of it applies, and
                // the user sees why. A formula it evaluated may have reached the engine's map, which learns the sheets
                // again. A mouse-up's edit still ends its drag.
                const refuse = (e: unknown) => {
                    if (!(e instanceof ValidationLimitError)) throw e;
                    base.formulaCache.resetEngine();
                    warmFormulaCellInfoMapOnIdle(getContext);
                    commit(
                        produce(base, (ctx: Context) => {
                            endPointerDrag(ctx);
                            ctx.warnDialog = e.message;
                        }),
                    );
                };

                // A write that records no history, such as a drag that moves the selection, skips the patches, which
                // cost time on every change and which the selection would never ship anyway.
                if (options.noHistory) {
                    try {
                        commit(produce(base, concatProducer(syncScroll, recipe, triggerGroupValuesRefresh)));
                    } catch (e) {
                        refuse(e);
                    }
                    return;
                }

                let edit: readonly [Context, Patch[], Patch[]];
                try {
                    edit = produceWithPatches(base, concatProducer(syncScroll, recipe, triggerGroupValuesRefresh));
                } catch (e) {
                    refuse(e);
                    return;
                }
                const [result, patches, inversePatches] = edit;
                commit(result);
                if (patches.length === 0) return;
                const filteredPatches = filterPatch(patches);
                const filteredInversePatches = filterPatch(inversePatches);
                if (filteredInversePatches.length === 0) return;
                const entry = recordEntry(base, result, filteredPatches, filteredInversePatches, options);
                // A noUndo write still reaches peers, which need the fix it makes, but it records no undo entry. A
                // paste whose images upload afterwards then stays one undo step.
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
            },
            [commit, getContext, onOp],
        );

        const handleUndo = useCallback(() => {
            if (contextRef.current.allowEdit === false) return;
            const { undoList, redoList } = globalCache.current;
            const entry = undoList.pop();
            if (!entry) return;
            redoList.push(entry);
            const { ctx, ops } = undoEntry(contextRef.current, entry);
            commit(ctx);
            if (ops.length > 0) onOp?.(ops);
        }, [commit, onOp]);

        const handleRedo = useCallback(() => {
            if (contextRef.current.allowEdit === false) return;
            const { undoList, redoList } = globalCache.current;
            const entry = redoList.pop();
            if (!entry) return;
            undoList.push(entry);
            const { ctx, ops } = redoEntry(contextRef.current, entry);
            commit(ctx);
            if (ops.length > 0) onOp?.(ops);
        }, [commit, onOp]);

        useEffect(() => {
            if (context.selections != null) {
                mergedSettings.hooks?.afterSelectionChange?.(context.currentSheetId, context.selections[0]);
            }
        }, [context.currentSheetId, context.selections, mergedSettings.hooks]);

        // Surface the selected image or chart to the app so it can mount its properties panel. Fires on
        // select and deselect and after a write; immer keeps the record's reference while it is unchanged,
        // and the item is memoized on it, so the app's setState bails when nothing moved.
        const { image: activeImage, chart: activeChart } = activeFloating(context);
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
                getContext,
                setContext: setContextWithProduce,
                settings: mergedSettings,
                handleUndo,
                handleRedo,
                refs,
            }),
            [context, getContext, handleRedo, handleUndo, mergedSettings, refs, setContextWithProduce],
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
                        // Each sheet is copied one level deep, and its cells stay shared: a deep copy of a large
                        // import takes about a second. The init below writes only a sheet's own fields, so a remount
                        // can run it again on the same data. It skips a sheet that already has a matrix, so the shared
                        // cells, which immer freezes, are never written.
                        draftCtx.sheets = originalData.map((sheet) => ({
                            ...sheet,
                            id: sheet.id ?? crypto.randomUUID(),
                        }));
                        ensureSheetIndex(draftCtx.sheets);
                        for (const [index, sheet] of draftCtx.sheets.entries()) {
                            if (!sheet.data || sheet.data.length === 0) {
                                initSheetData(draftCtx, index, sheet);
                            } else {
                                // The replay gave this sheet its matrix. Its config collections must still exist, or
                                // this tab's first config write would send a whole collection.
                                normalizeSheetConfig(sheet);
                            }
                        }
                        // The list of formula cells is seeded without computing them. An imported or stored sheet
                        // carries its computed values, and an edit computes the formulas it affects.
                        api.seedCalcChain(draftCtx);
                    }
                    if (mergedSettings.devicePixelRatio > 0) {
                        draftCtx.devicePixelRatio = mergedSettings.devicePixelRatio;
                    }
                    draftCtx.allowEdit = mergedSettings.allowEdit;
                    draftCtx.hooks = mergedSettings.hooks;
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

                    // A switch already restored the sheet's stored selection. Once the view is live, an empty
                    // selection may be one a peer's row op dropped, and the stored copy points at the wrong row.
                    if (
                        viewStale &&
                        (!draftCtx.selections || draftCtx.selections.length === 0) &&
                        sheet.selections &&
                        sheet.selections.length > 0
                    ) {
                        draftCtx.selections = sheet.selections;
                    }
                    // A sheet with no stored selection gets its first one when the grid overlay mounts.

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
            setContextWithProduce,
            mergedSettings.rowHeaderWidth,
            mergedSettings.columnHeaderHeight,
            mergedSettings.addRows,
            mergedSettings.currency,
        ]);

        const onKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLDivElement>) => {
                // The grid owns only the keys from its own part of the page. Portalled menus, popovers and dialogs
                // render outside this div, but their keydown still bubbles here through the React tree, where it
                // would move the selection and take the focus out of an open menu.
                if (!(e.target instanceof Node && e.currentTarget.contains(e.target))) return;
                const { nativeEvent } = e;
                // Undo and redo run ahead of the grid's handler, because a write must not start another write
                // inside its recipe, and handleUndo and handleRedo are writes. An open cell editor leaves them to
                // the browser, which undoes the typing, as Google Sheets does.
                if (contextRef.current.editingCellPosition.length === 0) {
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
                // The bar sits inside this div, and its other keys are its own: the Enter or Space that opens one of
                // its menus would open the cell editor too.
                if (menuBar.current?.contains(e.target)) return;
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
            [handleRedo, handleUndo, setContextWithProduce],
        );

        const onCopy = useCallback(
            (e: ClipboardEvent) => {
                // A text field beside a selected chart or image (the chart panel's title, the image panel's
                // width) copies its own text.
                const floating = !isTypingTarget();
                const ctx = contextRef.current;
                const { chart, image } = activeFloating(ctx);
                // A selected chart copies itself with its ranges read into inline data, the one thing every
                // other app can draw; this workbook keeps its ranges for a paste here. A chart that draws
                // #REF! or too much data copies nothing. A cut deletes it, as Google's does.
                if (chart && floating) {
                    const item = sheetChartClipboardItem(ctx, chart);
                    if (!item) return;
                    e.preventDefault();
                    writeEigenClipboard(e, { version: 1, items: [item] });
                    globalCache.current.copiedChart = { inline: item.parts, chart };
                    if (e.type === 'cut' && ctx.allowEdit !== false) setContextWithProduce(deleteActiveObject);
                    return;
                }
                // A selected floating image takes precedence over the pending cell copy: its
                // copy is a pure image — eigen JSON only, no text/plain and no png, as vector's is (a
                // native copy event can't await a media/ blob fetch, so png is dropped). A cut deletes it.
                if (image && floating) {
                    const source = mergedSettings.hooks?.resolveImagePath?.(image.mediaName);
                    if (source) {
                        e.preventDefault();
                        // Drop any cell table the keyboard copy staged, so a later native-menu copy
                        // with no image active can't emit this stale table.
                        consumePendingCopy();
                        const item = buildImageClipboardItem({
                            mediaName: image.mediaName,
                            source,
                            box: { width: image.width, height: image.height, angle: image.angle },
                        });
                        writeEigenClipboard(e, { version: 1, items: [item] });
                        if (e.type === 'cut' && ctx.allowEdit !== false) setContextWithProduce(deleteActiveObject);
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
                    items: [buildCellRangeClipboardItem(ctx, pending.cellText)],
                };
                writeEigenClipboard(e, eigenData, pending.plainText, pending.html);
            },
            [mergedSettings.hooks, setContextWithProduce],
        );

        const onPaste = useCallback(
            (e: ClipboardEvent) => {
                // With more than one workbook on a page, only the focused one takes the paste. A selected image or
                // chart holds the focus too.
                const { activeElement } = document;
                const ctx = contextRef.current;
                if (
                    cellInput.current === activeElement ||
                    activeElement?.className === 'sheet-overlay' ||
                    (activeElement?.matches('[data-floating-id]') && workbookContainer.current?.contains(activeElement))
                ) {
                    // The open cell editor pastes into itself, as text. A ⌘V on the grid waits for its paste in
                    // selectionCache, and a paste the grid passes on or takes without handlePaste ends that wait,
                    // so a later paste into the editor can't become a grid paste that closes it.
                    const { clipboardData } = e;
                    if (!clipboardData || ctx.editingCellPosition.length > 0) {
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
                                        pasteChart(draftCtx, crypto.randomUUID(), fields, { width, height }, look);
                                    }
                                });
                            }
                            if (textParts.length > 0) {
                                const syntheticTransfer = new DataTransfer();
                                syntheticTransfer.setData('text/plain', textParts.join('\n'));
                                const syntheticEvent = new ClipboardEvent('paste', {
                                    clipboardData: syntheticTransfer,
                                });
                                setContextWithProduce((draftCtx) => {
                                    try {
                                        handlePaste(draftCtx, syntheticEvent);
                                    } catch (err) {
                                        if (err instanceof ValidationLimitError) throw err;
                                        console.error(err);
                                    }
                                });
                            }
                            return;
                        }
                    }

                    // A paste past the grid's last row adds the rows it needs in its own edit, so a refused paste
                    // adds none.
                    setContextWithProduce((draftCtx) => {
                        try {
                            handlePaste(draftCtx, e);
                        } catch (err) {
                            if (err instanceof ValidationLimitError) throw err;
                            console.error(err);
                        }
                    });
                }
            },
            [setContextWithProduce, mergedSettings.hooks],
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

        useImperativeHandle(
            ref,
            () => generateAPIs(getContext, setContextWithProduce, handleUndo, handleRedo, globalCache.current),
            [getContext, setContextWithProduce, handleUndo, handleRedo],
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
                            <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
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
                                <WorkbookMenuBar
                                    ref={menuBar}
                                    leftItems={toolbarLeftItems}
                                    rightItems={toolbarRightItems}
                                />
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
