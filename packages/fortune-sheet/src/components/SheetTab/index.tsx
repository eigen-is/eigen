import {ChevronsLeft, ChevronsRight, LayoutGrid, Plus} from "lucide-react";
import React, {useCallback, useContext, useEffect, useRef, useState,} from "react";
import {addSheet, locale, updateCell} from "../../core";
import {WorkbookContext} from "../../context";
import "./index.css";
import {SheetItem} from "./SheetItem";
import {ZoomControl} from "../ZoomControl";

export const SheetTab: React.FC = () => {
    const {context, setContext, settings, refs} = useContext(WorkbookContext);
    const tabContainerRef = useRef<HTMLDivElement>(null);
    const leftScrollRef = useRef<HTMLDivElement>(null);
    const rightScrollRef = useRef<HTMLDivElement>(null);
    const [isShowScrollBtn, setIsShowScrollBtn] = useState<boolean>(false);
    const [isShowBoundary, setIsShowBoundary] = useState<boolean>(true);
    const {info} = locale(context);

    const scrollDelta = 150;

    const scrollBy = useCallback((amount: number) => {
        const container = tabContainerRef.current;
        if (container?.scrollLeft == null) return;

        const {scrollLeft} = container;
        if (scrollLeft + amount <= 0) setIsShowBoundary(true);
        else if (scrollLeft > 0) setIsShowBoundary(false);

        container.scrollBy({
            left: amount,
            behavior: "smooth",
        });
    }, []);

    useEffect(() => {
        const tabCurrent = tabContainerRef.current;
        if (!tabCurrent) return;
        setIsShowScrollBtn(tabCurrent.scrollWidth - 2 > tabCurrent.clientWidth);
    }, [context.luckysheetfile]);

    const onAddSheetClick = useCallback(
        () =>
            setTimeout(() => {
                setContext(
                    (draftCtx) => {
                        if (draftCtx.luckysheetCellUpdate.length > 0) {
                            updateCell(
                                draftCtx,
                                draftCtx.luckysheetCellUpdate[0],
                                draftCtx.luckysheetCellUpdate[1],
                                refs.cellInput.current!
                            );
                        }
                        addSheet(draftCtx, settings);
                    },
                    {addSheetOp: true}
                );
                const tabCurrent = tabContainerRef.current;
                if (tabCurrent) {
                    setIsShowScrollBtn(tabCurrent.scrollWidth > tabCurrent.clientWidth);
                }
            }),
        [refs.cellInput, setContext, settings]
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
                        <Plus width={16} height={16} aria-hidden="true"/>
                    </div>
                )}
                {context.allowEdit && (
                    <div className="sheet-list-container">
                        <div
                            id="all-sheets"
                            className="fortune-sheettab-button"
                            ref={tabContainerRef}
                            onMouseDown={(e) => {
                                e.stopPropagation();
                                setContext((ctx) => {
                                    ctx.showSheetList = !(ctx.showSheetList ?? false);
                                    ctx.sheetTabContextMenu = {};
                                });
                            }}
                        >
                            <LayoutGrid width={16} height={16} aria-hidden="true"/>
                        </div>
                    </div>
                )}
                <div
                    id="luckysheet-sheets-m"
                    className="luckysheet-sheets-m lucky-button-custom"
                >
                    <i className="iconfont luckysheet-iconfont-caidan2"/>
                </div>
                <div
                    className="fortune-sheettab-container"
                    id="fortune-sheettab-container"
                >
                    {!isShowBoundary && <div className="boundary boundary-left"/>}
                    <div
                        className="fortune-sheettab-container-c"
                        id="fortune-sheettab-container-c"
                        ref={tabContainerRef}
                    >
                        {[...context.luckysheetfile].sort((a, b) => Number(a.order) - Number(b.order)).map(
                            (sheet) => {
                                return <SheetItem key={sheet.id} sheet={sheet}/>;
                            }
                        )}
                        {/* <SheetItem
              isDropPlaceholder
              sheet={{ name: "", id: "drop-placeholder" }}
            /> */}
                    </div>
                    {isShowBoundary && isShowScrollBtn && (
                        <div className="boundary boundary-right"/>
                    )}
                </div>
                {isShowScrollBtn && (
                    <div
                        id="fortune-sheettab-leftscroll"
                        className="fortune-sheettab-scroll"
                        ref={leftScrollRef}
                        onClick={() => {
                            scrollBy(-scrollDelta);
                        }}
                        tabIndex={0}
                    >
                        <ChevronsLeft width={12} height={12} aria-hidden="true"/>
                    </div>
                )}
                {isShowScrollBtn && (
                    <div
                        id="fortune-sheettab-rightscroll"
                        className="fortune-sheettab-scroll"
                        ref={rightScrollRef}
                        onClick={() => {
                            scrollBy(scrollDelta);
                        }}
                        tabIndex={0}
                    >
                        <ChevronsRight width={12} height={12} aria-hidden="true"/>
                    </div>
                )}
            </div>
            <div className="fortune-sheet-area-right">
                <ZoomControl/>
            </div>
        </div>
    );
};

