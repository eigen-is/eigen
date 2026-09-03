import { isTransparentColor, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { isMixed, type MergedValue } from './merged-value';

type ColorRowProps = {
    label: string;
    value: MergedValue<string>;
    onChange: (color: string) => void;
    showReset?: boolean;
    // Offer a None swatch, which writes the transparent token. Opt-in: a row whose paint is the only
    // thing keeping its element visible (an arrow's stroke) must not offer it.
    allowNone?: boolean;
};

export function ColorRow({ label, value, onChange, showReset, allowNone }: ColorRowProps) {
    const [open, setOpen] = useState(false);
    const mixed = isMixed(value);
    // Unset and transparent are the same answer to "what paint?" — both read as the ∅ swatch.
    const none = !mixed && (!value || isTransparentColor(value));
    const displayColor = mixed || none ? undefined : value;

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
                        {(mixed || none) && (
                            <span className="text-xs text-muted-foreground flex items-center justify-center h-full">
                                {mixed ? '—' : '∅'}
                            </span>
                        )}
                    </div>
                    <span className="text-xs flex-1 text-left">{label}</span>
                    {displayColor && <span className="text-xs text-muted-foreground">{displayColor}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <div className="flex flex-col gap-2">
                    {allowNone && (
                        <button
                            type="button"
                            className="flex items-center gap-2 px-2 py-1.5 -mx-1 rounded-md text-sm hover:bg-accent transition-colors"
                            onClick={() => {
                                onChange(TRANSPARENT_COLOR);
                                setOpen(false);
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <Ban className="h-4 w-4" />
                            <span>None</span>
                        </button>
                    )}
                    <ColorPicker
                        value={mixed || none ? '#000000' : value}
                        onChange={(c) => {
                            onChange(c);
                            setOpen(false);
                        }}
                        showReset={showReset}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}
