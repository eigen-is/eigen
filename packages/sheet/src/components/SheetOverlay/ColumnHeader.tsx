import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import {
    autoFitColumnWidth,
    colLocation,
    colLocationByIndex,
    computeColumnHeaderRegions,
    type Freezen,
    fixPositionOnFrozenCells,
    getFlowdata,
    getSheetIndex,
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
    // Long-press opens the column menu on touch, mirroring the cell area — headers otherwise
    // have no menu entry where the browser never synthesises a contextmenu. bind carries no item.
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
    const allowEditRef = useRef<boolean>(true);
    const sheetIndex = getSheetIndex(context, context.currentSheetId);
    const sheet = sheetIndex == null ? null : context.sheets[sheetIndex];
    const freezeHandleLeft = useMemo(() => {
        if (
            sheet?.frozen?.type === 'column' ||
            sheet?.frozen?.type === 'rangeColumn' ||
            sheet?.frozen?.type === 'rangeBoth' ||
            sheet?.frozen?.type === 'both'
        ) {
            return (
                colLocationByIndex(sheet?.frozen?.range?.column_focus || 0, context.visibledatacolumn)[1] -
                2 +
                context.scrollLeft
            );
        }
        return context.scrollLeft;
    }, [context.visibledatacolumn, sheet?.frozen, context.scrollLeft]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: globalCache.scrollLeft is the live scroll value read fresh off a stable ref, never a React dependency
    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            if (context.colsResizing) {
                return;
            }
            const mouseX = e.pageX - containerRef.current!.getBoundingClientRect().left - window.scrollX;
            const _x = mouseX + refs.globalCache.scrollLeft;
            const freeze = refs.globalCache.freezen?.[context.currentSheetId];
            const { x } = fixPositionOnFrozenCells(freeze, _x, 0, mouseX, 0);
            const col_location = colLocation(x, context.visibledatacolumn);
            const [col_pre, col, col_index] = col_location;
            if (col_index !== hoverLocation.col_index) {
                setHoverLocation({ col_pre, col, col_index });
            }
            const flowdata = getFlowdata(context);
            if (flowdata != null)
                allowEditRef.current =
                    isAllowEdit(context) &&
                    isAllowEdit(context, [
                        {
                            row: [0, flowdata.length - 1],
                            column: col_location,
                        },
                    ]);
        },
        [context, hoverLocation.col_index, refs.globalCache.freezen],
    );

    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleColumnHeaderMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    containerRef.current!,
                    refs.cellInput.current!,
                    refs.fxInput.current!,
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
                handleColSizeHandleMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    containerRef.current!,
                    refs.workbookContainer.current!,
                    refs.cellArea.current!,
                );
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.globalCache, refs.workbookContainer, setContext],
    );

    const onColSizeHandleDoubleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            if (!refs.canvas.current) return;
            setContext((draftCtx) => {
                autoFitColumnWidth(draftCtx, hoverLocation.col_index, refs.canvas.current!);
            });
            e.stopPropagation();
        },
        [hoverLocation.col_index, refs.canvas, setContext],
    );

    const onColFreezeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleColFreezeHandleMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    containerRef.current!,
                    refs.workbookContainer.current!,
                    refs.cellArea.current!,
                );
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.globalCache, refs.workbookContainer, setContext],
    );

    useEffect(() => {
        const s = context.selections;
        if (s == null) return;

        let columnTitleMap = {};
        for (let i = 0; i < s.length; i += 1) {
            const c1 = s[i].column[0];
            const c2 = s[i].column[1];
            columnTitleMap = selectTitlesMap(columnTitleMap, c1, c2);
        }
        const columnTitleRange = selectTitlesRange(columnTitleMap);
        const selects: { col: number; col_pre: number; c1: number; c2: number }[] = [];
        for (let j = 0; j < columnTitleRange.length; j += 1) {
            const c1 = columnTitleRange[j][0];
            const c2 = columnTitleRange[j][columnTitleRange[j].length - 1];
            const col = colLocationByIndex(c2, context.visibledatacolumn)[1];
            const col_pre = colLocationByIndex(c1, context.visibledatacolumn)[0];
            if (typeof col === 'number' && typeof col_pre === 'number') {
                selects.push({ col, col_pre, c1, c2 });
            }
        }
        setSelectedLocation(selects);
    }, [context.selections, context.visibledatacolumn]);

    // The header is no longer its own scroll surface; it tracks the single
    // scroll offset on the bus by translating its content. notifyScrollListeners
    // runs synchronously, so this stays in lockstep with the canvas labels for
    // both user and programmatic scroll. Applied once on mount for the initial offset.
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

    // The header shares the body-overlay region model one axis at a time
    // (RENDERING.md § Scrolling): a pinned frozen band + a bus-translated main
    // band whose clip cuts the highlights at the freeze boundary, replacing the
    // recipe-time fix*StyleOverflowInFreeze clamps (stale during pure scroll).
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
            {/* Selected highlights are passive: render into every region in pure
                content coordinates; each region's clip shows exactly its portion. */}
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
            {/* Hover highlight + resize handle are singletons in the single
                region containing the hovered column. */}
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
                        {allowEditRef.current && (
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
            {/* The freeze drag handle keeps its viewport-pinning +scroll pattern
                on the live translate (imperatively repositioned during freeze
                drags in live content coordinates), unclipped like the body's
                pane-spanning drag lines. */}
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
