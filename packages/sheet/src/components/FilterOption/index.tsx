import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { useCallback, useContext, useEffect } from 'react';
import { WorkbookContext } from '../../context';
import {
    createFilterOptions,
    fixColumnStyleOverflowInFreeze,
    fixRowStyleOverflowInFreeze,
    getSheetIndex,
} from '../../state';

export function FilterOptions() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { filterOptions, currentSheetId, filter, visibledatarow, visibledatacolumn } = context;
    const sheetIndex = getSheetIndex(context, context.currentSheetId);
    const { filterRange: sheetFilterRange, frozen } = context.sheets[sheetIndex!];

    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers — body reads `draftCtx` so biome can't see the connection
    useEffect(() => {
        setContext((draftCtx) => {
            const sheetIdx = getSheetIndex(draftCtx, draftCtx.currentSheetId);
            if (sheetIdx == null) return;
            draftCtx.filterRange = draftCtx.sheets[sheetIdx].filterRange;
            draftCtx.filter = draftCtx.sheets[sheetIdx].filter || {};
            createFilterOptions(draftCtx, draftCtx.filterRange, undefined);
        });
    }, [visibledatarow, visibledatacolumn, setContext, currentSheetId, sheetFilterRange]);

    const showFilterContextMenu = useCallback(
        (
            v: {
                col: number;
                left: number;
                top: number;
            },
            i: number,
        ) => {
            if (filterOptions == null) return;
            setContext((draftCtx) => {
                if (draftCtx.filterContextMenu?.col === filterOptions.startCol + i) return;
                draftCtx.filterContextMenu = {
                    x: v.left + draftCtx.rowHeaderWidth - refs.globalCache.scrollLeft,
                    y:
                        v.top +
                        23 +
                        draftCtx.toolbarHeight +
                        draftCtx.calculatebarHeight +
                        draftCtx.columnHeaderHeight -
                        refs.globalCache.scrollTop,
                    col: filterOptions.startCol + i,
                    startRow: filterOptions.startRow,
                    endRow: filterOptions.endRow,
                    startCol: filterOptions.startCol,
                    endCol: filterOptions.endCol,
                    hiddenRows: Object.keys(draftCtx.filter[i]?.rowhidden ?? {}).map((r) => parseInt(r, 10)),
                    listBoxMaxHeight: 400,
                };
            });
        },
        [filterOptions, refs.globalCache, setContext],
    );

    const freezeType = frozen?.type;
    let frozenColumns = -1;
    let frozenRows = -1;

    if (freezeType === 'row') frozenRows = 0;
    else if (freezeType === 'column') frozenColumns = 0;
    else if (freezeType === 'both') {
        frozenColumns = 0;
        frozenRows = 0;
    } else {
        frozenColumns = frozen?.range?.column_focus ?? -1;
        frozenRows = frozen?.range?.row_focus ?? -1;
    }

    return filterOptions == null ? (
        <div />
    ) : (
        <>
            <div
                className="pointer-events-none absolute -mt-px -ml-px box-content border border-selection-handle"
                style={Object.assign(
                    {
                        left: filterOptions.left,
                        width: filterOptions.width,
                        top: filterOptions.top,
                        height: filterOptions.height,
                        // Sheet canvas-internal overlay; sits with the selection box (z 15)
                        // under the cellArea ≤ 30 ceiling.
                        zIndex: 15,
                    },
                    fixRowStyleOverflowInFreeze(
                        context,
                        filterOptions.startRow,
                        filterOptions.endRow,
                        refs.globalCache.freezen?.[context.currentSheetId],
                    ),
                    fixColumnStyleOverflowInFreeze(
                        context,
                        filterOptions.startCol,
                        filterOptions.endCol,
                        refs.globalCache.freezen?.[context.currentSheetId],
                    ),
                )}
            />
            {filterOptions.items.map((v, i) => {
                const filterParam = filter[i];
                const columnOverflowFreezeStyle = fixColumnStyleOverflowInFreeze(
                    context,
                    i + filterOptions.startCol,
                    i + filterOptions.startCol,
                    refs.globalCache.freezen?.[context.currentSheetId],
                );

                const rowOverflowFreezeStyle = fixRowStyleOverflowInFreeze(
                    context,
                    filterOptions.startRow,
                    filterOptions.startRow,
                    refs.globalCache.freezen?.[context.currentSheetId],
                );

                const col = visibledatacolumn[v.col];
                const col_pre = v.col > 0 ? visibledatacolumn[v.col - 1] : 0;

                const left =
                    v.col <= frozenColumns && columnOverflowFreezeStyle.left
                        ? columnOverflowFreezeStyle.left + col - col_pre - 20
                        : v.left;

                const top =
                    filterOptions.startRow <= frozenRows && rowOverflowFreezeStyle.top
                        ? rowOverflowFreezeStyle.top
                        : v.top;

                const v_adjusted = { ...v, left, top };

                return (
                    <div
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            showFilterContextMenu(v_adjusted, i);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        tabIndex={0}
                        // biome-ignore lint/suspicious/noArrayIndexKey: filter dropdowns keyed by column index in stable per-sheet list
                        key={i}
                        style={Object.assign(rowOverflowFreezeStyle, columnOverflowFreezeStyle, {
                            left,
                            top,
                            height: 15,
                            width: undefined,
                            // Sheet canvas-internal overlay (cellArea ≤ 30 world).
                            zIndex: 12,
                        })}
                        className={cn(
                            'absolute flex cursor-pointer items-center rounded-sm border border-primary px-0.5',
                            filterParam == null
                                ? 'bg-background text-primary hover:bg-primary hover:text-primary-foreground'
                                : 'bg-primary text-primary-foreground',
                        )}
                    >
                        {filterParam == null ? (
                            <ChevronDown className="size-3" aria-hidden="true" />
                        ) : (
                            <svg
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                stroke="none"
                                style={{ width: 13, height: 13 }}
                                aria-hidden="true"
                            >
                                <path d="M18.14 4a1.5 1.5 0 0 1 1.16 2.44L14.7 12.15v6.4l-5.37-2.56v-3.96L4.5 6.31A1.5 1.5 0 0 1 5.76 4h12.38z" />
                            </svg>
                        )}
                    </div>
                );
            })}
        </>
    );
}
