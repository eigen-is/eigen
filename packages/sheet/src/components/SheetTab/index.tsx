import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Check, ChevronsLeft, ChevronsRight, LayoutGrid, Plus } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { addSheet, cancelActiveImgItem, cancelNormalSelected, locale, updateCell } from '../../state';
import './index.css';
import { SheetItem } from './SheetItem';

export const SheetTab: React.FC = () => {
    const { context, setContext, settings, refs } = useContext(WorkbookContext);
    const tabContainerRef = useRef<HTMLDivElement>(null);
    const [isShowScrollBtn, setIsShowScrollBtn] = useState<boolean>(false);
    const [isShowBoundary, setIsShowBoundary] = useState<boolean>(true);
    const { info } = locale(context);

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

    return (
        <div
            className="luckysheet-sheet-area luckysheet-noselected-text border-t"
            onContextMenu={(e) => e.preventDefault()}
            id="luckysheet-sheet-area"
        >
            <div id="luckysheet-sheet-content">
                {context.allowEdit && (
                    <div
                        className="fortune-sheettab-button"
                        onClick={onAddSheetClick}
                        tabIndex={0}
                        aria-label={info.newSheet}
                        role="button"
                    >
                        <Plus width={16} height={16} aria-hidden="true" />
                    </div>
                )}
                {context.allowEdit && (
                    <div className="sheet-list-container">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <div id="all-sheets" className="fortune-sheettab-button">
                                    <LayoutGrid width={16} height={16} aria-hidden="true" />
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start" collisionPadding={8}>
                                {context.sheets
                                    .slice()
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
                                            <span className="w-5 inline-flex items-center">
                                                {singleSheet.id === context.currentSheetId && (
                                                    <Check width={14} height={14} aria-hidden="true" />
                                                )}
                                            </span>
                                            {!!singleSheet.color && (
                                                <div
                                                    className="w-1.5 h-4 rounded-sm mr-1"
                                                    style={{ background: singleSheet.color }}
                                                />
                                            )}
                                            {singleSheet.name}
                                        </DropdownMenuItem>
                                    ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                )}
                <div className="fortune-sheettab-container" id="fortune-sheettab-container">
                    {!isShowBoundary && <div className="boundary boundary-left" />}
                    <div
                        className="fortune-sheettab-container-c"
                        id="fortune-sheettab-container-c"
                        ref={tabContainerRef}
                    >
                        {[...context.sheets]
                            .sort((a, b) => Number(a.order) - Number(b.order))
                            .map((sheet) => (
                                <SheetItem key={sheet.id} sheet={sheet} />
                            ))}
                    </div>
                    {isShowBoundary && isShowScrollBtn && <div className="boundary boundary-right" />}
                </div>
                {isShowScrollBtn && (
                    <div
                        id="fortune-sheettab-leftscroll"
                        className="fortune-sheettab-scroll"
                        onClick={() => {
                            scrollBy(-scrollDelta);
                        }}
                        tabIndex={0}
                    >
                        <ChevronsLeft width={12} height={12} aria-hidden="true" />
                    </div>
                )}
                {isShowScrollBtn && (
                    <div
                        id="fortune-sheettab-rightscroll"
                        className="fortune-sheettab-scroll"
                        onClick={() => {
                            scrollBy(scrollDelta);
                        }}
                        tabIndex={0}
                    >
                        <ChevronsRight width={12} height={12} aria-hidden="true" />
                    </div>
                )}
            </div>
        </div>
    );
};
