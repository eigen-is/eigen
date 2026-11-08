// The DOM layer over the grid canvas: the row and column headers, the scrolling cell area with the cell editor,
// selections and floating images and charts, the validation and link cards, and the add-rows footer. It turns the
// pointer's down, move, up and double click on the cell area into the state handlers, such as
// handleCellAreaMouseDown, and coalesces mouse moves to one update per frame. A press that closes an open app-bar
// menu is marked before the cells or a header read it, so it puts no reference into a formula.

import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { pressClosesMenu } from '@workspace/ui/components/menubar';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { debounce } from 'es-toolkit/compat';
import type { SetContextOptions } from '../../context';
import { WorkbookContext } from '../../context';
import { cellDisplay } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import type { Context, GlobalCache } from '../../state';
import {
    api,
    applySheetFilter,
    computeOverlayRegions,
    getCellHyperlink,
    getCellRowColumn,
    getFlowdata,
    getRangetxt,
    getSheetConfig,
    getSheetIndex,
    handleCellAreaDoubleClick,
    handleCellAreaMouseDown,
    handleOverlayMouseMove,
    handleOverlayMouseUp,
    isAllowEdit,
    overlayRegionForCell,
    selectAll,
    showLinkCard,
    tryInsertRowCol,
    ValidationLimitError,
} from '../../state';
import { useSheetContextMenu } from '../ContextMenu/useSheetContextMenu';
import { DropdownList } from '../DataValidation/DropdownList';
import { ValidationHintCard } from '../DataValidation/HintCard';
import { FloatingObjects } from '../FloatingObjects';
import { LinkEditCard } from '../LinkEditCard';
import { ColumnHeader } from './ColumnHeader';
import { InputBox } from './InputBox';
import { OverlayRegion } from './OverlayRegion';
import { OverlayVisuals } from './OverlayVisuals';
import { RowHeader } from './RowHeader';

