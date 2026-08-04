import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import {
    computeRowHeaderRegions,
    type Freezen,
    fixPositionOnFrozenCells,
    getSheetIndex,
    handleRowFreezeHandleMouseDown,
    handleRowHeaderMouseDown,
    handleRowSizeHandleMouseDown,
    overlayRegionForCell,
    rowLocation,
    rowLocationByIndex,
    selectTitlesMap,
    selectTitlesRange,
} from '../../state';
import { useSheetContextMenu } from '../ContextMenu/useSheetContextMenu';
import { OverlayRegion } from './OverlayRegion';

export const RowHeader: React.FC = () => {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { onContextMenu, openAtPoint, anchor: rowMenuAnchor } = useSheetContextMenu('row');
    // Long-press opens the row menu on touch, mirroring the cell area — headers otherwise
    // have no menu entry where the browser never synthesises a contextmenu. bind carries no item.
    const longPress = useLongPress<null>((_item, x, y) => openAtPoint(x, y));
    const rowChangeSizeRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [hoverLocation, setHoverLocation] = useState({
        row: -1,
        row_pre: -1,
        row_index: -1,
    });
    const [selectedLocation, setSelectedLocation] = useState<
        { row: number; row_pre: number; r1: number; r2: number }[]
    >([]);
    const sheetIndex = getSheetIndex(context, context.currentSheetId);
    const sheet = sheetIndex == null ? null : context.sheets[sheetIndex];
    const freezeHandleTop = useMemo(() => {
        if (
            sheet?.frozen?.type === 'row' ||
            sheet?.frozen?.type === 'rangeRow' ||
            sheet?.frozen?.type === 'rangeBoth' ||
            sheet?.frozen?.type === 'both'
        ) {
            return (
                rowLocationByIndex(sheet?.frozen?.range?.row_focus || 0, context.visibledatarow)[1] + context.scrollTop
            );
        }
        return context.scrollTop;
    }, [context.visibledatarow, sheet?.frozen, context.scrollTop]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: globalCache.scrollTop is the live scroll value read fresh off a stable ref, never a React dependency
    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            if (context.rowsResizing) {
                return;
            }
            const mouseY = e.pageY - containerRef.current!.getBoundingClientRect().top - window.scrollY;
            const _y = mouseY + refs.globalCache.scrollTop;
            const freeze = refs.globalCache.freezen?.[context.currentSheetId];
            const { y } = fixPositionOnFrozenCells(freeze, 0, _y, 0, mouseY);
            const row_location = rowLocation(y, context.visibledatarow);
            const [row_pre, row, row_index] = row_location;
            if (row_pre !== hoverLocation.row_pre || row !== hoverLocation.row) {
                setHoverLocation({ row_pre, row, row_index });
            }
        },
        [
            context.rowsResizing,
            context.visibledatarow,
            hoverLocation.row,
            hoverLocation.row_pre,
            refs.globalCache.freezen,
            context.currentSheetId,
        ],
    );

    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleRowHeaderMouseDown(
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
        if (context.rowsResizing) {
            return;
        }
        setHoverLocation({ row: -1, row_pre: -1, row_index: -1 });
    }, [context.rowsResizing]);

    const onRowSizeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleRowSizeHandleMouseDown(
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

    const onRowFreezeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                handleRowFreezeHandleMouseDown(
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
        const s = context.selections || [];
        let rowTitleMap: Record<number, number> = {};
        for (let i = 0; i < s.length; i += 1) {
            const r1 = s[i].row[0];
            const r2 = s[i].row[1];
            rowTitleMap = selectTitlesMap(rowTitleMap, r1, r2);
        }
        const rowTitleRange = selectTitlesRange(rowTitleMap);
        const selects: { row: number; row_pre: number; r1: number; r2: number }[] = [];
        for (let i = 0; i < rowTitleRange.length; i += 1) {
            const r1 = rowTitleRange[i][0];
            const r2 = rowTitleRange[i][rowTitleRange[i].length - 1];
            const row = rowLocationByIndex(r2, context.visibledatarow)[1];
            const row_pre = rowLocationByIndex(r1, context.visibledatarow)[0];
            if (typeof row_pre === 'number' && typeof row === 'number') {
                selects.push({ row, row_pre, r1, r2 });
            }
        }
        setSelectedLocation(selects);
    }, [context.selections, context.visibledatarow]);

    // The header is no longer its own scroll surface; it tracks the single
    // scroll offset on the bus by translating its content. notifyScrollListeners
    // runs synchronously, so this stays in lockstep with the canvas labels for
    // both user and programmatic scroll. Applied once on mount for the initial offset.
    useEffect(() => {
        const applyOffset = () => {
            if (contentRef.current) {
                contentRef.current.style.transform = `translateY(${-refs.globalCache.scrollTop}px)`;
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
    const headerWidth = context.rowHeaderWidth - 1.5;
    const freeze = refs.globalCache.freezen?.[context.currentSheetId];
    const rowFreeze: Freezen | undefined = freeze?.horizontal ? { horizontal: freeze.horizontal } : undefined;
    const regions = computeRowHeaderRegions(rowFreeze, headerWidth, context.cellmainHeight);
    const hoverRegion = overlayRegionForCell(regions, rowFreeze, hoverLocation.row_index, 0);

    return (
        <div
            ref={containerRef}
            className="fortune-row-header"
            style={{
                width: headerWidth,
                height: context.cellmainHeight,
            }}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseLeave={onMouseLeave}
            onContextMenu={onContextMenu}
            {...longPress.bind(null)}
        >
            {/* Positioned 2px down so the regions inside live in grid
                coordinates — the container itself is pulled up 2px
                (margin-top -2 / padding-top 2). OverlayRegion pins its content
                frame to the containing block's origin, so the offset must sit
                on an ancestor, not on the region rects. */}
            <div style={{ position: 'absolute', top: 2, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }}>
                {/* Selected highlights are passive: render into every region in pure
                    content coordinates; each region's clip shows exactly its portion. */}
                {regions.map(({ pane, ...rect }) => (
                    <OverlayRegion key={pane} {...rect}>
                        {selectedLocation.map(({ row, row_pre, r1, r2 }) => (
                            <div
                                className="fortune-row-header-selected"
                                key={`${r1}-${r2}`}
                                style={{
                                    top: row_pre,
                                    height: row - row_pre - 1,
                                    width: headerWidth,
                                    display: 'block',
                                }}
                            />
                        ))}
                    </OverlayRegion>
                ))}
                {/* Hover highlight + resize handle are singletons in the single
                    region containing the hovered row. */}
                <OverlayRegion {...hoverRegion}>
                    <div
                        className="fortune-rows-change-size"
                        ref={rowChangeSizeRef}
                        onMouseDown={onRowSizeHandleMouseDown}
                        style={{
                            top: hoverLocation.row - 5,
                            width: headerWidth,
                            opacity: context.rowsResizing ? 1 : 0,
                        }}
                    />
                    {!context.rowsResizing && hoverLocation.row_index >= 0 ? (
                        <div
                            className="fortune-row-header-hover"
                            style={{
                                top: hoverLocation.row_pre,
                                height: hoverLocation.row - hoverLocation.row_pre - 1,
                                width: headerWidth,
                                display: 'block',
                            }}
                        />
                    ) : null}
                </OverlayRegion>
            </div>
            {/* The freeze drag handle keeps its viewport-pinning +scroll pattern
                on the live translate (imperatively repositioned during freeze
                drags in live content coordinates), unclipped like the body's
                pane-spanning drag lines. */}
            <div ref={contentRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <div
                    className="fortune-rows-freeze-handle"
                    onMouseDown={onRowFreezeHandleMouseDown}
                    style={{
                        top: freezeHandleTop || 0,
                    }}
                />
            </div>
            {rowMenuAnchor}
        </div>
    );
};
