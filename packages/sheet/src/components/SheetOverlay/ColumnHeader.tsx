// The column header strip above the grid: the column letters, the hovered and selected columns, the
// resize handle (a drag resizes, a double click fits the width) and the freeze handle. Its mouse
// handlers hand the press to the state layer, such as handleColumnHeaderMouseDown, and a right click
// or long press opens the column menu. RowHeader is its twin on the other axis.

import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import type { Freezen } from '../../state';
import {
    autoFitColumnWidth,
    colLocation,
    colLocationByIndex,
    computeColumnHeaderRegions,
    fixPositionOnFrozenCells,
    getFlowdata,
    getFrozenHandleLeft,
    handleColFreezeHandleMouseDown,
    handleColSizeHandleMouseDown,
    handleColumnHeaderMouseDown,
    isAllowEdit,
    overlayRegionForCell,
    selectTitlesMap,
    selectTitlesRange,
} from '../../state';
import { useSheetContextMenu } from '../ContextMenu/useSheetContextMenu';
import { OverlayRegion } from './OverlayRegion';

export const ColumnHeader: React.FC = () => {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { onContextMenu, openAtPoint, anchor: columnMenuAnchor } = useSheetContextMenu('column');
    // A long press opens the column menu on touch, as it does on the cell area. A touch browser sends no contextmenu,
    // so without it a header has no menu there.
    const longPress = useLongPress<null>((_item, x, y) => openAtPoint(x, y));
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const colChangeSizeRef = useRef<HTMLDivElement>(null);
    const [hoverLocation, setHoverLocation] = useState({
        col: -1,
        col_pre: -1,
        col_index: -1,
    });
    const [selectedLocation, setSelectedLocation] = useState<
        { col: number; col_pre: number; c1: number; c2: number }[]
    >([]);
    const freezeHandleLeft = getFrozenHandleLeft(context);
    // The hovered column shows its menu arrow only when the sheet lets you edit all of it. It is read as the header
    // renders, so a protection change shows while the same column stays hovered.
    const hoverEditable = useMemo(() => {
        const flowdata = getFlowdata(context);
        if (flowdata == null || hoverLocation.col_index < 0) return true;
        const column: [number, number] = [hoverLocation.col_index, hoverLocation.col_index];
        return isAllowEdit(context) && isAllowEdit(context, [{ row: [0, flowdata.length - 1], column }]);
    }, [context, hoverLocation.col_index]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: globalCache.scrollLeft is the live scroll value read fresh off a stable ref, never a React dependency
    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            if (context.colsResizing) {
                return;
            }
            const container = containerRef.current;
            if (!container) return;
            const mouseX = e.pageX - container.getBoundingClientRect().left - window.scrollX;
            const scrolledX = mouseX + refs.globalCache.scrollLeft;
            const freeze = refs.globalCache.freezen?.[context.currentSheetId];
            const { x } = fixPositionOnFrozenCells(freeze, scrolledX, 0, mouseX, 0);
            const [col_pre, col, col_index] = colLocation(x, context.visibledatacolumn);
            if (col_index === hoverLocation.col_index) return;
            setHoverLocation({ col_pre, col, col_index });
        },
        [context, hoverLocation.col_index, refs.globalCache.freezen],
    );

    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                const container = containerRef.current;
                const cellInput = refs.cellInput.current;
                if (!container || !cellInput) return;
                handleColumnHeaderMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    container,
                    cellInput,
                    refs.fxInput.current,
                );
            });
        },
        [refs.globalCache, refs.cellInput, refs.fxInput, setContext],
    );

    const onMouseLeave = useCallback(() => {
        if (context.colsResizing) {
            return;
        }
        setHoverLocation({ col: -1, col_pre: -1, col_index: -1 });
    }, [context.colsResizing]);

    const onColSizeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                const container = containerRef.current;
                const workbookContainer = refs.workbookContainer.current;
                const cellArea = refs.cellArea.current;
                if (!container || !workbookContainer || !cellArea) return;
                handleColSizeHandleMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    container,
                    workbookContainer,
                    cellArea,
                );
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.globalCache, refs.workbookContainer, setContext],
    );

    const onColSizeHandleDoubleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const canvas = refs.canvas.current;
            if (!canvas) return;
            setContext((draftCtx) => {
                autoFitColumnWidth(draftCtx, hoverLocation.col_index, canvas);
            });
            e.stopPropagation();
        },
        [hoverLocation.col_index, refs.canvas, setContext],
    );

    const onColFreezeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                const container = containerRef.current;
                const workbookContainer = refs.workbookContainer.current;
                const cellArea = refs.cellArea.current;
                if (!container || !workbookContainer || !cellArea) return;
                handleColFreezeHandleMouseDown(draftCtx, nativeEvent, container, workbookContainer, cellArea);
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.workbookContainer, setContext],
    );

    useEffect(() => {
        if (context.selections == null) return;

        let columnTitleMap: Record<number, number> = {};
        for (const selection of context.selections) {
            columnTitleMap = selectTitlesMap(columnTitleMap, selection.column[0], selection.column[1]);
        }
        const selects: { col: number; col_pre: number; c1: number; c2: number }[] = [];
        for (const columns of selectTitlesRange(columnTitleMap)) {
            const c1 = columns[0];
            const c2 = columns[columns.length - 1];
            const col = colLocationByIndex(c2, context.visibledatacolumn)[1];
            const col_pre = colLocationByIndex(c1, context.visibledatacolumn)[0];
            if (typeof col === 'number' && typeof col_pre === 'number') {
                selects.push({ col, col_pre, c1, c2 });
            }
        }
        setSelectedLocation(selects);
    }, [context.selections, context.visibledatacolumn]);

    // The header follows the one scroll offset on the bus by translating its content. notifyScrollListeners runs
    // synchronously, so the header moves in step with the canvas labels, and the first call sets the offset on mount.
    useEffect(() => {
        const applyOffset = () => {
            if (contentRef.current) {
                contentRef.current.style.transform = `translateX(${-refs.globalCache.scrollLeft}px)`;
            }
        };
        applyOffset();
        refs.globalCache.scrollListeners.add(applyOffset);
        return () => {
            refs.globalCache.scrollListeners.delete(applyOffset);
        };
    }, [refs.globalCache]);

    // The header splits into the body's panes on its own axis: a frozen band that stays put and a main band that
    // scrolls. Each band's clip cuts the highlights at the freeze boundary.
    const headerHeight = context.columnHeaderHeight - 1.5;
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const colFreeze: Freezen | undefined = freeze?.vertical ? { vertical: freeze.vertical } : undefined;
    const regions = computeColumnHeaderRegions(colFreeze, context.cellmainWidth, headerHeight);
    const hoverRegion = overlayRegionForCell(regions, colFreeze, 0, hoverLocation.col_index);

    return (
        <div
            ref={containerRef}
            className="sheet-col-header"
            style={{
                height: headerHeight,
            }}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseLeave={onMouseLeave}
            onContextMenu={onContextMenu}
            {...longPress.bind(null)}
        >
            {/* Each region draws every selected highlight in content coordinates. Its clip shows only its own part. */}
            {regions.map(({ pane, ...rect }) => (
                <OverlayRegion key={pane} {...rect}>
                    {selectedLocation.map(({ col, col_pre, c1, c2 }) => (
                        <div
                            className="sheet-col-header-selected"
                            key={`${c1}-${c2}`}
                            style={{
                                left: col_pre,
                                width: col - col_pre - 1,
                                height: headerHeight,
                                display: 'block',
                            }}
                        />
                    ))}
                </OverlayRegion>
            ))}
            {/* The hover highlight and the resize handle exist once, in the region that holds the hovered column. */}
            <OverlayRegion {...hoverRegion}>
                <div
                    className="sheet-cols-change-size"
                    ref={colChangeSizeRef}
                    id="sheet-cols-change-size"
                    onMouseDown={onColSizeHandleMouseDown}
                    onDoubleClick={onColSizeHandleDoubleClick}
                    style={{
                        left: hoverLocation.col - 5,
                        height: headerHeight,
                        opacity: context.colsResizing ? 1 : 0,
                    }}
                />
                {!context.colsResizing && hoverLocation.col_index >= 0 ? (
                    <div
                        className="sheet-col-header-hover"
                        style={{
                            left: hoverLocation.col_pre,
                            width: hoverLocation.col - hoverLocation.col_pre - 1,
                            height: headerHeight,
                            display: 'block',
                        }}
                    >
                        {hoverEditable && (
                            <span
                                className="header-arrow"
                                role="button"
                                aria-label="Column options"
                                tabIndex={0}
                                onClick={onContextMenu}
                                onKeyDown={(e) => {
                                    if (e.key !== 'Enter' && e.key !== ' ') return;
                                    e.preventDefault();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    openAtPoint(rect.left, rect.bottom);
                                }}
                            >
                                <ChevronDown
                                    width={12}
                                    height={12}
                                    className="text-muted-foreground"
                                    aria-hidden="true"
                                />
                            </span>
                        )}
                    </div>
                ) : null}
            </OverlayRegion>
            {/* The freeze handle's position adds the scroll offset, so it stays put in the viewport while the content
                scrolls. It sits outside the panes, so no clip cuts it, as none cuts the body's drag lines. A freeze
                drag moves it directly. */}
            <div ref={contentRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <div
                    className="sheet-cols-freeze-handle"
                    onMouseDown={onColFreezeHandleMouseDown}
                    style={{
                        left: freezeHandleLeft || 0,
                    }}
                />
            </div>
            {columnMenuAnchor}
        </div>
    );
};
