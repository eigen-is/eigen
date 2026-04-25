import { Check } from 'lucide-react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useOutsideClick } from '../../hooks/useOutsideClick';
import { getCellValue, getDropdownList, getFlowdata, getSheetIndex, mergeBorder, setDropcownValue } from '../../state';

export function DropDownList() {
    const { context, setContext } = useContext(WorkbookContext);
    const containerRef = useRef<HTMLDivElement>(null);
    const [list, setList] = useState<(string | number | boolean)[]>([]);
    const [isMul, setIsMul] = useState<boolean>(false);
    const [position, setPosition] = useState<{ left: number; top: number }>();
    const [selected, setSelected] = useState<string[]>([]);

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.dataVerificationDropDownList = false;
        });
    }, [setContext]);

    useOutsideClick(containerRef, close);

    // Initialize multi-select dropdown
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — captures the initial cell, position, and dropdown values
    useEffect(() => {
        if (!context.luckysheet_select_save) return;
        const last = context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
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
        const { dataVerification } = context.luckysheetfile[index];
        const item = dataVerification[`${rowIndex}_${colIndex}`];
        const dropdownList = getDropdownList(context, item.value1);
        // Pre-select current cell value in the dropdown
        const cellValue = getCellValue(rowIndex, colIndex, d);

        if (cellValue) {
            setSelected(cellValue.toString().split(','));
        }
        setList(dropdownList);
        setPosition({
            left: col_pre,
            top: row,
        });
        setIsMul(item.type2 === 'true');
    }, []);

    // Update dropdown value on sheet change
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-syncs preselected values only when the workbook file changes
    useEffect(() => {
        if (!context.luckysheet_select_save) return;
        const last = context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
        const rowIndex = last.row_focus;
        const colIndex = last.column_focus;
        if (rowIndex == null || colIndex == null) return;
        const index = getSheetIndex(context, context.currentSheetId) as number;
        const { dataVerification } = context.luckysheetfile[index];
        const item = dataVerification[`${rowIndex}_${colIndex}`];
        if (item.type2 !== 'true') return;
        const d = getFlowdata(context);
        if (!d) return;
        const cellValue = getCellValue(rowIndex, colIndex, d);
        if (cellValue) {
            setSelected(cellValue.toString().split(','));
        }
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
            {list.map((v, i) => {
                const vStr = String(v);
                return (
                    <div
                        className="px-2.5 py-1.5 box-border cursor-pointer hover:bg-accent"
                        // biome-ignore lint/suspicious/noArrayIndexKey: dropdown values can repeat, index is the stable identity
                        key={i}
                        onClick={() => {
                            setContext((ctx) => {
                                const arr = selected;
                                const index = arr.indexOf(vStr);
                                if (index < 0) {
                                    arr.push(vStr);
                                } else {
                                    arr.splice(index, 1);
                                }
                                setSelected(arr);
                                setDropcownValue(ctx, vStr, arr);
                            });
                        }}
                        tabIndex={0}
                    >
                        <Check
                            width={12}
                            height={12}
                            style={{
                                verticalAlign: 'middle',
                                display: isMul && selected.includes(vStr) ? 'inline' : 'none',
                            }}
                        />
                        {v}
                    </div>
                );
            })}
        </div>
    );
}
