import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { useState } from 'react';
import { isMixed, type MergedValue } from './merged-value';

type ColorRowProps = {
    label: string;
    value: MergedValue<string>;
    onChange: (color: string) => void;
    showReset?: boolean;
};

export function ColorRow({ label, value, onChange, showReset }: ColorRowProps) {
    const [open, setOpen] = useState(false);
    const mixed = isMixed(value);
    const displayColor = mixed ? undefined : value || undefined;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full"
                >
                    <div
                        className="h-5 w-5 rounded border border-border shrink-0"
                        style={{ backgroundColor: displayColor }}
                    >
                        {mixed && (
                            <span className="text-xs text-muted-foreground flex items-center justify-center h-full">
                                —
                            </span>
                        )}
                        {!mixed && !value && (
                            <span className="text-xs text-muted-foreground flex items-center justify-center h-full">
                                ∅
                            </span>
                        )}
                    </div>
                    <span className="text-xs flex-1 text-left">{label}</span>
                    {!mixed && value && <span className="text-xs text-muted-foreground">{value}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <ColorPicker
                    value={mixed ? '#000000' : value || '#000000'}
                    onChange={(c) => {
                        onChange(c);
                        setOpen(false);
                    }}
                    showReset={showReset}
                />
            </PopoverContent>
        </Popover>
    );
}
