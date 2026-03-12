import _ from "lodash";
import React, {useCallback, useContext, useRef} from "react";
import WorkbookContext from "../../context";
import {useOutsideClick} from "../../hooks/useOutsideClick";
import SheetListItem from "./SheetListItem";

export const SheetList: React.FC = () => {
    const {context, setContext} = useContext(WorkbookContext);
    const containerRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.showSheetList = false;
        });
    }, [setContext]);
    useOutsideClick(containerRef, close, [close]);

    return (
        <div
            className="fortune-context-menu luckysheet-cols-menu overflow-y-auto overflow-x-hidden min-w-[120px] absolute z-[10002] bottom-[53px] ml-[72px] max-h-[60%]"
            ref={containerRef}
        >
            {_.sortBy(context.luckysheetfile, (s) => Number(s.order)).map(
                (singleSheet) => {
                    return <SheetListItem sheet={singleSheet} key={singleSheet.id}/>;
                }
            )}
        </div>
    );
};

