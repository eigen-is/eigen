import { isTransparentColor, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { isMixed, type MergedValue } from './merged-value';
import { PropertyRow } from './properties-panel';

// The transparent swatch: a checkerboard in the border token, so "no paint" reads as no paint rather than as white.
const CHECKER = {
    backgroundImage: 'repeating-conic-gradient(var(--border) 0 25%, transparent 0 50%)',
    backgroundSize: '8px 8px',
};

type ColorButtonProps = {
    value: MergedValue<string>;
    onChange: (color: string) => void;
    // The picker's Reset row, which writes '' — the caller maps that to its own default.
    showReset?: boolean;
    // Offer a None swatch, which writes the transparent token. Opt-in: a row whose paint is the only
    // thing keeping its element visible (an arrow's stroke) must not offer it.
    allowNone?: boolean;
    noneLabel?: string;
};

// The one colour control every panel row uses: a select-shaped trigger (swatch + hex, or None / —)
// opening the shared picker, with None and Reset inside the same popover.
function ColorButton({ value, onChange, showReset = true, allowNone, noneLabel = 'None' }: ColorButtonProps) {
    const [open, setOpen] = useState(false);
    const mixed = isMixed(value);
    // Unset and transparent are the same answer to "what paint?" — both read as the None swatch.
    const none = !mixed && (!value || isTransparentColor(value));
    const displayColor = mixed || none ? undefined : value;
    const pick = (color: string) => {
        onChange(color);
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
                        style={displayColor ? { backgroundColor: displayColor } : none ? CHECKER : undefined}
                    />
                    <span className="truncate text-muted-foreground">{mixed ? '—' : none ? noneLabel : value}</span>
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
                    <ColorPicker value={displayColor ?? ''} onChange={pick} showReset={showReset} />
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
