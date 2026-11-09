// The row header strip left of the grid: the row numbers, the hovered and selected rows, the resize
// handle and the freeze handle. Its mouse handlers hand the press to the state layer, such as
// handleRowHeaderMouseDown, and a right click or long press opens the row menu. ColumnHeader is its
// twin on the other axis.

import { SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import type React from 'react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import type { Freezen } from '../../state';
import {
    computeRowHeaderRegions,
    freezeOf,
    getFrozenHandleTop,
    handleRowFreezeHandleMouseDown,
    handleRowHeaderMouseDown,
    handleRowSizeHandleMouseDown,
    overlayRegionForCell,
    rowLocation,
    rowLocationByIndex,
    selectTitlesMap,
    selectTitlesRange,
    sheetPoint,
} from '../../state';
import { useSheetContextMenu } from '../ContextMenu/useSheetContextMenu';
import { OverlayRegion } from './OverlayRegion';

export const RowHeader: React.FC = () => {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { onContextMenu, openAtPoint, anchor: rowMenuAnchor } = useSheetContextMenu('row');
    // A long press opens the row menu on touch, as it does on the cell area. A touch browser sends no contextmenu,
    // so without it a header has no menu there.
    const longPress = useLongPress<null>((_item, x, y) => openAtPoint(x, y));
    const rowChangeSizeRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [hoverLocation, setHoverLocation] = useState({
        row: -1,
        row_pre: -1,
        row_index: -1,
    });
    const [selectedLocation, setSelectedLocation] = useState<
        { row: number; row_pre: number; r1: number; r2: number }[]
    >([]);
    const freezeHandleTop = getFrozenHandleTop(context);

    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            if (context.rowsResizing) {
                return;
            }
            const cellArea = refs.cellArea.current;
            if (!cellArea) return;
            const [row_pre, row, row_index] = rowLocation(sheetPoint(context, e, cellArea).y, context.visibledatarow);
            if (row_pre !== hoverLocation.row_pre || row !== hoverLocation.row) {
                setHoverLocation({ row_pre, row, row_index });
            }
        },
        [context, hoverLocation.row, hoverLocation.row_pre, refs.cellArea],
    );

    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                const cellArea = refs.cellArea.current;
                const cellInput = refs.cellInput.current;
                if (!cellArea || !cellInput) return;
                handleRowHeaderMouseDown(
                    draftCtx,
                    refs.globalCache,
                    nativeEvent,
                    cellArea,
                    cellInput,
                    refs.fxInput.current,
                );
            });
        },
        [refs.cellArea, refs.globalCache, refs.cellInput, refs.fxInput, setContext],
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
                const workbookContainer = refs.workbookContainer.current;
                const cellArea = refs.cellArea.current;
                if (!workbookContainer || !cellArea) return;
                handleRowSizeHandleMouseDown(draftCtx, nativeEvent, workbookContainer, cellArea);
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.workbookContainer, setContext],
    );

    const onRowFreezeHandleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
            const { nativeEvent } = e;
            setContext((draftCtx) => {
                const workbookContainer = refs.workbookContainer.current;
                const cellArea = refs.cellArea.current;
                if (!workbookContainer || !cellArea) return;
                handleRowFreezeHandleMouseDown(draftCtx, nativeEvent, workbookContainer, cellArea);
            });
            e.stopPropagation();
        },
        [refs.cellArea, refs.workbookContainer, setContext],
    );

    useEffect(() => {
        let rowTitleMap: Record<number, number> = {};
        for (const selection of context.selections ?? []) {
            rowTitleMap = selectTitlesMap(rowTitleMap, selection.row[0], selection.row[1]);
        }
        const selects: { row: number; row_pre: number; r1: number; r2: number }[] = [];
        for (const rows of selectTitlesRange(rowTitleMap)) {
            const r1 = rows[0];
            const r2 = rows[rows.length - 1];
            const row = rowLocationByIndex(r2, context.visibledatarow)[1];
            const row_pre = rowLocationByIndex(r1, context.visibledatarow)[0];
            if (typeof row_pre === 'number' && typeof row === 'number') {
                selects.push({ row, row_pre, r1, r2 });
            }
        }
        setSelectedLocation(selects);
    }, [context.selections, context.visibledatarow]);

    // The header follows the one scroll offset on the bus by translating its content. The scroll handler calls it
    // synchronously, so the header moves in step with the canvas labels, and the first call sets the offset on mount.
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

    // The header splits into the body's panes on its own axis: a frozen band that stays put and a main band that
    // scrolls. Each band's clip cuts the highlights at the freeze boundary.
    const headerWidth = SHEET_ROW_HEADER_WIDTH - 1.5;
    const freeze = freezeOf(context);
    const rowFreeze: Freezen | undefined = freeze?.horizontal ? { horizontal: freeze.horizontal } : undefined;
    const regions = computeRowHeaderRegions(rowFreeze, headerWidth, context.cellmainHeight);
    const hoverRegion = overlayRegionForCell(regions, rowFreeze, hoverLocation.row_index, 0);

    return (
        <>
            <div
                className="sheet-row-header"
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
                {/* The container is pulled up 2px by its margin and padding. This wrapper moves 2px back down, so the
                    regions inside use grid coordinates. The offset must sit on an ancestor, because OverlayRegion pins
                    its content to the origin of its containing block. */}
                <div style={{ position: 'absolute', top: 2, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }}>
                    {/* Each region draws every selected highlight in content coordinates. Its clip shows only its own
                        part. */}
                    {regions.map(({ pane, ...rect }) => (
                        <OverlayRegion key={pane} {...rect}>
                            {selectedLocation.map(({ row, row_pre, r1, r2 }) => (
                                <div
                                    className="sheet-row-header-selected"
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
                    {/* The hover highlight and the resize handle exist once, in the region that holds the hovered row. */}
                    <OverlayRegion {...hoverRegion}>
                        <div
                            className="sheet-rows-change-size"
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
                                className="sheet-row-header-hover"
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
                {/* The freeze handle's position adds the scroll offset, so it stays put in the viewport while the content
                    scrolls. It sits outside the panes, so no clip cuts it, as none cuts the body's drag lines. A freeze
                    drag moves it directly. */}
                <div ref={contentRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                    <div
                        className="sheet-rows-freeze-handle"
                        onMouseDown={onRowFreezeHandleMouseDown}
                        style={{
                            top: freezeHandleTop || 0,
                        }}
                    />
                </div>
            </div>
            {/* Beside the header, not in it: a portal's events still bubble up the React tree, so the pointer over the
                menu would hover the row or column behind it. */}
            {rowMenuAnchor}
        </>
    );
};
