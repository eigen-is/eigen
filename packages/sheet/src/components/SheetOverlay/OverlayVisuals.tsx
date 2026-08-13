import { PresenceLabel } from '@workspace/ui/components/collab';
import type React from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { createDropCellRange, onCellsMoveStart, seletedHighlistByindex } from '../../state';

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

    return (
        <>
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
                            className={`fortune-search-highlight eigen-search-match${active ? ' eigen-search-match-active' : ''}`}
                            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                        />
                    );
                })}
            <div
                className="luckysheet-cell-selected-focus"
                style={
                    (context.selections?.length ?? 0) > 0
                        ? (() => {
                              const selection = context.selections!.at(-1)!;
                              return {
                                  left: selection.left,
                                  top: selection.top,
                                  width: selection?.width || 0,
                                  height: selection?.height || 0,
                                  display: 'block',
                              };
                          })()
                        : {}
                }
                onMouseDown={(e) => e.preventDefault()}
            />
            {(context.formulaRangeSelections?.length ?? 0) > 0 && (
                <div>
                    {context.formulaRangeSelections!.map((range) => {
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
            <div className="fortune-cell-selected-extend" />
            <div className="fortune-cell-selected-move" onMouseDown={(e) => e.preventDefault()} />
            {(context.selections?.length ?? 0) > 0 && (
                <div>
                    {context.selections!.map((selection) => (
                        <div
                            key={`${selection.row[0]}-${selection.row[1]}-${selection.column[0]}-${selection.column[1]}`}
                            className="luckysheet-cell-selected"
                            style={{
                                left: selection.left_move,
                                top: selection.top_move,
                                width: selection?.width_move || 0,
                                height: selection?.height_move || 0,
                                display: 'block',
                            }}
                            onMouseDown={(e) => {
                                e.stopPropagation();
                                const { nativeEvent } = e;
                                setContext((draftCtx) => {
                                    onCellsMoveStart(
                                        draftCtx,
                                        refs.globalCache,
                                        nativeEvent,
                                        refs.cellArea.current!,
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
                            <PresenceLabel color={color} name={presence.username} />
                        </div>
                    );
                })}
        </>
    );
}
