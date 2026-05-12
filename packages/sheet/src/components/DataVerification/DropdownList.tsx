import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getCellValue, getDropdownList, getFlowdata, getSheetIndex, setDropcownValue } from '../../state';

export function DropDownList() {
    const { context, setContext } = useContext(WorkbookContext);
    const open = !!context.dataVerificationDropDownList;

    const cellInfo = useMemo(() => {
        if (!open) return null;
        const last = context.luckysheet_select_save?.[context.luckysheet_select_save.length - 1];
        if (!last) return null;
        const { row_focus: r, column_focus: c } = last;
        if (r == null || c == null) return null;
        const sheetIndex = getSheetIndex(context, context.currentSheetId);
        if (sheetIndex == null || sheetIndex < 0) return null;
        const dv = context.luckysheetfile[sheetIndex]?.dataVerification?.[`${r}_${c}`];
        if (!dv) return null;
        const list = getDropdownList(context, dv.value1);
        const isMul = dv.type2 === 'true';
        const d = getFlowdata(context);
        const cellValue = d ? getCellValue(r, c, d) : null;
        const selected = cellValue != null && cellValue !== '' ? String(cellValue).split(',') : [];
        return { list, isMul, selected };
    }, [open, context]);

    const setOpen = (next: boolean) => {
        setContext((ctx) => {
            ctx.dataVerificationDropDownList = next;
            if (next) {
                // Hint box overlaps the dropdown — hide it while the menu is open
                const hintBox = document.getElementById('luckysheet-dataVerification-showHintBox');
                if (hintBox) hintBox.style.display = 'none';
            }
        });
    };

    const onSelect = (value: string) => {
        if (!cellInfo) return;
        const next = cellInfo.isMul
            ? cellInfo.selected.includes(value)
                ? cellInfo.selected.filter((v) => v !== value)
                : [...cellInfo.selected, value]
            : [value];
        setContext((ctx) => {
            setDropcownValue(ctx, value, next);
        });
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <div
                    id="luckysheet-dataVerification-dropdown-btn"
                    className="luckysheet-mousedown-cancel"
                    style={{ display: 'none' }}
                    tabIndex={0}
                >
                    <ChevronDown width={16} height={16} aria-hidden="true" />
                </div>
            </DropdownMenuTrigger>
            {/* Radix portals out of cellArea's DOM, but React synthetic events still bubble up
                the React tree across portals — without this class, cellAreaMouseDown's DOM-level
                closest() guard at SheetOverlay/index.tsx misses the menu items and selection
                jumps to the cell underneath the popup. */}
            <DropdownMenuContent align="start" className="luckysheet-mousedown-cancel text-xs">
                {cellInfo?.list.map((v, i) => {
                    const vStr = String(v);
                    if (cellInfo.isMul) {
                        return (
                            <DropdownMenuCheckboxItem
                                // biome-ignore lint/suspicious/noArrayIndexKey: dropdown values can repeat, position is the stable identity
                                key={i}
                                checked={cellInfo.selected.includes(vStr)}
                                onCheckedChange={() => onSelect(vStr)}
                                onSelect={(e) => e.preventDefault()}
                            >
                                {vStr}
                            </DropdownMenuCheckboxItem>
                        );
                    }
                    return (
                        <DropdownMenuItem
                            // biome-ignore lint/suspicious/noArrayIndexKey: dropdown values can repeat, position is the stable identity
                            key={i}
                            onSelect={() => onSelect(vStr)}
                        >
                            {vStr}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
