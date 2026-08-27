import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getCellDataVerification, getCellValue, getDropdownList, getFlowdata, setDropdownValue } from '../../state';

export function DropDownList() {
    const { context, setContext } = useContext(WorkbookContext);
    const open = !!context.dataVerificationDropDownList;

    const cellInfo = useMemo(() => {
        if (!open) return null;
        const last = context.selections?.[context.selections.length - 1];
        if (!last) return null;
        const { row_focus: r, column_focus: c } = last;
        if (r == null || c == null) return null;
        const dv = getCellDataVerification(context, r, c);
        if (!dv) return null;
        const list = getDropdownList(context, dv.value1);
        const isMul = dv.type2 === 'true';
        const d = getFlowdata(context);
        const cellValue = d ? getCellValue(r, c, d) : null;
        const selected = cellValue != null && cellValue !== '' ? String(cellValue).split(',') : [];
        return { list, isMul, selected };
    }, [open, context]);

    // The validation hint card reads the same flag and stands down while the list
    // is open — it hangs over the same corner of the cell.
    const setOpen = (next: boolean) => {
        setContext((ctx) => {
            ctx.dataVerificationDropDownList = next;
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
            setDropdownValue(ctx, value, next);
        });
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            {/* Pure anchor, not an indicator: the chevron itself is canvas paint on
                every list-validated cell (state/render/cells.ts), and the canvas
                mousedown hit-test opens this menu. cellFocus still moves and shows
                this box so Radix has a rect to portal against. */}
            <DropdownMenuTrigger asChild>
                <div
                    id="luckysheet-dataVerification-dropdown-btn"
                    style={{ display: 'none' }}
                    tabIndex={-1}
                    aria-hidden="true"
                />
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
