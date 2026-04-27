import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import type React from 'react';
import type { CSSProperties } from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { debounce } from 'es-toolkit/compat';
import { type SetContextOptions, WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import { useDialog } from '../../hooks/useDialog';
import {
    api,
    type Context,
    createDropCellRange,
    fixColumnStyleOverflowInFreeze,
    fixRowStyleOverflowInFreeze,
    type GlobalCache,
    getCellHyperlink,
    getCellRowColumn,
    getRangetxt,
    getSheetIndex,
    handleCellAreaDoubleClick,
    handleCellAreaMouseDown,
    handleContextMenu,
    handleOverlayMouseMove,
    handleOverlayMouseUp,
    handleOverlayTouchEnd,
    handleOverlayTouchMove,
    handleOverlayTouchStart,
    insertRowCol,
    locale,
    onCellsMoveStart,
    selectAll,
    showLinkCard,
} from '../../state';
import { DropDownList } from '../DataVerification/DropdownList';
import { FilterOptions } from '../FilterOption';
import { ImgBoxs } from '../ImgBoxs';
import { LinkEditCard } from '../LinkEditCard';
import { SearchReplace } from '../SearchReplace';
import { ColumnHeader } from './ColumnHeader';
import { InputBox } from './InputBox';
import { RowHeader } from './RowHeader';
import { ScrollBar } from './ScrollBar';

export const SheetOverlay: React.FC = () => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const { info, rightclick } = locale(context);
    const { showDialog } = useDialog();
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
                    handleCellAreaMouseDown(
                        draftCtx,
                        refs.globalCache,
                        nativeEvent,
                        refs.cellInput.current!,
                        refs.cellArea.current!,
                        refs.fxInput.current!,
                        refs.canvas.current!.getContext('2d')!,
                    );

                    if (
                        draftCtx.luckysheet_select_save?.[0] != null &&
                        Object.keys(draftCtx.luckysheet_select_save[0]).length > 0 &&
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

    const cellAreaContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleContextMenu(
                    draftCtx,
                    settings,
                    nativeEvent,
                    refs.workbookContainer.current!,
                    refs.cellArea.current!,
                    'cell',
                );
            });
        },
        [refs.workbookContainer, setContext, settings, refs.cellArea],
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
            scrollX: HTMLDivElement,
            scrollY: HTMLDivElement,
        ) => {
            const rc = getCellRowColumn(ctx, e, container, scrollX, scrollY);
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
                        if (!draftCtx.luckysheet_select_status && !draftCtx.luckysheet_scroll_status) {
                            overShowLinkCard(
                                draftCtx,
                                refs.globalCache,
                                ev,
                                containerRef.current!,
                                refs.scrollbarX.current!,
                                refs.scrollbarY.current!,
                            );
                        }
                        handleOverlayMouseMove(
                            draftCtx,
                            refs.globalCache,
                            ev,
                            refs.cellInput.current!,
                            refs.scrollbarX.current!,
                            refs.scrollbarY.current!,
                            containerRef.current!,
                            refs.fxInput.current,
                        );
                    },
                    { noHistory: true },
                );
            });
        },
        [
            overShowLinkCard,
            refs.cellInput,
            refs.fxInput,
            refs.globalCache,
            refs.scrollbarX,
            refs.scrollbarY,
            setContext,
        ],
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
                        refs.scrollbarX.current!,
                        refs.scrollbarY.current!,
                        containerRef.current!,
                        refs.cellInput.current,
                        refs.fxInput.current,
                    );
                } catch (e) {
                    if (e instanceof Error) showAlert(e.message);
                }
            });
        },
        [
            refs.cellInput,
            refs.fxInput,
            refs.globalCache,
            refs.scrollbarX,
            refs.scrollbarY,
            setContext,
            settings,
            showAlert,
        ],
    );

    const onTouchStart = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            handleOverlayTouchStart(e.nativeEvent, refs.globalCache);
            e.stopPropagation();
        },
        [refs.globalCache],
    );

    const onTouchMove = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            handleOverlayTouchMove(e.nativeEvent, refs.globalCache, refs.scrollbarX.current!, refs.scrollbarY.current!);
        },
        [refs.globalCache, refs.scrollbarX, refs.scrollbarY],
    );

    const onTouchEnd = useCallback(() => {
        handleOverlayTouchEnd(refs.globalCache);
    }, [refs.globalCache]);

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
                context.luckysheetfile[getSheetIndex(context, context!.currentSheetId! as string) as number].data!
                    .length - 1,
            count: value,
            direction: 'rightbottom',
            id: context.currentSheetId,
        };
        setContext(
            (draftCtx) => {
                try {
                    insertRowCol(draftCtx, insertRowColOp, false);
                } catch (err) {
                    if (err instanceof Error && err.message === 'maxExceeded') showAlert(rightclick.rowOverLimit);
                }
            },
            { insertRowColOp },
        );
    }, [context, rightclick.rowOverLimit, setContext, showAlert]);

    useEffect(() => {
        setContext((draftCtx) => {
            const sheetIndex = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIndex == null) return;

            const currentSheet = draftCtx.luckysheetfile[sheetIndex];

            // Only reset selection if there's no existing selection
            if (!currentSheet.luckysheet_select_save?.length) {
                api.setSelection(draftCtx, [{ row: [0], column: [0] }], {});
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

    useEffect(() => {
        refs.cellArea.current!.scrollLeft = context.scrollLeft;
        refs.cellArea.current!.scrollTop = context.scrollTop;
    }, [context.scrollLeft, context.scrollTop, refs.cellArea]);

    // Sync cellArea scroll position imperatively from globalCache,
    // bypassing React state to avoid re-rendering 20+ context consumers.
    useEffect(() => {
        const syncScroll = () => {
            const { globalCache } = refs;
            if (refs.cellArea.current) {
                refs.cellArea.current.scrollLeft = globalCache.scrollLeft;
                refs.cellArea.current.scrollTop = globalCache.scrollTop;
            }
        };
        refs.globalCache.scrollListeners.add(syncScroll);
        return () => {
            refs.globalCache.scrollListeners.delete(syncScroll);
        };
    }, [refs]);

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
        const lastSelection = context.luckysheet_select_save?.at(-1);
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
    }, [context.currentSheetId, context.luckysheet_select_save]);

    const cellValue = () => {
        if ((context.luckysheet_select_save?.length ?? 0) > 0) {
            const selection = context.luckysheet_select_save?.[context.luckysheet_select_save.length - 1];
            if (!selection) return '';
            const sheetIndex = getSheetIndex(context, context.currentSheetId);
            if (sheetIndex === undefined || sheetIndex === null) return '';
            const rowFocus = selection.row_focus ?? 0;
            const columnFocus = selection.column_focus ?? 0;
            const cellVal = context.luckysheetfile[sheetIndex]?.data?.[rowFocus]?.[columnFocus]?.m || '';
            return cellVal;
        }
        return '';
    };

    const computedCellValue = cellValue();

    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot snapshot on focus toggle — adding rangeText/cellValue as deps would re-snapshot on every selection change and overwrite the cached "last" values
    useEffect(() => {
        if (context.sheetFocused) {
            setLastRangeText(String(rangeText));
            setLastCellValue(String(cellValue()));
        }
    }, [context.sheetFocused]);

    useEffect(() => {
        if (context.showSearch || context.showReplace) {
            showDialog(<SearchReplace />);
        }
    }, [context.showSearch, context.showReplace, showDialog]);

    return (
        <main
            className="fortune-sheet-overlay"
            ref={containerRef}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            tabIndex={-1}
            style={{
                width: context.luckysheetTableContentHW[0],
                height: context.luckysheetTableContentHW[1],
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
                <ScrollBar axis="x" />
                <ScrollBar axis="y" />
                <div
                    ref={refs.cellArea}
                    className="fortune-cell-area"
                    onMouseDown={cellAreaMouseDown}
                    onDoubleClick={cellAreaDoubleClick}
                    onContextMenu={cellAreaContextMenu}
                    style={{
                        width: context.cellmainWidth,
                        height: context.cellmainHeight,
                        cursor: context.luckysheet_cell_selected_extend ? 'crosshair' : 'default',
                    }}
                >
                    <div id="fortune-formula-functionrange" />
                    {context.formulaRangeSelect && (
                        <div
                            className="fortune-selection-copy fortune-formula-functionrange-select"
                            style={context.formulaRangeSelect}
                        >
                            <div className="fortune-selection-copy-top fortune-copy" />
                            <div className="fortune-selection-copy-right fortune-copy" />
                            <div className="fortune-selection-copy-bottom fortune-copy" />
                            <div className="fortune-selection-copy-left fortune-copy" />
                            <div className="fortune-selection-copy-hc" />
                        </div>
                    )}
                    {context.formulaRangeHighlight.map((v) => {
                        const { rangeIndex, backgroundColor } = v;
                        return (
                            <div
                                key={rangeIndex}
                                id="fortune-formula-functionrange-highlight"
                                className="fortune-selection-highlight fortune-formula-functionrange-highlight"
                                style={(() => {
                                    const { backgroundColor: _, ...rest } = v;
                                    return rest;
                                })()}
                            >
                                {['top', 'right', 'bottom', 'left'].map((d) => (
                                    <div
                                        key={d}
                                        data-type={d}
                                        className={`fortune-selection-copy-${d} fortune-copy`}
                                        style={{ backgroundColor }}
                                    />
                                ))}
                                <div className="fortune-selection-copy-hc" style={{ backgroundColor }} />
                                {['lt', 'rt', 'lb', 'rb'].map((d) => (
                                    <div
                                        key={d}
                                        data-type={d}
                                        className={`fortune-selection-highlight-${d} luckysheet-highlight`}
                                        style={{ backgroundColor }}
                                    />
                                ))}
                            </div>
                        );
                    })}
                    <div className="luckysheet-row-count-show luckysheet-count-show" id="luckysheet-row-count-show" />
                    <div
                        className="luckysheet-column-count-show luckysheet-count-show"
                        id="luckysheet-column-count-show"
                    />
                    <div
                        className="fortune-change-size-line"
                        hidden={
                            !context.luckysheet_cols_change_size &&
                            !context.luckysheet_rows_change_size &&
                            !context.luckysheet_cols_freeze_drag &&
                            !context.luckysheet_rows_freeze_drag
                        }
                    />
                    <div
                        className="fortune-freeze-drag-line"
                        hidden={!context.luckysheet_cols_freeze_drag && !context.luckysheet_rows_freeze_drag}
                    />
                    <div
                        className="luckysheet-cell-selected-focus"
                        style={
                            (context.luckysheet_select_save?.length ?? 0) > 0
                                ? (() => {
                                      const selection = context.luckysheet_select_save!.at(-1)!;
                                      return Object.assign(
                                          {
                                              left: selection.left,
                                              top: selection.top,
                                              width: selection?.width || 0,
                                              height: selection?.height || 0,
                                              display: 'block',
                                          },
                                          fixRowStyleOverflowInFreeze(
                                              context,
                                              selection.row_focus || 0,
                                              selection.row_focus || 0,
                                              refs.globalCache.freezen?.[context.currentSheetId],
                                          ),
                                          fixColumnStyleOverflowInFreeze(
                                              context,
                                              selection.column_focus || 0,
                                              selection.column_focus || 0,
                                              refs.globalCache.freezen?.[context.currentSheetId],
                                          ),
                                      );
                                  })()
                                : {}
                        }
                        onMouseDown={(e) => e.preventDefault()}
                    />
                    {(context.luckysheet_selection_range?.length ?? 0) > 0 && (
                        <div id="fortune-selection-copy">
                            {context.luckysheet_selection_range!.map((range) => {
                                const r1 = range.row[0];
                                const r2 = range.row[1];
                                const c1 = range.column[0];
                                const c2 = range.column[1];

                                const row = context.visibledatarow[r2];
                                const row_pre = r1 - 1 === -1 ? 0 : context.visibledatarow[r1 - 1];
                                const col = context.visibledatacolumn[c2];
                                const col_pre = c1 - 1 === -1 ? 0 : context.visibledatacolumn[c1 - 1];

                                return (
                                    <div
                                        className="fortune-selection-copy"
                                        key={`${r1}-${r2}-${c1}-${c2}`}
                                        style={{
                                            left: col_pre,
                                            width: col - col_pre - 1,
                                            top: row_pre,
                                            height: row - row_pre - 1,
                                        }}
                                    >
                                        <div className="fortune-selection-copy-top fortune-copy" />
                                        <div className="fortune-selection-copy-right fortune-copy" />
                                        <div className="fortune-selection-copy-bottom fortune-copy" />
                                        <div className="fortune-selection-copy-left fortune-copy" />
                                        <div className="fortune-selection-copy-hc" />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <div id="luckysheet-chart-rangeShow" />
                    <div className="fortune-cell-selected-extend" />
                    <div
                        className="fortune-cell-selected-move"
                        id="fortune-cell-selected-move"
                        onMouseDown={(e) => e.preventDefault()}
                    />
                    {(context.luckysheet_select_save?.length ?? 0) > 0 && (
                        <div id="luckysheet-cell-selected-boxs">
                            {context.luckysheet_select_save!.map((selection) => (
                                <div
                                    key={`${selection.row[0]}-${selection.row[1]}-${selection.column[0]}-${selection.column[1]}`}
                                    id="luckysheet-cell-selected"
                                    className="luckysheet-cell-selected"
                                    style={Object.assign(
                                        {
                                            left: selection.left_move,
                                            top: selection.top_move,
                                            width: selection?.width_move || 0,
                                            height: selection?.height_move || 0,
                                            display: 'block',
                                        },
                                        fixRowStyleOverflowInFreeze(
                                            context,
                                            selection.row[0],
                                            selection.row[1],
                                            refs.globalCache.freezen?.[context.currentSheetId],
                                        ),
                                        fixColumnStyleOverflowInFreeze(
                                            context,
                                            selection.column[0],
                                            selection.column[1],
                                            refs.globalCache.freezen?.[context.currentSheetId],
                                        ),
                                    )}
                                    onMouseDown={(e) => {
                                        e.stopPropagation();
                                        const { nativeEvent } = e;
                                        setContext((draftCtx) => {
                                            onCellsMoveStart(
                                                draftCtx,
                                                refs.globalCache,
                                                nativeEvent,
                                                refs.scrollbarX.current!,
                                                refs.scrollbarY.current!,
                                                containerRef.current!,
                                            );
                                        });
                                    }}
                                >
                                    <div className="luckysheet-cs-inner-border" />
                                    <div
                                        className="luckysheet-cs-fillhandle"
                                        onMouseDown={(e) => {
                                            const { nativeEvent } = e;
                                            setContext((draftContext) => {
                                                createDropCellRange(draftContext, nativeEvent, containerRef.current!);
                                            });
                                            e.stopPropagation();
                                        }}
                                    />
                                    <div className="luckysheet-cs-inner-border" />
                                    <div
                                        className="luckysheet-cs-draghandle-top luckysheet-cs-draghandle"
                                        onMouseDown={(e) => e.preventDefault()}
                                    />
                                    <div
                                        className="luckysheet-cs-draghandle-bottom luckysheet-cs-draghandle"
                                        onMouseDown={(e) => e.preventDefault()}
                                    />
                                    <div
                                        className="luckysheet-cs-draghandle-left luckysheet-cs-draghandle"
                                        onMouseDown={(e) => e.preventDefault()}
                                    />
                                    <div
                                        className="luckysheet-cs-draghandle-right luckysheet-cs-draghandle"
                                        onMouseDown={(e) => e.preventDefault()}
                                    />
                                    <div className="luckysheet-cs-touchhandle luckysheet-cs-touchhandle-lt">
                                        <div className="luckysheet-cs-touchhandle-btn" />
                                    </div>
                                    <div className="luckysheet-cs-touchhandle luckysheet-cs-touchhandle-rb">
                                        <div className="luckysheet-cs-touchhandle-btn" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {(context.presences?.length ?? 0) > 0 &&
                        context.presences!.map((presence, index) => {
                            if (presence.sheetId !== context.currentSheetId) {
                                return null;
                            }
                            const {
                                selection: { r, c },
                                color,
                            } = presence;
                            const row_pre = r - 1 === -1 ? 0 : context.visibledatarow[r - 1];
                            const col_pre = c - 1 === -1 ? 0 : context.visibledatacolumn[c - 1];
                            const row = context.visibledatarow[r];
                            const col = context.visibledatacolumn[c];
                            const width = col - col_pre - 1;
                            const height = row - row_pre - 1;
                            const usernameStyle: CSSProperties = {
                                maxWidth: width + 1,
                                backgroundColor: color,
                            };
                            usernameStyle[r === 0 ? 'top' : 'bottom'] = height;

                            return (
                                <div
                                    key={presence?.userId || index}
                                    className="fortune-presence-selection"
                                    style={{
                                        left: col_pre,
                                        top: row_pre - 2,
                                        width,
                                        height,
                                        borderColor: color,
                                        borderWidth: 1,
                                    }}
                                >
                                    <div className="fortune-presence-username" style={usernameStyle}>
                                        {presence.username}
                                    </div>
                                </div>
                            );
                        })}
                    {context.linkCard?.sheetId === context.currentSheetId && <LinkEditCard {...context.linkCard} />}
                    <FilterOptions />
                    <InputBox />
                    <div id="luckysheet-multipleRange-show" />
                    <div id="luckysheet-dynamicArray-hightShow" />
                    <ImgBoxs />
                    <DropDownList />
                    <div id="luckysheet-dataVerification-showHintBox" className="luckysheet-mousedown-cancel" />
                    <div className="luckysheet-cell-copy" />
                    <div className="luckysheet-grdblkflowpush" />
                    <div id="luckysheet-cell-flow_0" className="luckysheet-cell-flow luckysheetsheetchange">
                        <div className="luckysheet-cell-flow-clip">
                            <div className="luckysheet-grdblkpush" />
                            <div id="luckysheetcoltable_0" className="luckysheet-cell-flow-col">
                                <div
                                    id="luckysheet-sheettable_0"
                                    className="luckysheet-cell-sheettable"
                                    style={{
                                        height: context.rh_height,
                                        width: context.ch_width,
                                    }}
                                />
                                <div
                                    id="luckysheet-bottom-controll-row"
                                    className="luckysheet-bottom-controll-row"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onMouseUp={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    onKeyUp={(e) => e.stopPropagation()}
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                    style={{
                                        left: context.scrollLeft,
                                        display: context.allowEdit ? 'block' : 'none',
                                    }}
                                >
                                    <Button variant="outline" size="sm" onClick={handleBottomAddRow}>
                                        {info.add}
                                    </Button>
                                    <Input
                                        ref={bottomAddRowInputRef}
                                        type="text"
                                        className="w-12"
                                        placeholder={context.addDefaultRows.toString()}
                                    />{' '}
                                    <span className="text-sm">{info.row}</span>{' '}
                                    <span className="text-sm text-muted-foreground">({info.addLast})</span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            refs.globalCache.scrollTop = 0;
                                            refs.globalCache.notifyScrollListeners();
                                            setContext((ctx) => {
                                                ctx.scrollTop = 0;
                                            });
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
