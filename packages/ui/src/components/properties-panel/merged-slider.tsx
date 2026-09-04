import { Slider } from '@workspace/ui/components/slider';
import { cn } from '@workspace/ui/lib/utils';
import { useRef } from 'react';
import { MergedNumberInput } from './merged-number-input';
import { isMixed, type MergedValue } from './merged-value';

type MergedSliderProps = {
    value: MergedValue<number>;
    // The write itself — plain and unsealed; the gesture around it decides the undo step.
    onChange: (v: number) => void;
    // Opens one undo step and returns its release. A drag opens on its first change and releases on
    // commit, so however long the user takes, ⌘Z reverts the whole drag. See docs/CANVAS.md § sealing.
    beginGesture: () => () => void;
    min: number;
    max: number;
    step?: number;
    'aria-label': string;
};

// A slider and the merged number input over one value, sized for a single PropertyRow. The slider is
// the continuous edit (drag, or Arrow / Shift+Arrow for step / step×10); the input stays editable for
// an exact number. A mixed selection parks the thumb at min and drops the filled range — the input's
// '—' carries the meaning — and the first edit collapses the selection to one value, as typing does.
export function MergedSlider({ value, onChange, beginGesture, min, max, step = 1, ...props }: MergedSliderProps) {
    const mixed = isMixed(value);
    const release = useRef<(() => void) | null>(null);
    // Radix commits on pointer-up only when the value actually changed, and per keypress for the arrows;
    // the pointer-up below is the safety net that closes a gesture which ended where it started.
    const endGesture = () => {
        release.current?.();
        release.current = null;
    };

    return (
        <div className="flex items-center gap-2 h-7">
            <Slider
                value={[mixed || value === undefined ? min : value]}
                min={min}
                max={max}
                step={step}
                data-mixed={mixed ? '' : undefined}
                className={cn('flex-1', mixed && '[&_[data-slot=slider-range]]:opacity-0')}
                onValueChange={([v]) => {
                    release.current ??= beginGesture();
                    onChange(v);
                }}
                onValueCommit={endGesture}
                onPointerUp={endGesture}
                onBlur={endGesture}
                {...props}
            />
            {/* Wide enough for "100" at the panel's 14px input text, with px-2 rather than the
                default px-3 so the slider keeps most of the row. */}
            <div className="w-16 shrink-0">
                <MergedNumberInput
                    value={value}
                    onChange={(v) => {
                        const done = beginGesture();
                        onChange(v);
                        done();
                    }}
                    min={min}
                    max={max}
                    step={step}
                    className="px-2"
                />
            </div>
        </div>
    );
}
