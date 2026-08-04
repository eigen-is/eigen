import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { Check, ChevronsLeft, ChevronsRight, LayoutGrid, Plus } from 'lucide-react';
import type React from 'react';
import { Fragment, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { addSheet, calcSelectionInfo, cancelActiveImgItem, cancelNormalSelected, en, updateCell } from '../../state';
import { SheetItem } from './SheetItem';

const iconButtonClass =
    'inline-flex w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground';

export const SheetTab: React.FC = () => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const tabContainerRef = useRef<HTMLDivElement>(null);
    const [isShowScrollBtn, setIsShowScrollBtn] = useState<boolean>(false);
    const [isShowBoundary, setIsShowBoundary] = useState<boolean>(true);
    const { info, formula } = en;

    const [calInfo, setCalInfo] = useState<{
        numberC: number;
        count: number;
        sum: string;
        max: string;
        min: string;
        average: string;
    }>({
        numberC: 0,
        count: 0,
        sum: '0',
        max: '0',
        min: '0',
        average: '',
    });

    // biome-ignore lint/correctness/useExhaustiveDependencies: selection-info recompute is intentionally selection-only; firing on every props/context change would churn
    useEffect(() => {
        if (context.selections) {
            setCalInfo(calcSelectionInfo(context));
        }
    }, [context.selections]);

    const scrollDelta = 150;

    const scrollBy = useCallback((amount: number) => {
        const container = tabContainerRef.current;
        if (container?.scrollLeft == null) return;

        const { scrollLeft } = container;
        if (scrollLeft + amount <= 0) setIsShowBoundary(true);
        else if (scrollLeft > 0) setIsShowBoundary(false);

        container.scrollBy({
            left: amount,
            behavior: 'smooth',
        });
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: workbook-file change is the trigger — re-checks whether tab scroll buttons are needed
    useEffect(() => {
        const tabCurrent = tabContainerRef.current;
        if (!tabCurrent) return;
        setIsShowScrollBtn(tabCurrent.scrollWidth - 2 > tabCurrent.clientWidth);
    }, [context.sheets]);

    const onAddSheetClick = useCallback(
        () =>
            setTimeout(() => {
                setContext(
                    (draftCtx) => {
                        if (draftCtx.editingCellPosition.length > 0) {
                            updateCell(
                                draftCtx,
                                draftCtx.editingCellPosition[0],
                                draftCtx.editingCellPosition[1],
                                refs.cellInput.current!,
                            );
                        }
                        addSheet(draftCtx, settings);
                    },
                    { addSheetOp: true },
                );
                const tabCurrent = tabContainerRef.current;
                if (tabCurrent) {
                    setIsShowScrollBtn(tabCurrent.scrollWidth > tabCurrent.clientWidth);
                }
            }),
        [refs.cellInput, setContext, settings],
    );

    const stats = [
        calInfo.count ? `${formula.count}: ${calInfo.count}` : null,
        calInfo.numberC && calInfo.sum ? `${formula.sum}: ${calInfo.sum}` : null,
        calInfo.numberC && calInfo.average ? `${formula.average}: ${calInfo.average}` : null,
        calInfo.numberC && calInfo.max ? `${formula.max}: ${calInfo.max}` : null,
        calInfo.numberC && calInfo.min ? `${formula.min}: ${calInfo.min}` : null,
    ].filter((s): s is string => s !== null);

    return (
        <div
            className="flex h-8 select-none items-stretch gap-1 border-t bg-muted app-gutter-x text-xs text-muted-foreground"
            onContextMenu={(e) => e.preventDefault()}
        >
            {context.allowEdit && (
                <button type="button" className={iconButtonClass} onClick={onAddSheetClick} aria-label={info.newSheet}>
                    <Plus width={16} height={16} aria-hidden="true" />
                </button>
            )}
            {/* Pure navigation (saves scroll + sets currentSheetId) — available to viewers too,
                since on mobile the tab strip is hidden and this is the only way to switch sheets. */}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button type="button" className={iconButtonClass} aria-label="All sheets">
                        <LayoutGrid width={16} height={16} aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" collisionPadding={8}>
                    {context.sheets
                        .filter((s) => s.hide !== 1)
                        .sort((s1, s2) => Number(s1.order) - Number(s2.order))
                        .map((singleSheet) => (
                            <DropdownMenuItem
                                key={singleSheet.id}
                                onClick={() => {
                                    setContext((draftCtx) => {
                                        draftCtx.sheetScrollRecord[draftCtx.currentSheetId] = {
                                            scrollLeft: draftCtx.scrollLeft,
                                            scrollTop: draftCtx.scrollTop,
                                            selectionActive: draftCtx.selectionActive,
                                            selections: draftCtx.selections,
                                            formulaRangeSelections: draftCtx.formulaRangeSelections,
                                        };
                                        draftCtx.currentSheetId = singleSheet.id!;
                                        cancelActiveImgItem(draftCtx, refs.globalCache);
                                        cancelNormalSelected(draftCtx);
                                    });
                                }}
                            >
                                <span className="inline-flex w-5 items-center">
                                    {singleSheet.id === context.currentSheetId && (
                                        <Check width={14} height={14} aria-hidden="true" />
                                    )}
                                </span>
                                {!!singleSheet.color && (
                                    <span
                                        className="mr-1 size-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: singleSheet.color }}
                                        aria-hidden="true"
                                    />
                                )}
                                {singleSheet.name}
                            </DropdownMenuItem>
                        ))}
                </DropdownMenuContent>
            </DropdownMenu>

            <div className="hidden min-w-0 flex-1 gap-0.5 sm:flex">
                <div className="relative flex min-w-0 flex-1">
                    {!isShowBoundary && (
                        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-2 bg-gradient-to-r from-muted to-transparent" />
                    )}
                    <div ref={tabContainerRef} className="flex min-w-0 flex-1 overflow-hidden">
                        {[...context.sheets]
                            .sort((a, b) => Number(a.order) - Number(b.order))
                            .map((sheet) => (
                                <SheetItem key={sheet.id} sheet={sheet} />
                            ))}
                    </div>
                    {isShowBoundary && isShowScrollBtn && (
                        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-2 bg-gradient-to-l from-muted to-transparent" />
                    )}
                </div>
                {isShowScrollBtn && (
                    <button
                        type="button"
                        className={cn(iconButtonClass, 'w-5')}
                        onClick={() => scrollBy(-scrollDelta)}
                        aria-label="Scroll tabs left"
                    >
                        <ChevronsLeft width={12} height={12} aria-hidden="true" />
                    </button>
                )}
                {isShowScrollBtn && (
                    <button
                        type="button"
                        className={cn(iconButtonClass, 'w-5')}
                        onClick={() => scrollBy(scrollDelta)}
                        aria-label="Scroll tabs right"
                    >
                        <ChevronsRight width={12} height={12} aria-hidden="true" />
                    </button>
                )}
            </div>

            {stats.length > 0 && (
                <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-2 text-xs text-muted-foreground">
                    {stats.map((s, i) => (
                        <Fragment key={s}>
                            {i > 0 && (
                                <span aria-hidden="true" className="text-muted-foreground/40">
                                    ·
                                </span>
                            )}
                            <span>{s}</span>
                        </Fragment>
                    ))}
                </div>
            )}
        </div>
    );
};
