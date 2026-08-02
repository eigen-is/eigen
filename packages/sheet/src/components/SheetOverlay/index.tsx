import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { debounce } from 'es-toolkit/compat';
import { type SetContextOptions, WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    api,
    type Context,
    computeOverlayRegions,
    createFilterOptions,
    en,
    type GlobalCache,
    getCellHyperlink,
    getCellRowColumn,
    getRangetxt,
    getSheetIndex,
    handleCellAreaDoubleClick,
    handleCellAreaMouseDown,
    handleOverlayMouseMove,
    handleOverlayMouseUp,
    overlayRegionForCell,
    selectAll,
    showLinkCard,
    tryInsertRowCol,
} from '../../state';
import { useSheetContextMenu } from '../ContextMenu/useSheetContextMenu';
import { DropDownList } from '../DataVerification/DropdownList';
import { ImgBoxs } from '../ImgBoxs';
import { LinkEditCard } from '../LinkEditCard';
import { ColumnHeader } from './ColumnHeader';
import { InputBox } from './InputBox';
import { OverlayRegion } from './OverlayRegion';
import { OverlayVisuals } from './OverlayVisuals';
import { RowHeader } from './RowHeader';

export const SheetOverlay: React.FC = () => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const { info } = en;
    const { showDialog } = useDialog();
    const {
        onContextMenu: cellAreaContextMenu,
        openAtPoint: cellAreaLongPressOpen,
        anchor: cellMenuAnchor,
    } = useSheetContextMenu('cell');
    // Long-press opens the cell menu on touch, running the same select-then-open flow as right-click.
    // The 10 px cancel leaves grid scrolling untouched; the allowEdit gate lives in openAtPoint.
    const cellAreaLongPress = useLongPress(cellAreaLongPressOpen);
    const containerRef = useRef<HTMLDivElement>(null);
    const bottomAddRowInputRef = useRef<HTMLInputElement>(null);
    const [lastRangeText, setLastRangeText] = useState('');
    const [lastCellValue, setLastCellValue] = useState('');
    const { showAlert } = useAlert();
    const cellAreaMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            // Skip cell-selection logic when the click originated inside a floating UI
            // (validation dropdown, hint box, etc.) that should not move the selection.
            if ((e.target as HTMLElement).closest?.('.luckysheet-mousedown-cancel')) return;
            if (e.button !== 2) {
                // onContextMenu event will not call onMouseDown
                setContext((draftCtx) => {
                    const consumed = handleCellAreaMouseDown(
                        draftCtx,
                        refs.globalCache,
                        nativeEvent,
                        refs.cellInput.current!,
                        refs.cellArea.current!,
                        refs.fxInput.current!,
                        refs.canvas.current!.getContext('2d')!,
                    );

                    // Skip the input focus when the mousedown opened the filter menu:
                    // focusing the off-screen cell input auto-scrolls the cell area,
                    // which would snap the grid and close the menu via its
                    // close-on-scroll listener.
                    if (
                        !consumed &&
                        draftCtx.selections?.[0] != null &&
                        Object.keys(draftCtx.selections[0]).length > 0 &&
                        refs.cellInput.current
                    ) {
                        setTimeout(() => {
                            refs.cellInput.current?.focus();
                        });
                    }
                });
            }
        },
        [setContext, refs.globalCache, refs.cellInput, refs.cellArea, refs.fxInput, refs.canvas],
    );

    const cellAreaDoubleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleCellAreaDoubleClick(draftCtx, refs.globalCache, settings, nativeEvent, refs.cellArea.current!);
            });
        },
        [refs.cellArea, refs.globalCache, setContext, settings],
    );

    // cellArea is the native scroll surface; its scroll event is the single
    // source of truth for scroll position. Write globalCache (read by mouse
    // hit-testing and the canvas redraw) and fire the bus — never setContext,
    // which would re-render every context consumer on each scroll tick.
    const onCellAreaScroll = useCallback(() => {
        const el = refs.cellArea.current!;
        refs.globalCache.scrollLeft = el.scrollLeft;
        refs.globalCache.scrollTop = el.scrollTop;
        refs.globalCache.notifyScrollListeners();
    }, [refs.cellArea, refs.globalCache]);

    const onLeftTopClick = useCallback(() => {
        setContext((draftCtx) => {
            selectAll(draftCtx);
        });
    }, [setContext]);

    const debouncedShowLinkCard = useMemo(
        () =>
            debounce((globalCache: GlobalCache, r: number, c: number, isEditing: boolean, skip = false) => {
                if (skip || globalCache.linkCard?.mouseEnter) return;
                setContext((draftCtx) => {
                    showLinkCard(draftCtx, r, c, isEditing);
                });
            }, 800),
        [setContext],
    );

    const overShowLinkCard = useCallback(
        (
            ctx: Context,
            globalCache: GlobalCache,
            e: MouseEvent,
            container: HTMLDivElement,
            scrollEl: HTMLDivElement,
        ) => {
            const rc = getCellRowColumn(ctx, e, container, scrollEl);
            if (rc == null) return;
            const link = getCellHyperlink(ctx, rc.r, rc.c);
            if (link == null) {
                debouncedShowLinkCard(globalCache, rc.r, rc.c, false);
            } else {
                showLinkCard(ctx, rc.r, rc.c, false);
                debouncedShowLinkCard(globalCache, rc.r, rc.c, false, true);
            }
        },
        [debouncedShowLinkCard],
    );

    const pendingMouseMoveRef = useRef<MouseEvent | null>(null);
    const mouseMoveRafRef = useRef(0);

    const onMouseMove = useCallback(
        (nativeEvent: MouseEvent) => {
            // Store the latest event and coalesce via rAF so that multiple
            // mousemove events within one frame produce only one state update.
            pendingMouseMoveRef.current = nativeEvent;
            if (mouseMoveRafRef.current) return;
            mouseMoveRafRef.current = requestAnimationFrame(() => {
                mouseMoveRafRef.current = 0;
                const ev = pendingMouseMoveRef.current;
                if (!ev) return;
                pendingMouseMoveRef.current = null;
                setContext(
                    (draftCtx) => {
                        // Skip link-card hover detection during active selection drag
                        if (!draftCtx.selectionActive && !draftCtx.scrolling) {
                            overShowLinkCard(
                                draftCtx,
                                refs.globalCache,
                                ev,
                                containerRef.current!,
                                refs.cellArea.current!,
                            );
                        }
                        handleOverlayMouseMove(
                            draftCtx,
                            refs.globalCache,
                            ev,
                            refs.cellInput.current!,
                            refs.cellArea.current!,
                            containerRef.current!,
                            refs.fxInput.current,
                        );
                    },
                    { noHistory: true },
                );
            });
        },
        [overShowLinkCard, refs.cellArea, refs.cellInput, refs.fxInput, refs.globalCache, setContext],
    );

    const onMouseUp = useCallback(
        (nativeEvent: MouseEvent) => {
            setContext((draftCtx) => {
                try {
                    handleOverlayMouseUp(
                        draftCtx,
                        refs.globalCache,
                        settings,
                        nativeEvent,
                        refs.cellArea.current!,
                        containerRef.current!,
                        refs.cellInput.current,
                        refs.fxInput.current,
                    );
                } catch (e) {
                    if (e instanceof Error) showAlert(e.message);
                }
            });
        },
        [refs.cellArea, refs.cellInput, refs.fxInput, refs.globalCache, setContext, settings, showAlert],
    );

    const handleBottomAddRow = useCallback(() => {
        const valueStr = bottomAddRowInputRef.current?.value || context.addDefaultRows.toString();
        const value = parseInt(valueStr, 10);
        if (Number.isNaN(value)) {
            return;
        }
        if (value < 1) {
            return;
        }
        const insertRowColOp: SetContextOptions['insertRowColOp'] = {
            type: 'row',
            index:
                context.sheets[getSheetIndex(context, context!.currentSheetId! as string) as number].data!.length - 1,
            count: value,
            direction: 'rightbottom',
            id: context.currentSheetId,
        };
        setContext(
            (draftCtx) => {
                const error = tryInsertRowCol(draftCtx, insertRowColOp, false);
                if (error) showAlert(error, 'ok');
            },
            { insertRowColOp },
        );
    }, [context, setContext, showAlert]);

    useEffect(() => {
        setContext((draftCtx) => {
            const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIndex == null) return;

            const currentSheet = draftCtx.sheets[sheetIndex];

            // Only reset selection if there's no existing selection
            if (!currentSheet.selections?.length) {
                api.setSelection(draftCtx, [{ row: [0, 0], column: [0, 0] }], {});
            }
        });
    }, [setContext]);

    // Warning dialog
    // biome-ignore lint/correctness/useExhaustiveDependencies: only fires when a new warnDialog message arrives; showDialog from useDialog is stable
    useEffect(() => {
        if (context.warnDialog) {
            setTimeout(() => {
                showDialog(context.warnDialog, 'ok');
            }, 240);
        }
    }, [context.warnDialog]);

    // Apply explicit programmatic scrolls (selection-follow, freeze reset, sheet-switch
    // restore) to the native scroll surface, post-commit so layout is settled. Keyed on
    // scrollRequest (a fresh object per request) — NOT on the scrollLeft/scrollTop mirror,
    // which syncScroll updates every recipe and would otherwise rewind an in-progress scroll.
    useEffect(() => {
        const req = context.scrollRequest;
        const el = refs.cellArea.current;
        if (!req || !el) return;
        if (req.left != null) el.scrollLeft = req.left;
        if (req.top != null) el.scrollTop = req.top;
    }, [context.scrollRequest, refs.cellArea]);

    // Keep ctx.filter/filterRange in sync with the current sheet and recompute the
    // filter-button geometry (ctx.filterOptions) the canvas draws every frame —
    // row/col metric changes, sheet switches and filter-range edits all re-derive.
    const sheetIndex = getSheetIndex(context, context.currentSheetId);
    const sheetFilterRange = sheetIndex == null ? undefined : context.sheets[sheetIndex].filterRange;
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers — body reads `draftCtx` so biome can't see the connection
    useEffect(() => {
        setContext((draftCtx) => {
            const sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIdx == null) return;
            draftCtx.filterRange = draftCtx.sheets[sheetIdx].filterRange;
            draftCtx.filter = draftCtx.sheets[sheetIdx].filter || {};
            createFilterOptions(draftCtx, draftCtx.filterRange, undefined);
        });
    }, [context.visibledatarow, context.visibledatacolumn, setContext, context.currentSheetId, sheetFilterRange]);

    // The filter dropdown is position:fixed, positioned once from globalCache scroll
    // offsets, so it detaches from its column icon once the grid scrolls. Close it on
    // any scroll (standard dropdown behavior) — only subscribe while it is open.
    useEffect(() => {
        if (!context.filterContextMenu) return;
        const close = () => {
            setContext((d) => {
                d.filterContextMenu = undefined;
            });
        };
        refs.globalCache.scrollListeners.add(close);
        return () => {
            refs.globalCache.scrollListeners.delete(close);
        };
    }, [context.filterContextMenu, refs.globalCache, setContext]);

    useEffect(() => {
        document.addEventListener('mousemove', onMouseMove);
        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            cancelAnimationFrame(mouseMoveRafRef.current);
        };
    }, [onMouseMove]);

    useEffect(() => {
        document.addEventListener('mouseup', onMouseUp);
        return () => {
            document.removeEventListener('mouseup', onMouseUp);
        };
    }, [onMouseUp]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: range text recomputed on selection/sheet changes; context.config.merge is read but stable per sheet
    const rangeText = useMemo(() => {
        const lastSelection = context.selections?.at(-1);
        if (!(lastSelection && lastSelection.row_focus != null && lastSelection.column_focus != null)) return '';
        const rf = lastSelection.row_focus;
        const cf = lastSelection.column_focus;
        if (context.config.merge != null && `${rf}_${cf}` in context.config.merge) {
            return getRangetxt(context, context.currentSheetId, {
                column: [cf, cf],
                row: [rf, rf],
            });
        }

        const rawRangeTxt = getRangetxt(context, context.currentSheetId, lastSelection);
        // Return with formatting for better screen reading
        // Format single-cell selections (e.g., "AA12" → "AA. 12")
        // Format range selections (e.g., "A1:BB100" → "A. 1: BB. 100")
        return rawRangeTxt.replace(/([A-Z]+)(\d+)/g, '$1. $2');
    }, [context.currentSheetId, context.selections]);

    const cellValue = () => {
        if ((context.selections?.length ?? 0) > 0) {
            const selection = context.selections?.[context.selections.length - 1];
            if (!selection) return '';
            const sheetIndex = getSheetIndex(context, context.currentSheetId);
            if (sheetIndex === undefined || sheetIndex === null) return '';
            const rowFocus = selection.row_focus ?? 0;
            const columnFocus = selection.column_focus ?? 0;
            const cellVal = context.sheets[sheetIndex]?.data?.[rowFocus]?.[columnFocus]?.m || '';
            return cellVal;
        }
        return '';
    };

    const computedCellValue = cellValue();

    // Pane regions replace the per-element freeze clamps (RENDERING.md
    // § Scrolling): the passive visuals render into every region and each
    // region's clip shows exactly its portion; stateful singletons render into
    // the single region containing their anchor cell.
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const regions = computeOverlayRegions(freeze, context.cellmainWidth, context.cellmainHeight);
    const firstSel = context.selections?.[0];
    const lastSel = context.selections?.at(-1);
    const editorRegion = overlayRegionForCell(regions, freeze, firstSel?.row_focus ?? 0, firstSel?.column_focus ?? 0);
    const dvRegion = overlayRegionForCell(regions, freeze, lastSel?.row_focus ?? 0, lastSel?.column_focus ?? 0);
    const linkRegion = context.linkCard
        ? overlayRegionForCell(regions, freeze, context.linkCard.r, context.linkCard.c)
        : regions[0];

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot snapshot on focus toggle — adding rangeText/cellValue as deps would re-snapshot on every selection change and overwrite the cached "last" values
    useEffect(() => {
        if (context.sheetFocused) {
            setLastRangeText(String(rangeText));
            setLastCellValue(String(cellValue()));
        }
    }, [context.sheetFocused]);

    return (
        <main
            className="fortune-sheet-overlay"
            ref={containerRef}
            tabIndex={-1}
            style={{
                width: context.tableContentSize[0],
                height: context.tableContentSize[1],
            }}
        >
            <div className="fortune-col-header-wrap">
                <div
                    className="fortune-left-top"
                    onClick={onLeftTopClick}
                    tabIndex={0}
                    style={{
                        width: context.rowHeaderWidth - 1.5,
                        height: context.columnHeaderHeight - 1.5,
                    }}
                />
                <ColumnHeader />
            </div>
            <div className="fortune-row-body">
                <RowHeader />
                <div
                    ref={refs.cellArea}
                    className="fortune-cell-area"
                    onMouseDown={cellAreaMouseDown}
                    onDoubleClick={cellAreaDoubleClick}
                    onContextMenu={cellAreaContextMenu}
                    onScroll={onCellAreaScroll}
                    {...cellAreaLongPress}
                    style={{
                        width: context.cellmainWidth,
                        height: context.cellmainHeight,
                        cursor: context.cellSelectExtending
                            ? 'crosshair'
                            : context.filterButtonHover != null
                              ? 'pointer'
                              : 'default',
                    }}
                >
                    <div className="fortune-cell-overlay-layer">
                        {/* Validation dropdown trigger: its own pane wrapper before the
                            passive regions, so it keeps painting under the selection
                            tints (old z-10 vs z-14/15). */}
                        <OverlayRegion {...dvRegion}>
                            <DropDownList />
                        </OverlayRegion>
                        {regions.map(({ pane, ...rect }) => (
                            <OverlayRegion key={pane} {...rect}>
                                <OverlayVisuals containerRef={containerRef} />
                                {pane === 'main' && <ImgBoxs />}
                            </OverlayRegion>
                        ))}
                        <OverlayRegion {...editorRegion}>
                            <InputBox />
                        </OverlayRegion>
                        {/* Popup chrome (hint box, link card) pins with its anchor's pane
                            but never clips — popups overflow pane boundaries, like the
                            portaled dropdowns. */}
                        <OverlayRegion
                            left={0}
                            top={0}
                            width={0}
                            height={0}
                            clip={false}
                            fixedLeft={dvRegion.fixedLeft}
                            fixedTop={dvRegion.fixedTop}
                        >
                            {/* eigen-paper-chrome: popup chrome re-themes with the
                                app inside the light-pinned workbook surface. */}
                            <div
                                id="luckysheet-dataVerification-showHintBox"
                                className="luckysheet-mousedown-cancel eigen-paper-chrome"
                            />
                        </OverlayRegion>
                        {context.linkCard?.sheetId === context.currentSheetId && (
                            <OverlayRegion
                                left={0}
                                top={0}
                                width={0}
                                height={0}
                                clip={false}
                                fixedLeft={linkRegion.fixedLeft}
                                fixedTop={linkRegion.fixedTop}
                            >
                                <LinkEditCard {...context.linkCard} />
                            </OverlayRegion>
                        )}
                        {/* Pane-spanning drag lines stay unclipped on the main transform. */}
                        <OverlayRegion
                            left={0}
                            top={0}
                            width={0}
                            height={0}
                            clip={false}
                            fixedLeft={null}
                            fixedTop={null}
                        >
                            <div
                                className="fortune-change-size-line"
                                hidden={
                                    !context.colsResizing &&
                                    !context.rowsResizing &&
                                    !context.colsFreezeDragging &&
                                    !context.rowsFreezeDragging
                                }
                            />
                            <div
                                className="fortune-freeze-drag-line"
                                hidden={!context.colsFreezeDragging && !context.rowsFreezeDragging}
                            />
                        </OverlayRegion>
                    </div>
                    {cellMenuAnchor}
                    <div id="luckysheet-cell-flow_0" className="luckysheet-cell-flow luckysheetsheetchange">
                        <div className="luckysheet-cell-flow-clip">
                            <div id="luckysheetcoltable_0" className="luckysheet-cell-flow-col">
                                <div
                                    id="luckysheet-sheettable_0"
                                    className="luckysheet-cell-sheettable"
                                    style={{
                                        height: context.rh_height,
                                        width: context.ch_width,
                                    }}
                                />
                                {/* No eigen-paper-chrome: the add-row control sits
                                    directly ON the light-pinned paper (no opaque card
                                    behind it), so it renders light in both themes —
                                    dark-themed controls would be illegible here. */}
                                <div
                                    id="luckysheet-bottom-controll-row"
                                    className="luckysheet-bottom-controll-row flex items-center gap-2"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onMouseUp={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    onKeyUp={(e) => e.stopPropagation()}
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                    style={{
                                        left: context.scrollLeft,
                                        display: context.allowEdit ? undefined : 'none',
                                    }}
                                >
                                    <Button variant="outline" size="sm" onClick={handleBottomAddRow}>
                                        {info.add}
                                    </Button>
                                    <Input
                                        ref={bottomAddRowInputRef}
                                        type="text"
                                        className="h-8 w-16"
                                        placeholder={context.addDefaultRows.toString()}
                                    />
                                    <span className="text-sm text-muted-foreground">
                                        {info.row} ({info.addLast})
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="ml-2"
                                        onClick={() => {
                                            // cellArea is the scroll source; its native scroll
                                            // event syncs globalCache and triggers the redraw.
                                            refs.cellArea.current!.scrollTop = 0;
                                        }}
                                    >
                                        {info.backTop}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div id="sr-selection" className="sr-only" role="alert">
                {!rangeText.includes('NaN') ? `${rangeText} ${computedCellValue}` : `A1. ${info.sheetSrIntro}`}
            </div>
            <div id="sr-sheetFocus" className="sr-only" role="alert">
                {context.sheetFocused
                    ? `${lastRangeText} ${lastCellValue ? `${lastCellValue}.` : ''} ${info.sheetIsFocused}`
                    : `Toolbar. ${info.sheetNotFocused}`}
            </div>
        </main>
    );
};
