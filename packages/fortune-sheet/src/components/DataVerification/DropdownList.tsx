import {getCellValue, getDropdownList, getFlowdata, getSheetIndex, mergeBorder, setDropcownValue,} from "../../core";
import {useCallback, useContext, useEffect, useRef, useState,} from "react";
import {WorkbookContext} from "../../context";
import {useOutsideClick} from "../../hooks/useOutsideClick";
import {Check} from "lucide-react";


export function DropDownList() {
    const {context, setContext} = useContext(WorkbookContext);
    const containerRef = useRef<HTMLDivElement>(null);
    const [list, setList] = useState<any[]>([]);
    const [isMul, setIsMul] = useState<boolean>(false);
    const [position, setPosition] = useState<{ left: number; top: number }>();
    const [selected, setSelected] = useState<any[]>([]);

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.dataVerificationDropDownList = false;
        });
    }, [setContext]);

    useOutsideClick(containerRef, close, [close]);

    // Initialize multi-select dropdown
    useEffect(() => {
        if (!context.luckysheet_select_save) return;
        const last =
            context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
        const rowIndex = last.row_focus;
        const colIndex = last.column_focus;
        if (rowIndex == null || colIndex == null) return;
        let row = context.visibledatarow[rowIndex];
        let col_pre = colIndex === 0 ? 0 : context.visibledatacolumn[colIndex - 1];
        const d = getFlowdata(context);
        if (!d) return;
        const margeSet = mergeBorder(context, d, rowIndex, colIndex);
        if (margeSet) {
            [, row] = margeSet.row;
            [col_pre, ,] = margeSet.column;
        }
        const index = getSheetIndex(context, context.currentSheetId) as number;
        const {dataVerification} = context.luckysheetfile[index];
        const item = dataVerification[`${rowIndex}_${colIndex}`];
        const dropdownList = getDropdownList(context, item.value1);
        // Pre-select current cell value in the dropdown
        const cellValue = getCellValue(rowIndex, colIndex, d);

        if (cellValue) {
            setSelected(cellValue.toString().split(","));
        }
        setList(dropdownList);
        setPosition({
            left: col_pre,
            top: row,
        });
        setIsMul(item.type2 === "true");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update dropdown value on sheet change
    useEffect(() => {
        if (!context.luckysheet_select_save) return;
        const last =
            context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
        const rowIndex = last.row_focus;
        const colIndex = last.column_focus;
        if (rowIndex == null || colIndex == null) return;
        const index = getSheetIndex(context, context.currentSheetId) as number;
        const {dataVerification} = context.luckysheetfile[index];
        const item = dataVerification[`${rowIndex}_${colIndex}`];
        if (item.type2 !== "true") return;
        const d = getFlowdata(context);
        if (!d) return;
        const cellValue = getCellValue(rowIndex, colIndex, d);
        if (cellValue) {
            setSelected(cellValue.toString().split(","));
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [context.luckysheetfile]);

    return (
        <div
            className="absolute z-[10000] bg-background border border-border shadow-md box-border text-xs"
            style={position}
            ref={containerRef}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            tabIndex={0}
        >
            {list.map((v, i) => (
                <div
                    className="px-2.5 py-1.5 box-border cursor-pointer hover:bg-accent"
                    key={i}
                    onClick={() => {
                        setContext((ctx) => {
                            const arr = selected;
                            const index = arr.indexOf(v);
                            if (index < 0) {
                                arr.push(v);
                            } else {
                                arr.splice(index, 1);
                            }
                            setSelected(arr);
                            setDropcownValue(ctx, v, arr);
                        });
                    }}
                    tabIndex={0}
                >
                    <Check
                        width={12}
                        height={12}
                        style={{
                            verticalAlign: "middle",
                            display: isMul && selected.includes(v) ? "inline" : "none",
                        }}
                    />
                    {v}
                </div>
            ))}
        </div>
    );
}
