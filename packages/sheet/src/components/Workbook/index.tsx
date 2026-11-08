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
import { isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { enablePatches, produce, produceWithPatches } from 'immer';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { RefValues, SetContextOptions } from '../../context';
import { WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import { copySheetChartSpec, resolveRangeChartData, seriesName } from '../../engine/chart-data';
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
    stepNewestEntry,
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
    // The sheets after each change, with the sheet the tab shows.
    onChange?: (data: SheetType[], currentSheetId: string) => void;
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

        // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the props' values, spread, which biome can't read
        const mergedSettings = useMemo(() => ({ ...defaultSettings, ...props }), [...Object.values(props)]);

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
            const step = stepNewestEntry(contextRef.current, undoList, redoList, undoEntry);
            if (!step) return;
            commit(step.ctx);
            if (step.ops.length > 0) onOp?.(step.ops);
        }, [commit, onOp]);

        const handleRedo = useCallback(() => {
            if (contextRef.current.allowEdit === false) return;
            const { undoList, redoList } = globalCache.current;
            const step = stepNewestEntry(contextRef.current, redoList, undoList, redoEntry);
            if (!step) return;
            commit(step.ctx);
            if (step.ops.length > 0) onOp?.(step.ops);
        }, [commit, onOp]);

        useEffect(() => {
            if (context.selections != null) {
                mergedSettings.hooks?.afterSelectionChange?.(context.currentSheetId, context.selections[0]);
            }
        }, [context.currentSheetId, context.selections, mergedSettings.hooks]);

        // Tells the app about the selected image or chart, so it can mount its properties panel. It fires on select,
        // on deselect and after a write. Immer keeps the record's reference while it is unchanged, and the item is
        // memoized on it, so the app's setState bails out when nothing moved.
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
                onChange?.(context.sheets, context.currentSheetId);
            }
        }, [context.sheets, context.currentSheetId, onChange]);

        useEffect(() => {
            setContextWithProduce(
                (draftCtx) => {
                    draftCtx.allowEdit = mergedSettings.allowEdit;
                    draftCtx.hooks = mergedSettings.hooks;
                    if (draftCtx.sheets.length === 0) {
                        // Each sheet is copied one level deep, and its cells stay shared: a deep copy of a large
                        // import takes about a second. The init below writes only a sheet's own fields and keeps a
                        // matrix the sheet has, so a remount can run it again on the same data, and the shared cells,
                        // which immer freezes, are never written.
                        draftCtx.sheets = originalData.map((sheet) => ({
                            ...sheet,
                            id: sheet.id ?? crypto.randomUUID(),
                        }));
                        ensureSheetIndex(draftCtx.sheets);
                        for (const sheet of draftCtx.sheets) initSheetData(sheet);
                        // The list of formula cells is seeded without computing them. An imported or stored sheet
                        // carries its computed values, and an edit computes the formulas it affects.
                        api.seedCalcChain(draftCtx);
                        if (!draftCtx.currentSheetId) initSheetIndex(draftCtx);
                        const sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
                        if (sheetIdx == null) return;
                        const stored = draftCtx.sheets[sheetIdx].selections;
                        if (!draftCtx.selections?.length && stored?.length) draftCtx.selections = stored;
                        // A sheet with no stored selection gets its first one when the grid overlay mounts.
                        applySheetView(draftCtx);
                    }
                },
                { noHistory: true },
            );
        }, [originalData, mergedSettings.allowEdit, mergedSettings.hooks, setContextWithProduce]);

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
                // A selected floating image wins over the pending cell copy. Its copy is only the Eigen clipboard
                // item, as Vector's is: no plain text and no PNG, because a native copy event can't wait for the
                // image's file to load. A cut deletes the image.
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

                // The cells go out as an Eigen text item, the same way the image above does. The sheet's HTML table
                // follows the marker span, so an app outside Eigen still pastes a real table. The Eigen item travels
                // under its own MIME type, which a read from the same origin picks up.
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

                    // A copy between sheets of this tab marks its HTML with COPY_ACTION_TABLE_MARKER and pastes
                    // from ctx.copyState, which keeps the formulas and formats. The classifier then reports no
                    // Eigen or SVG content, so the paste falls through to the table paste below.
                    const paste = classifyPaste(clipboardData, { internalMarkerText: COPY_ACTION_TABLE_MARKER });

                    // A Vector selection or a pasted SVG document becomes one floating image, through the app's
                    // image file path. It goes before the split into Eigen items, so a Vector selection lands as
                    // one image and not as its separate items. An SVG with images names them as eigen-media
                    // references, so it goes to onPasteSvgFile, which stores each image before the SVG. An SVG
                    // without images goes to onPasteImageFile.
                    if (paste.svg) {
                        const svgImageItems = paste.svg.items.filter(
                            (item): item is EigenClipboardImageItem => item.type === 'image',
                        );
                        const onPasteSvgFile = mergedSettings.hooks?.onPasteSvgFile;
                        const onPasteImageFile = mergedSettings.hooks?.onPasteImageFile;
                        if (onPasteSvgFile) {
                            // It goes there even without image items, so a forged or dangling eigen-media
                            // reference is stripped before the SVG is stored, as in Docs and Slides.
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
                        // A mixed Eigen payload splits by kind. Image and chart items become floating
                        // objects, and text items land in cells, all in one paste. The app inserts the
                        // images itself, at their copied size and re-uploaded from another mount, so
                        // they paste only when its hook is set.
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
                            <WorkbookMenuBar
                                ref={menuBar}
                                leftItems={toolbarLeftItems}
                                rightItems={toolbarRightItems}
                            />
                            <FxEditor />
                        </div>
                        <Sheet sheet={sheet} />
                        <SheetTab />
                        <FilterMenu />
                    </div>
                </ModalProvider>
            </WorkbookContext.Provider>
        );
    },
);