export const SheetOverlay: React.FC = () => {
    const { context, getContext, setContext, refs } = useContext(WorkbookContext);
    const { showNotice } = useDialog();
    const {
        onContextMenu: cellAreaContextMenu,
        openAtPoint: cellAreaLongPressOpen,
        anchor: cellMenuAnchor,
    } = useSheetContextMenu('cell');
    // A long press opens the cell menu on touch. The cell surface has a single menu, so bind carries no item.
    const cellAreaLongPress = useLongPress<null>((_item, x, y) => cellAreaLongPressOpen(x, y));
    const containerRef = useRef<HTMLDivElement>(null);
    const bottomAddRowInputRef = useRef<HTMLInputElement>(null);
    const [lastRangeText, setLastRangeText] = useState('');
    const [lastCellValue, setLastCellValue] = useState('');
    const cellAreaMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            // A click inside a floating UI, such as a validation dropdown, must not move the selection.
            if (e.target instanceof Element && e.target.closest('.sheet-mousedown-cancel')) return;
            if (e.button !== 2) {
                // onContextMenu event will not call onMouseDown
                setContext((draftCtx) => {
                    // The recipe can run after the grid unmounts, and then its refs are unset.
                    const cellInput = refs.cellInput.current;
                    const cellArea = refs.cellArea.current;
                    if (!cellInput || !cellArea) return;
                    const consumed = handleCellAreaMouseDown(
                        draftCtx,
                        refs.globalCache,
                        nativeEvent,
                        cellInput,
                        cellArea,
                        refs.fxInput.current,
                        refs.canvas.current?.getContext('2d') ?? undefined,
                    );

                    // Focusing the off-screen cell input scrolls the cell area, and the scroll or the focus shift
                    // closes a menu this mousedown just opened.
                    if (
                        !consumed &&
                        !draftCtx.validationListOpen &&
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
                const cellArea = refs.cellArea.current;
                if (!cellArea) return;
                handleCellAreaDoubleClick(draftCtx, refs.globalCache, nativeEvent, cellArea);
            });
        },
        [refs.cellArea, refs.globalCache, setContext],
    );

    // Never setContext here: it would re-render every context consumer on each scroll tick.
    const onCellAreaScroll = useCallback(() => {
        const el = refs.cellArea.current;
        if (!el) return;
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
            pendingMouseMoveRef.current = nativeEvent;
            if (mouseMoveRafRef.current) return;
            mouseMoveRafRef.current = requestAnimationFrame(() => {
                mouseMoveRafRef.current = 0;
                const ev = pendingMouseMoveRef.current;
                if (!ev) return;
                pendingMouseMoveRef.current = null;
                setContext(
                    (draftCtx) => {
                        const container = containerRef.current;
                        const cellArea = refs.cellArea.current;
                        const cellInput = refs.cellInput.current;
                        if (!container || !cellArea || !cellInput) return;
                        // Skip link-card hover detection during active selection drag, and while the pointer is
                        // over a menu or dialog portaled above the grid: the cell under it is not hovered.
                        if (
                            !draftCtx.selectionActive &&
                            !draftCtx.scrolling &&
                            ev.target instanceof Node &&
                            cellArea.contains(ev.target)
                        ) {
                            overShowLinkCard(draftCtx, refs.globalCache, ev, container, cellArea);
                        }
                        handleOverlayMouseMove(
                            draftCtx,
                            refs.globalCache,
                            ev,
                            cellInput,
                            cellArea,
                            container,
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
                const cellArea = refs.cellArea.current;
                const container = containerRef.current;
                if (!cellArea || !container) return;
                try {
                    handleOverlayMouseUp(
                        draftCtx,
                        refs.globalCache,
                        nativeEvent,
                        cellArea,
                        container,
                        refs.cellInput.current,
                        refs.fxInput.current,
                    );
                } catch (e) {
                    if (e instanceof ValidationLimitError) throw e;
                    if (e instanceof Error) showNotice(e.message);
                }
            });
        },
        [refs.cellArea, refs.cellInput, refs.fxInput, refs.globalCache, setContext, showNotice],
    );

    const handleBottomAddRow = useCallback(() => {
        const ctx = getContext();
        const valueStr = bottomAddRowInputRef.current?.value || ctx.addDefaultRows.toString();
        const value = parseInt(valueStr, 10);
        if (Number.isNaN(value) || value < 1) return;
        const data = getFlowdata(ctx);
        if (!data) return;
        const insertRowColOp: SetContextOptions['insertRowColOp'] = {
            type: 'row',
            index: data.length - 1,
            count: value,
            direction: 'rightbottom',
            id: ctx.currentSheetId,
        };
        setContext(
            (draftCtx) => {
                const error = tryInsertRowCol(draftCtx, insertRowColOp, false);
                if (error) showNotice(error);
            },
            { insertRowColOp },
        );
    }, [getContext, setContext, showNotice]);

    useEffect(() => {
        setContext((draftCtx) => {
            const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIndex == null) return;
            if (!draftCtx.sheets[sheetIndex].selections?.length) {
                api.setSelection(draftCtx, [{ row: [0, 0], column: [0, 0] }]);
            }
        });
    }, [setContext]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per new warnDialog message; showNotice + setContext are stable
    useEffect(() => {
        if (context.warnDialog) {
            // Consume the event so repeating the same invalid op warns again.
            const message = context.warnDialog;
            setTimeout(() => showNotice(message), 240);
            setContext((ctx) => {
                ctx.warnDialog = undefined;
            });
        }
    }, [context.warnDialog]);

    // Keyed on scrollRequest, a fresh object per request, not on the scrollLeft and scrollTop mirror: syncScroll updates
    // that on every recipe, which would rewind a scroll in progress.
    useEffect(() => {
        const req = context.scrollRequest;
        const el = refs.cellArea.current;
        if (!req || !el) return;
        if (req.left != null) el.scrollLeft = req.left;
        if (req.top != null) el.scrollTop = req.top;
    }, [context.scrollRequest, refs.cellArea]);

    const sheetIndex = getSheetIndex(context, context.currentSheetId);
    const sheetFilterRange = sheetIndex == null ? undefined : context.sheets[sheetIndex].filterRange;
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers — body reads `draftCtx` so biome can't see the connection
    useEffect(() => {
        setContext((draftCtx) => applySheetFilter(draftCtx));
    }, [
        context.visibledatarow,
        context.visibledatacolumn,
        setContext,
        context.currentSheetId,
        context.allowEdit,
        sheetFilterRange,
    ]);

    // The filter dropdown is position:fixed, so it detaches from its column icon once the grid scrolls.
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

    // biome-ignore lint/correctness/useExhaustiveDependencies: range text recomputed on selection/sheet changes; the sheet's merge config is read but stable per sheet
    const rangeText = useMemo(() => {
        const lastSelection = context.selections?.at(-1);
        if (!(lastSelection && lastSelection.row_focus != null && lastSelection.column_focus != null)) return '';
        const rf = lastSelection.row_focus;
        const cf = lastSelection.column_focus;
        const merge = getSheetConfig(context)?.merge;
        if (merge != null && `${rf}_${cf}` in merge) {
            return getRangetxt(context, context.currentSheetId, {
                column: [cf, cf],
                row: [rf, rf],
            });
        }

        const rawRangeTxt = getRangetxt(context, context.currentSheetId, lastSelection);
        // "A1:BB100" becomes "A. 1: BB. 100", which a screen reader reads better.
        return rawRangeTxt.replace(/([A-Z]+)(\d+)/g, '$1. $2');
    }, [context.currentSheetId, context.selections]);

    const cellValue = () => {
        const selection = context.selections?.at(-1);
        const sheetIndex = getSheetIndex(context, context.currentSheetId);
        if (!selection || sheetIndex == null) return '';
        const cell = context.sheets[sheetIndex].data?.[selection.row_focus ?? 0]?.[selection.column_focus ?? 0];
        return cellDisplay(cell) ?? '';
    };

    const computedCellValue = cellValue();

    // One overlay region per frozen pane. The passive visuals render into every region, and each region's clip shows its
    // portion. A stateful singleton renders into the one region that holds its anchor cell.
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
            className="sheet-overlay"
            ref={containerRef}
            tabIndex={-1}
            // Radix closes an open menu on the pointerdown, before the mousedown of the cells or a header reads this.
            onPointerDownCapture={() => {
                refs.globalCache.pressClosedMenu = pressClosesMenu();
            }}
            style={{
                width: context.tableContentSize[0],
                height: context.tableContentSize[1],
            }}
        >
            <div className="sheet-col-header-wrap">
                <div
                    className="sheet-left-top"
                    onClick={onLeftTopClick}
                    tabIndex={0}
                    style={{
                        width: context.rowHeaderWidth - 1.5,
                        height: context.columnHeaderHeight - 1.5,
                    }}
                />
                <ColumnHeader />
            </div>
            <div className="sheet-row-body">
                <RowHeader />
                <div
                    ref={refs.cellArea}
                    className="sheet-cell-area"
                    onMouseDown={cellAreaMouseDown}
                    onDoubleClick={cellAreaDoubleClick}
                    onContextMenu={cellAreaContextMenu}
                    onScroll={onCellAreaScroll}
                    {...cellAreaLongPress.bind(null)}
                    // A hovered glyph also stands the drag handles' cursors down (index.css).
                    data-glyph-hover={context.cellGlyphHover}
                    style={{
                        width: context.cellmainWidth,
                        height: context.cellmainHeight,
                        cursor: context.cellSelectExtending
                            ? 'crosshair'
                            : context.filterButtonHover != null ||
                                (isAllowEdit(context) &&
                                    (context.cellGlyphHover === 'dropdown' || context.cellGlyphHover === 'checkbox'))
                              ? 'pointer'
                              : 'default',
                    }}
                >
                    <div className="sheet-cell-overlay-layer">
                        {/* Before the passive regions, so it paints under the selection tints. */}
                        <OverlayRegion {...dvRegion}>
                            <DropdownList />
                        </OverlayRegion>
                        {regions.map(({ pane, ...rect }) => (
                            <OverlayRegion key={pane} {...rect}>
                                <OverlayVisuals containerRef={containerRef} />
                                {pane === 'main' && <FloatingObjects />}
                            </OverlayRegion>
                        ))}
                        <OverlayRegion {...editorRegion}>
                            <InputBox />
                        </OverlayRegion>
                        {/* A popup pins with its anchor's pane but never clips, since it overflows the pane. */}
                        <OverlayRegion
                            left={0}
                            top={0}
                            width={0}
                            height={0}
                            clip={false}
                            fixedLeft={dvRegion.fixedLeft}
                            fixedTop={dvRegion.fixedTop}
                        >
                            <ValidationHintCard />
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
                                className="sheet-change-size-line"
                                hidden={
                                    !context.colsResizing &&
                                    !context.rowsResizing &&
                                    !context.colsFreezeDragging &&
                                    !context.rowsFreezeDragging
                                }
                            />
                            <div
                                className="sheet-freeze-drag-line"
                                hidden={!context.colsFreezeDragging && !context.rowsFreezeDragging}
                            />
                        </OverlayRegion>
                    </div>
                    {cellMenuAnchor}
                    <div className="sheet-cell-flow">
                        <div className="sheet-cell-flow-clip">
                            <div className="sheet-cell-flow-col">
                                <div
                                    className="sheet-cell-table"
                                    style={{
                                        height: context.rh_height,
                                        width: context.ch_width,
                                    }}
                                />
                                {/* No eigen-paper-chrome: this control sits on the light-pinned paper, where
                                    dark-themed controls would be illegible. */}
                                <div
                                    id="sheet-bottom-controll-row"
                                    className="sheet-bottom-controll-row flex items-center gap-2"
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
                                        Add
                                    </Button>
                                    <Input
                                        ref={bottomAddRowInputRef}
                                        type="text"
                                        className="h-8 w-16"
                                        placeholder={context.addDefaultRows.toString()}
                                    />
                                    <span className="text-sm text-muted-foreground">(more rows at bottom)</span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="ml-2"
                                        onClick={() => {
                                            if (refs.cellArea.current) refs.cellArea.current.scrollTop = 0;
                                        }}
                                    >
                                        Back to the top
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div id="sr-selection" className="sr-only" role="alert">
                {!rangeText.includes('NaN')
                    ? `${rangeText} ${computedCellValue}`
                    : 'A1. To release the sheet focus lock and let keys reach the rest of the app, use Shift, Control, F.'}
            </div>
            <div id="sr-sheetFocus" className="sr-only" role="alert">
                {context.sheetFocused
                    ? `${lastRangeText} ${lastCellValue ? `${lastCellValue}.` : ''} Sheet focus lock enabled.`
                    : 'Sheet focus lock disabled.'}
            </div>
        </main>
    );
};
