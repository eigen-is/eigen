// A toolbar icon button that opens a ColorPicker in a popover, shared by formatting toolbars such as the
// docs and sheets ones. It owns its open state and closes after a pick, so a caller wires only `value` and
// `onChange`.

import { Button } from '@workspace/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { ColorPicker } from './color-picker';

type ColorPickerButtonProps = {
    icon: LucideIcon;
    tooltipText: string;
    value: string;
    onChange: (color: string) => void;
    resetLabel?: string;
    // Underline the icon with a swatch of the current color (text/fill pickers); omit
    // when the icon itself carries the color, e.g. the highlighter.
    showSwatch?: boolean;
    // Render the trigger in the active (secondary) variant, e.g. when a highlight is set.
    active?: boolean;
    // Extra class for the popover content — sheets pass `sheet-mousedown-cancel`.
    popoverClassName?: string;
    // An editor that takes the focus back on a pick passes its keep-focus handler, so Radix doesn't refocus the trigger.
    onCloseAutoFocus?: (event: Event) => void;
};

export function ColorPickerButton({
    icon: Icon,
    tooltipText,
    value,
    onChange,
    resetLabel,
    showSwatch = false,
    active = false,
    popoverClassName,
    onCloseAutoFocus,
}: ColorPickerButtonProps) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant={active ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-8 w-8"
                    aria-label={tooltipText}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    <Tooltip>
                        <TooltipTrigger asChild>
                            {showSwatch ? (
                                <div className="flex flex-col items-center">
                                    <Icon className="h-4 w-4" />
                                    <div
                                        className="h-0.5 w-4 rounded-full mt-px"
                                        style={{ backgroundColor: value || 'currentColor' }}
                                    />
                                </div>
                            ) : (
                                <Icon className="h-4 w-4" />
                            )}
                        </TooltipTrigger>
                        <TooltipContent>{tooltipText}</TooltipContent>
                    </Tooltip>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className={cn('w-auto p-3', popoverClassName)}
                align="start"
                onCloseAutoFocus={onCloseAutoFocus}
            >
                <ColorPicker
                    value={value}
                    resetLabel={resetLabel}
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

export type { ColorPickerButtonProps };
