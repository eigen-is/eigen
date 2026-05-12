import { readEigenClipboard } from '@workspace/lib/clipboard';
import type { EigenClipboardData, EigenClipboardTextItem } from '@workspace/lib/types/clipboard';
import { cloneDeep } from 'es-toolkit/compat';
import { applyPatches, enablePatches, type Patch, produce, produceWithPatches } from 'immer';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { type RefValues, type SetContextOptions, WorkbookContext } from '../../context';
import { ModalProvider } from '../../context/modal';
import type { CellMatrix } from '../../engine/types';
import {
    api,
    type CellWithRowAndCol,
    type Context,
    calcSelectionInfo,
    defaultContext,
    defaultSettings,
    ensureSheetIndex,
    filterPatch,
    type GlobalCache,
    getSheetIndex,
    groupValuesRefresh,
    handleGlobalKeyDown,
    handlePaste,
    initSheetIndex,
    insertRowCol,
    inverseRowColOptions,
    locale,
    type Op,
    patchToOp,
    type Settings,
    type Sheet as SheetType,
} from '../../state';
import { consumePendingCopy } from '../../state/modules/clipboard';
import { ContextMenu } from '../ContextMenu';
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
            .filter((oneSheet) => ctx.sheets.map((item) => item.id).indexOf(oneSheet.id) === -1)
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
        const scrollbarX = useRef<HTMLDivElement>(null);
        const scrollbarY = useRef<HTMLDivElement>(null);
        const cellArea = useRef<HTMLDivElement>(null);
        const workbookContainer = useRef<HTMLDivElement>(null);

        const refs: RefValues = useMemo(
            () => ({
                globalCache: globalCache.current,
                cellInput,
                fxInput,
                canvas,
                scrollbarX,
                scrollbarY,
                cellArea,
                workbookContainer,
            }),
            [],
        );

        const [context, setContext] = useState(defaultContext(refs));
        const { info, formula } = locale(context);

        const [calInfo, setCalInfo] = useState<{
            numberC: number;
            count: number;
            sum: string;
            max: string;
            min: string;
            average: string;
        }>({
            numberC: 0,
            count: 0,
            sum: '0',
            max: '0',
            min: '0',
            average: '',
        });

        // biome-ignore lint/correctness/useExhaustiveDependencies: deps spread from Object.values(props) — biome can't see through the spread
        const mergedSettings = useMemo(
            () => Object.assign(cloneDeep(defaultSettings), props) as Required<Settings>,
            [...Object.values(props)],
        );

        // Calculate selection info
        // biome-ignore lint/correctness/useExhaustiveDependencies: selection-info recompute is intentionally selection-only; firing on every props/context change would churn
        useEffect(() => {
            const selection = context.selections;
            if (selection) {
                const re = calcSelectionInfo(context);
                setCalInfo(re);
            }
        }, [context.selections]);

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
                            globalCache.current.undoList.push({
                                patches: filteredPatches,
                                inversePatches: filteredInversePatches,
                                options,
                            });
                            globalCache.current.redoList = [];
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
                        newContext = produce(newContext, (draft) => {
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
        }, [emitOp]);

        const handleRedo = useCallback(() => {
            const history = globalCache.current.redoList.pop();
            if (history) {
                setContext((ctx_) => {
                    let newContext = applyPatches(ctx_, history.patches);
                    const si = getSheetIndex(newContext, newContext.currentSheetId);
                    if (si != null) {
                        newContext = produce(newContext, (draft) => {
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
        }, [emitOp]);

        useEffect(() => {
            if (context.selections != null) {
                mergedSettings.hooks?.afterSelectionChange?.(context.currentSheetId, context.selections[0]);
            }
        }, [context.currentSheetId, context.selections, mergedSettings.hooks]);

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
                        draftCtx.sheets = cloneDeep(originalData);
                        ensureSheetIndex(draftCtx.sheets, mergedSettings.generateSheetId);
                        for (const newDatum of draftCtx.sheets) {
                            const index = getSheetIndex(draftCtx, newDatum.id!) as number;
                            const sheet = draftCtx.sheets[index];
                            if (!sheet.data || sheet.data.length === 0) {
                                api.initSheetData(draftCtx, index, sheet);
                            }
                        }
                        // Recompute formulas so displayed values reflect current inputs
                        // (imported sheets may arrive with stale cached results).
                        // calcChain is populated as a side-effect, and formulaCellInfoMap
                        // lazy-primes on the first edit via execFunctionGroup.
                        api.calculateFormula(draftCtx);
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

                    let { data } = sheet;
                    if (!data || data.length === 0) {
                        data = api.initSheetData(draftCtx, sheetIdx, sheet);
                    }

                    if (
                        (!draftCtx.selections || draftCtx.selections.length === 0) &&
                        sheet.selections &&
                        sheet.selections.length > 0
                    ) {
                        draftCtx.selections = sheet.selections;
                    }
                    if (draftCtx.selections?.length === 0) {
                        if (data?.[0]?.[0]?.mc && data?.[0]?.[0]?.mc?.rs != null && data?.[0]?.[0]?.mc?.cs != null) {
                            draftCtx.selections = [
                                {
                                    row: [0, data[0][0].mc.rs - 1],
                                    column: [0, data[0][0].mc.cs - 1],
                                },
                            ];
                        } else {
                            draftCtx.selections = [
                                {
                                    row: [0, 0],
                                    column: [0, 0],
                                },
                            ];
                        }
                    }

                    draftCtx.config = sheet.config ?? {};
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

        const onCopy = useCallback((e: ClipboardEvent) => {
            const pending = consumePendingCopy();
            if (!pending) return;

            e.preventDefault();

            // Build eigen clipboard data with the cell text
            const eigenData: EigenClipboardData = {
                version: 1,
                items: [{ type: 'text', text: pending.plainText }],
            };

            // Embed eigen clipboard marker in the HTML alongside the sheet HTML table
            const eigenJson = JSON.stringify(eigenData);
            const eigenMarker = `<span data-eigen-clipboard="${encodeURIComponent(eigenJson)}"></span>`;
            const combinedHtml = eigenMarker + pending.html;

            e.clipboardData?.setData('text/html', combinedHtml);
            e.clipboardData?.setData('text/plain', pending.plainText);
            // Also set the custom MIME type for same-origin reads
            e.clipboardData?.setData('application/eigen-clipboard', eigenJson);
        }, []);

        const onPaste = useCallback(
            (e: ClipboardEvent) => {
                // deal with multi instance case, only the focused sheet handles the paste
                if (
                    cellInput.current === document.activeElement ||
                    document.activeElement?.className === 'fortune-sheet-overlay'
                ) {
                    const { clipboardData } = e;
                    if (!clipboardData) return;

                    // Check for eigen clipboard data from other eigen apps (docs, slides, etc.)
                    // but only if this is NOT an internal sheet→sheet copy (which uses HTML with fortune-copy-action-table)
                    const htmlData = clipboardData.getData('text/html');
                    const isInternalCopy = htmlData?.includes('fortune-copy-action-table');

                    if (!isInternalCopy) {
                        const eigenData = readEigenClipboard(clipboardData);
                        if (eigenData) {
                            // Extract text from eigen clipboard items and paste as plain text
                            const textParts = eigenData.items
                                .filter((item): item is EigenClipboardTextItem => item.type === 'text')
                                .map((item) => item.text);
                            if (textParts.length > 0) {
                                e.preventDefault();
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
                                return;
                            }
                        }
                    }

                    const txtdata = htmlData || clipboardData.getData('text/plain');
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
            [context, setContextWithProduce],
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
            () =>
                generateAPIs(
                    context,
                    setContextWithProduce,
                    handleUndo,
                    handleRedo,
                    mergedSettings,
                    cellInput.current,
                    scrollbarX.current,
                    scrollbarY.current,
                ),
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
                            <h2 id="shortcuts-heading">{info.shortcuts}</h2>
                            <ul>
                                <li>{info.toggleSheetFocusShortcut}</li>
                                <li>{info.selectRangeShortcut}</li>
                                <li>{info.autoFillDownShortcut}</li>
                                <li>{info.autoFillRightShortcut}</li>
                                <li>{info.boldTextShortcut}</li>
                                <li>{info.copyShortcut}</li>
                                <li>{info.pasteShortcut}</li>
                                <li>{info.undoShortcut}</li>
                                <li>{info.redoShortcut}</li>
                                <li>{info.deleteCellContentShortcut}</li>
                                <li>{info.confirmCellEditShortcut}</li>
                                <li>{info.moveRightShortcut}</li>
                                <li>{info.moveLeftShortcut}</li>
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
                        <ContextMenu />
                        <FilterMenu />
                        {context.contextMenu && Object.keys(context.contextMenu).length > 0 && (
                            <div
                                onMouseDown={() => {
                                    setContextWithProduce((draftCtx) => {
                                        draftCtx.contextMenu = {};
                                        draftCtx.filterContextMenu = undefined;
                                    });
                                }}
                                onMouseMove={(e) => e.stopPropagation()}
                                onMouseUp={(e) => e.stopPropagation()}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                                className="absolute top-0 left-0 z-30 h-full w-full"
                            />
                        )}
                        <div className="flex justify-end items-center leading-[0] h-0">
                            <div className="luckysheet-sheet-selection-calInfo">
                                {!!calInfo.count && (
                                    <div style={{ width: '60px' }}>
                                        {formula.count}: {calInfo.count}
                                    </div>
                                )}
                                {!!calInfo.numberC && !!calInfo.sum && (
                                    <div>
                                        {formula.sum}: {calInfo.sum}
                                    </div>
                                )}
                                {!!calInfo.numberC && !!calInfo.average && (
                                    <div>
                                        {formula.average}: {calInfo.average}
                                    </div>
                                )}
                                {!!calInfo.numberC && !!calInfo.max && (
                                    <div>
                                        {formula.max}: {calInfo.max}
                                    </div>
                                )}
                                {!!calInfo.numberC && !!calInfo.min && (
                                    <div>
                                        {formula.min}: {calInfo.min}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </ModalProvider>
            </WorkbookContext.Provider>
        );
    },
);
