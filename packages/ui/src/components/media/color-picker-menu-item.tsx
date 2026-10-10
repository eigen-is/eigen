import { isLightColor } from '@workspace/lib/constants';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { Check, type LucideIcon, RotateCcw } from 'lucide-react';
import { DEFAULT_COLORS } from './color-picker';

type ColorPickerMenuItemProps = {
    label: string;
    value: string;
    onChange: (color: string) => void;
    // Leads the row in a menu whose items carry icons (docs' Format › Text).
    icon?: LucideIcon;
    resetLabel?: string;
    showReset?: boolean;
    // CustomBorder composes color + style + border type in one open menu, like its
    // sibling style items; everything else closes on pick like a normal menu item.
    keepMenuOpen?: boolean;
    // Extra class for the submenu content — sheets pass `sheet-mousedown-cancel`.
    contentClassName?: string;
};

// A menu row that opens the shared color grid as a real submenu — the menu-item
// analogue of the toolbar's ColorPickerButton. Every swatch is a registered menu
// item (not a raw button), so hover-open, pointer travel into the grid, menu
// roving and the mobile drill-in all behave like every other submenu. Swatch
// markup mirrors ColorPicker (menu items can't come out of its button grid,
// and menu-item context needs size-* icons to dodge the [&_svg] default) —
// keep the two visually in sync.
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
                {Icon && <Icon className="h-4 w-4 mr-2" />}
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
                                    {selected && (
                                        <Check
                                            className="size-2"
                                            style={{ color: isLightColor(color.value) ? '#000' : '#fff' }}
                                        />
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
