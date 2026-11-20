// A square swatch of the current color that opens a ColorPicker in a popover, for a dialog that picks one color, such
// as a label's, where a smaller one sits inside the name field. It owns its open state and closes after a pick, so a
// caller wires only `value` and `onChange`. A toolbar uses ColorPickerButton instead.

import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import { ColorPicker } from './color-picker';

type ColorPickerSwatchProps = {
    value: string;
    onChange: (color: string) => void;
    className?: string;
};

export function ColorPickerSwatch({ value, onChange, className }: ColorPickerSwatchProps) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="Color"
                    className={cn('size-9 shrink-0 rounded-md border border-input', className)}
                    style={{ backgroundColor: value }}
                />
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3" align="start">
                <ColorPicker
                    value={value}
                    onChange={(color) => {
                        onChange(color);
                        setOpen(false);
                    }}
                    showReset={false}
                />
            </PopoverContent>
        </Popover>
    );
}

export type { ColorPickerSwatchProps };
