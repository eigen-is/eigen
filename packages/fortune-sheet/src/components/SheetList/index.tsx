import {useCallback, useContext, useRef} from "react";
import {WorkbookContext} from "../../context";
import {useOutsideClick} from "../../hooks/useOutsideClick";
import {SheetListItem} from "./SheetListItem";

export function SheetList() {
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
            className="overflow-y-auto overflow-x-hidden min-w-[120px] fixed bottom-[53px] left-[72px] max-h-[60%] rounded-md border bg-popover p-1 shadow-lg"
            style={{zIndex: 10002}}
            ref={containerRef}
        >
            {context.luckysheetfile
                .slice()
                .sort((s1, s2) => Number(s1.order) - Number(s2.order))
                .map((singleSheet) => {
                    return <SheetListItem sheet={singleSheet} key={singleSheet.id}/>;
                })}
        </div>
    );
}
