import {cancelActiveImgItem, cancelNormalSelected, Sheet,} from "../../core";
import React, {useContext, useEffect, useRef} from "react";
import WorkbookContext from "../../context";
import SheetHiddenButton from "./SheetHiddenButton";
import {SVGIcon} from "../icon-map";

type Props = {
    sheet: Sheet;
    isDropPlaceholder?: boolean;
};

const SheetListItem: React.FC<Props> = ({sheet, isDropPlaceholder}) => {
    const {context, setContext, refs} = useContext(WorkbookContext);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setContext((draftCtx) => {
            const r = context.sheetScrollRecord[draftCtx?.currentSheetId];
            if (r) {
                draftCtx.scrollLeft = r.scrollLeft ?? 0;
                draftCtx.scrollTop = r.scrollTop ?? 0;
                draftCtx.luckysheet_select_status = r.luckysheet_select_status ?? false;
                draftCtx.luckysheet_select_save = r.luckysheet_select_save ?? undefined;
            } else {
                draftCtx.scrollLeft = 0;
                draftCtx.scrollTop = 0;
                draftCtx.luckysheet_select_status = false;
                draftCtx.luckysheet_select_save = undefined;
            }
            draftCtx.luckysheet_selection_range = [];
        });
    }, [context.currentSheetId, context.sheetScrollRecord, setContext]);

    return (
        <div
            className="h-[30px] leading-[30px] w-full mr-[46px] cursor-pointer hover:bg-accent"
            key={sheet.id}
            ref={containerRef}
            onClick={() => {
                if (isDropPlaceholder) return;
                setContext((draftCtx) => {
                    draftCtx.sheetScrollRecord[draftCtx.currentSheetId] = {
                        scrollLeft: draftCtx.scrollLeft,
                        scrollTop: draftCtx.scrollTop,
                        luckysheet_select_status: draftCtx.luckysheet_select_status,
                        luckysheet_select_save: draftCtx.luckysheet_select_save,
                        luckysheet_selection_range: draftCtx.luckysheet_selection_range,
                    };
                    draftCtx.currentSheetId = sheet.id!;
                    draftCtx.zoomRatio = sheet.zoomRatio || 1;
                    cancelActiveImgItem(draftCtx, refs.globalCache);
                    cancelNormalSelected(draftCtx);
                });
            }}
            tabIndex={0}
        >
      <span className="w-5 inline-block ml-[15px]">
        {sheet.id === context.currentSheetId && (
            <SVGIcon
                name="check"
                width={16}
                height={16}
                style={{lineHeight: 30, verticalAlign: "middle"}}
            />
        )}
      </span>
            <span
                className="mr-[15px] relative"
                spellCheck="false"
            >
        {!!sheet.color && (
            <div
                className="w-[6%] h-full absolute bottom-0 -left-1.5"
                style={{background: sheet.color}}
            />
        )}
                {sheet.name}
      </span>
            {sheet.hide && <SheetHiddenButton sheet={sheet}/>}
        </div>
    );
};

export default SheetListItem;
