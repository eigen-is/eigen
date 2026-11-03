// The list a drop-down validation rule offers, opened from the chevron the grid paints on the focus cell. Picking an
// item writes it into the cell, and a rule that allows several values toggles each one in a comma-separated list. The
// menu hangs off a hidden anchor the hit test moves to the cell, and the selection overlay mounts it.

import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';
import { getCellDataValidation, getCellValue, getDropdownList, getFlowdata, setDropdownValue } from '../../state';

export function DropdownList() {
    const { context, setContext } = useContext(WorkbookContext);
    const open = !!context.validationListOpen;

    const cellInfo = useMemo(() => {
        if (!open) return null;
        const last = context.selections?.[context.selections.length - 1];
        if (!last) return null;
        const { row_focus: row, column_focus: column } = last;
        if (row == null || column == null) return null;
        const rule = getCellDataValidation(context, row, column);
        if (!rule) return null;
        const list = getDropdownList(context, rule.value1);
        const allowsSeveral = rule.type2 === 'true';
        const flowdata = getFlowdata(context);
        const cellValue = flowdata ? getCellValue(row, column, flowdata) : null;
        const selected = cellValue != null && cellValue !== '' ? String(cellValue).split(',') : [];
        return { list, allowsSeveral, selected };
    }, [open, context]);

    // The validation hint card hangs over the same corner of the cell. It reads this flag and hides while the list is open.
    const setOpen = (next: boolean) => {
        setContext((ctx) => {
            ctx.validationListOpen = next;
        });
    };

    const onSelect = (value: string) => {
        if (!cellInfo) return;
        const next = cellInfo.allowsSeveral
            ? cellInfo.selected.includes(value)
                ? cellInfo.selected.filter((item) => item !== value)
                : [...cellInfo.selected, value]
            : [value];
        setContext((ctx) => {
            setDropdownValue(ctx, value, next);
        });
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            {/* This box is only an anchor. The grid paints the chevron on the canvas, and the mousedown hit test opens
                the menu. cellFocus moves this box to the focus cell, so Radix has a rect to place the menu against. */}
            <DropdownMenuTrigger asChild>
                <div id="sheet-validation-list-anchor" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
            </DropdownMenuTrigger>
            {/* Radix portals the menu out of the cell area, but React events still bubble up through the portal. The
                cell area's mousedown handler skips targets inside this class. Without it, a click on an item would
                also select the cell under the menu. */}
            <DropdownMenuContent align="start" className="sheet-mousedown-cancel text-xs">
                {cellInfo?.list.map((item, index) => {
                    const label = String(item);
                    if (cellInfo.allowsSeveral) {
                        return (
                            <DropdownMenuCheckboxItem
                                // biome-ignore lint/suspicious/noArrayIndexKey: dropdown values can repeat, position is the stable identity
                                key={index}
                                checked={cellInfo.selected.includes(label)}
                                onCheckedChange={() => onSelect(label)}
                                onSelect={(e) => e.preventDefault()}
                            >
                                {label}
                            </DropdownMenuCheckboxItem>
                        );
                    }
                    return (
                        <DropdownMenuItem
                            // biome-ignore lint/suspicious/noArrayIndexKey: dropdown values can repeat, position is the stable identity
                            key={index}
                            onSelect={() => onSelect(label)}
                        >
                            {label}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
