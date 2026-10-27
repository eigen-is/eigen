// The rectangles drawn over the grid in each pane region, such as the selection, the focus box, formula
// ranges, find matches and peers' cursors, plus the selection's move band and fill handle, whose
// press starts a cell move or a fill drag.

import { PresenceLabel } from '@workspace/ui/components/collab';
import type React from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { cellGlyphAtPointer, createDropCellRange, onCellsMoveStart, seletedHighlistByindex } from '../../state';

type Props = {
    containerRef: React.RefObject<HTMLDivElement | null>;
};

// The passive rectangle visuals (selection boxes, focus box, formula-range
// selects/highlights, search highlights, presence, copy/move/extend
// indicators), rendered once per overlay pane region in pure content
// coordinates — each region's overflow clip shows exactly its portion, which
// replaces the old per-element fix*StyleOverflowInFreeze clamps. Elements the
// state layer positions imperatively (move/extend previews, the formula range
// select) are written per-copy via querySelectorAll.
export function OverlayVisuals({ containerRef }: Props) {
    const { context, setContext, refs } = useContext(WorkbookContext);

    // The one entry for the selection's two DOM drag targets, the move band and
    // the fill handle. A painted cell glyph under the pointer outranks either:
    // the press is left to bubble to the cell area, whose mousedown opens the
    // list, toggles the box or selects the marked cell instead of starting a drag.
    // Decided outside the recipe, since stopPropagation has to happen now.
    const onHandleMouseDown = (e: React.MouseEvent<HTMLDivElement>, handle: 'move' | 'fill') => {
        const { nativeEvent } = e;
        const cellArea = refs.cellArea.current;
        if (!cellArea || cellGlyphAtPointer(context, refs.globalCache, nativeEvent, cellArea) != null) return;
        e.stopPropagation();
        setContext((draftCtx) => {
            const container = containerRef.current;
            if (!container) return;
            if (handle === 'fill') {
                createDropCellRange(draftCtx, nativeEvent, container);
            } else {
                onCellsMoveStart(draftCtx, refs.globalCache, nativeEvent, cellArea, container);
            }
        });
    };
    const focus = context.selections?.at(-1);

    return (
        <>
            {context.formulaRangeSelect && (
                <div
                    className="sheet-selection-copy sheet-formula-functionrange-select"
                    style={context.formulaRangeSelect}
                >
                    <div className="sheet-selection-copy-top sheet-copy" />
                    <div className="sheet-selection-copy-right sheet-copy" />
                    <div className="sheet-selection-copy-bottom sheet-copy" />
                    <div className="sheet-selection-copy-left sheet-copy" />
                    <div className="sheet-selection-copy-hc" />
                </div>
            )}
            {context.formulaRangeHighlight.map((v) => {
                const { rangeIndex, backgroundColor } = v;
                return (
                    <div
                        key={rangeIndex}
                        className="sheet-selection-highlight sheet-formula-functionrange-highlight"
                        style={(() => {
                            const { backgroundColor: _, ...rest } = v;
                            return rest;
                        })()}
                    >
                        {['top', 'right', 'bottom', 'left'].map((d) => (
                            <div
                                key={d}
                                data-type={d}
                                className={`sheet-selection-copy-${d} sheet-copy`}
                                style={{ backgroundColor }}
                            />
                        ))}
                        <div className="sheet-selection-copy-hc" style={{ backgroundColor }} />
                        {['lt', 'rt', 'lb', 'rb'].map((d) => (
                            <div
                                key={d}
                                data-type={d}
                                className={`sheet-selection-highlight-${d} sheet-highlight`}
                                style={{ backgroundColor }}
                            />
                        ))}
                    </div>
                );
            })}
            {context.searchHighlights
                ?.filter((h) => h.sheetId === context.currentSheetId)
                .slice(0, 200)
                .map((h) => {
                    const rect = seletedHighlistByindex(context, h.r, h.r, h.c, h.c);
                    if (!rect) return null;
                    const active =
                        context.searchActive?.sheetId === h.sheetId &&
                        context.searchActive.r === h.r &&
                        context.searchActive.c === h.c;
                    return (
                        <div
                            key={`${h.r}_${h.c}`}
                            className={`sheet-search-highlight eigen-search-match${active ? ' eigen-search-match-active' : ''}`}
                            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                        />
                    );
                })}
            <div
                className="sheet-cell-selected-focus"
                style={
                    focus
                        ? {
                              left: focus.left,
                              top: focus.top,
                              width: focus.width || 0,
                              height: focus.height || 0,
                              display: 'block',
                          }
                        : {}
                }
            />
            {context.formulaRangeSelections.length > 0 && (
                <div>
                    {context.formulaRangeSelections.map((range) => {
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
                                className="sheet-selection-copy"
                                key={`${r1}-${r2}-${c1}-${c2}`}
                                style={{
                                    left: col_pre,
                                    width: col - col_pre - 1,
                                    top: row_pre,
                                    height: row - row_pre - 1,
                                }}
                            >
                                <div className="sheet-selection-copy-top sheet-copy" />
                                <div className="sheet-selection-copy-right sheet-copy" />
                                <div className="sheet-selection-copy-bottom sheet-copy" />
                                <div className="sheet-selection-copy-left sheet-copy" />
                                <div className="sheet-selection-copy-hc" />
                            </div>
                        );
                    })}
                </div>
            )}
            <div className="sheet-cell-selected-extend" />
            <div className="sheet-cell-selected-move" onMouseDown={(e) => e.preventDefault()} />
            {context.selections && context.selections.length > 0 && (
                <div>
                    {context.selections.map((selection) => (
                        <div
                            key={`${selection.row[0]}-${selection.row[1]}-${selection.column[0]}-${selection.column[1]}`}
                            className="sheet-cell-selected"
                            style={{
                                left: selection.left_move,
                                top: selection.top_move,
                                width: selection?.width_move || 0,
                                height: selection?.height_move || 0,
                                display: 'block',
                            }}
                            onMouseDown={(e) => onHandleMouseDown(e, 'move')}
                        >
                            <div className="sheet-cs-inner-border" />
                            {/* Its stopPropagation keeps the parent's move-start off: at the corner the fill wins. */}
                            <div className="sheet-cs-fillhandle" onMouseDown={(e) => onHandleMouseDown(e, 'fill')} />
                            <div
                                className="sheet-cs-draghandle-top sheet-cs-draghandle"
                                onMouseDown={(e) => e.preventDefault()}
                            />
                            <div
                                className="sheet-cs-draghandle-bottom sheet-cs-draghandle"
                                onMouseDown={(e) => e.preventDefault()}
                            />
                            <div
                                className="sheet-cs-draghandle-left sheet-cs-draghandle"
                                onMouseDown={(e) => e.preventDefault()}
                            />
                            <div
                                className="sheet-cs-draghandle-right sheet-cs-draghandle"
                                onMouseDown={(e) => e.preventDefault()}
                            />
                        </div>
                    ))}
                </div>
            )}
            {context.presences?.map((presence, index) => {
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

                // A peer can publish a cursor before this client's visibledata* maps
                // exist (cold render) or beyond the loaded extent — skip to avoid NaN geometry.
                if (
                    !Number.isFinite(width) ||
                    !Number.isFinite(height) ||
                    !Number.isFinite(col_pre) ||
                    !Number.isFinite(row_pre)
                ) {
                    return null;
                }

                return (
                    <div
                        key={presence?.userId || index}
                        className="sheet-presence-selection eigen-selection-ring eigen-selection-ring-peer"
                        // React's CSSProperties has no custom properties, so the --peer-color entry needs the cast.
                        style={
                            {
                                left: col_pre,
                                top: row_pre,
                                width,
                                height,
                                '--peer-color': color,
                            } as React.CSSProperties
                        }
                    >
                        <PresenceLabel color={color} name={presence.username} />
                    </div>
                );
            })}
        </>
    );
}
