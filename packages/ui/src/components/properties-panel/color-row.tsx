import { isTransparentColor, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { CHECKERBOARD_STYLE, cn } from '@workspace/ui/lib/utils';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { isMixed, type MergedValue } from './merged-value';
import { PropertyRow } from './properties-panel';

type ColorButtonProps = {
    value: MergedValue<string>;
    onChange: (color: string) => void;
    // Offer a None swatch, which writes the transparent token. Opt-in: a row whose paint is the only
    // thing keeping its element visible (an arrow's stroke) must not offer it.
    allowNone?: boolean;
    noneLabel?: string;
    // A color whose default follows a palette (a chart series'): value is the color it draws in, the trigger
    // says Automatic while it is the default, and an Automatic row puts a picked one back.
    automatic?: { active: boolean; onReset: () => void };
};

// The one color control every panel row uses: a select-shaped trigger (swatch + hex, or None / —)
// opening the shared picker, with the None swatch inside the same popover.
function ColorButton({ value, onChange, allowNone, noneLabel = 'None', automatic }: ColorButtonProps) {
    const [open, setOpen] = useState(false);
    const mixed = isMixed(value);
    // Unset and transparent are the same answer to "what paint?" — both read as the None swatch.
    const none = !mixed && (!value || isTransparentColor(value));
    const displayColor = mixed || none ? undefined : value;
    // The picker's reset row picks ''.
    const pick = (color: string) => {
        if (color === '' && automatic) automatic.onReset();
        else onChange(color);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex h-7 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs hover:bg-accent"
                >
                    <div
                        className="h-4 w-4 shrink-0 rounded-sm border border-border"
                        style={displayColor ? { backgroundColor: displayColor } : none ? CHECKERBOARD_STYLE : undefined}
                    />
                    <span className="truncate text-muted-foreground">
                        {mixed ? '—' : none ? noneLabel : automatic?.active ? 'Automatic' : value}
                    </span>
                </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-auto">
                <div className="flex flex-col gap-2">
                    {allowNone && (
                        <button
                            type="button"
                            className={cn(
                                'flex items-center gap-2 px-2 py-1.5 -mx-1 rounded-md text-sm hover:bg-accent transition-colors',
                                none && 'bg-accent',
                            )}
                            onClick={() => pick(TRANSPARENT_COLOR)}
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <Ban className="h-4 w-4" />
                            <span>{noneLabel}</span>
                        </button>
                    )}
                    {/* Reset only to an automatic color: elsewhere a picked color is replaced by picking
                        another, and where paint is optional the None swatch is the way back. An automatic
                        color marks no swatch, so a click on the palette color it draws in is a visible pick. */}
                    <ColorPicker
                        value={automatic?.active ? '' : (displayColor ?? '')}
                        onChange={pick}
                        showReset={automatic !== undefined && !automatic.active}
                        resetLabel="Automatic"
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}

type ColorRowProps = ColorButtonProps & { label: string };

export function ColorRow({ label, ...button }: ColorRowProps) {
    return (
        <PropertyRow label={label}>
            <ColorButton {...button} />
        </PropertyRow>
    );
}
