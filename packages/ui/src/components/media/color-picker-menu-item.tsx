// A menu row that opens the shared color grid as a submenu, the menu's counterpart of the toolbar's color button,
// in menus such as a doc's Format menu. Each swatch is a real menu item rather than a button, so hover-open, pointer
// travel into the grid, keyboard roving and the mobile drill-in work as in any other submenu. The swatches copy
// ColorPicker's look, so the two change together.

import { readableTextColor } from '@workspace/lib/constants/colors';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Check, RotateCcw } from 'lucide-react';
import { DEFAULT_COLORS } from './color-picker';

type ColorPickerMenuItemProps = {
    label: string;
    value: string;
    onChange: (color: string) => void;
    // Leads the row in a menu whose items carry icons.
    icon?: LucideIcon;
    resetLabel?: string;
    showReset?: boolean;
    // For a menu that sets several things in one go; any other menu closes on a pick.
    keepMenuOpen?: boolean;
    contentClassName?: string;
};

export function ColorPickerMenuItem({
    label,
    value,
    onChange,
    icon: Icon,
    resetLabel,
    showReset = true,
    keepMenuOpen,
    contentClassName,
}: ColorPickerMenuItemProps) {
    const normalizedValue = value.toLowerCase();
    const keepOpen = keepMenuOpen ? (e: Event) => e.preventDefault() : undefined;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                {Icon && <Icon className="size-4" />}
                <span>{label}</span>
                <span className="ml-auto h-3 w-6 rounded border" style={{ backgroundColor: value || 'transparent' }} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={cn('flex flex-col gap-2 p-3', contentClassName)}>
                {showReset && (
                    <DropdownMenuItem className="-mx-1" onSelect={keepOpen} onClick={() => onChange('')}>
                        <RotateCcw className="size-4" />
                        <span>{resetLabel}</span>
                    </DropdownMenuItem>
                )}
                {DEFAULT_COLORS.map((row, rowIdx) => (
                    <div
                        key={rowIdx}
                        className="grid gap-1"
                        style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}
                    >
                        {row.map((color) => {
                            const selected = normalizedValue === color.value.toLowerCase();
                            return (
                                <DropdownMenuItem
                                    key={color.value}
                                    title={color.label}
                                    onSelect={keepOpen}
                                    onClick={() => onChange(color.value)}
                                    className={cn(
                                        'h-4 w-4 justify-center rounded-full border border-border/50 p-0 transition-transform focus:scale-125',
                                        selected && 'ring-2 ring-ring ring-offset-1',
                                    )}
                                    style={{ backgroundColor: color.value }}
                                >
                                    {/* A menu item sizes a bare svg itself, so the check names its size. */}
                                    {selected && (
                                        <Check className="size-2" style={{ color: readableTextColor(color.value) }} />
                                    )}
                                </DropdownMenuItem>
                            );
                        })}
                    </div>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export type { ColorPickerMenuItemProps };
