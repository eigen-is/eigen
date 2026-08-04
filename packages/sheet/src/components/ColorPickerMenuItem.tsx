import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { useState } from 'react';

type Props = {
    label: string;
    value: string;
    onChange: (color: string) => void;
    resetLabel?: string;
    showReset?: boolean;
};

// A menu row that opens the shared ColorPicker in a popover — the menu-item analogue of
// the toolbar's ColorPickerButton. A popover, not a Radix submenu, because menu roving
// only visits registered items: raw swatch buttons inside a SubContent are keyboard-dead.
// The popover is its own focus scope, so the grid is reachable by keyboard and touch.
export function ColorPickerMenuItem({ label, value, onChange, resetLabel, showReset }: Props) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {/* preventDefault keeps the parent menu open so the popover can layer over it. */}
                <DropdownMenuItem className="justify-between gap-2" onSelect={(e) => e.preventDefault()}>
                    <span>{label}</span>
                    <span className="h-3 w-6 rounded border" style={{ backgroundColor: value || 'transparent' }} />
                </DropdownMenuItem>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" className="luckysheet-mousedown-cancel w-auto p-3">
                <ColorPicker
                    value={value}
                    resetLabel={resetLabel}
                    showReset={showReset}
                    preventFocusLoss
                    onChange={(color) => {
                        onChange(color);
                        setOpen(false);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}
