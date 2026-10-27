// The number field of the properties panels, such as a shape's size in Slides or a chart axis bound.
// It writes on every change and folds one edit into one undo step. When it is not focused it shows the
// decimals its step implies, so a step of 0.01 shows 16 as 16.00, in the browser's own number format.

import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import { useHeldGesture } from './property-gesture';

type PropertyNumberInputProps = {
    value: number | undefined;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    // Makes an emptied field a value of its own (a chart axis's Auto); without it, empty writes nothing.
    onClear?: () => void;
};

// The field writes on every change, such as a keystroke, a spinner click or an arrow-key step. So the
// edit is one gesture from the first change until the field is left or committed: typing "250" is one
// undo step, not three.
export function PropertyNumberInput({
    value,
    onChange,
    min,
    max,
    step,
    placeholder,
    disabled,
    className,
    onClear,
}: PropertyNumberInputProps) {
    // While focused the field shows its own draft, so a half-typed "-" or a clamped value never jumps under the caret.
    const [draft, setDraft] = useState<string | null>(null);
    const { hold, end: endGesture, undoKey } = useHeldGesture();
    const shown = value === undefined ? '' : step === undefined ? String(value) : value.toFixed(stepDecimals(step));

    return (
        <Input
            type="number"
            className={cn('h-7 text-xs', className)}
            value={draft ?? shown}
            placeholder={placeholder}
            onChange={(e) => {
                const raw = e.target.value;
                setDraft(raw);
                if (raw === '' && onClear) {
                    hold();
                    onClear();
                } else if (raw !== '' && raw !== '-') {
                    const v = Number(raw);
                    // Clamped BEFORE it is written: the input's own min/max only drive the spinner and
                    // validity styling, so typing 0 into a width would otherwise reach the document. An
                    // absent bound is no bound; a row wanting out-of-range entry (Angle) passes neither.
                    const lo = min ?? Number.NEGATIVE_INFINITY;
                    const hi = max ?? Number.POSITIVE_INFINITY;
                    if (!Number.isNaN(v)) {
                        hold();
                        onChange(Math.min(hi, Math.max(lo, v)));
                    }
                }
            }}
            // Enter and Escape end the edit where the caret stays in the field, so the next one is a
            // step of its own; ⌘Z ends it too and shows what the undo left. Every other way out is a blur.
            onKeyDown={(e) => {
                if (undoKey(e)) setDraft(null);
                else if (e.key === 'Enter' || e.key === 'Escape') endGesture();
            }}
            onFocus={() => setDraft(shown)}
            onBlur={() => {
                endGesture();
                setDraft(null);
            }}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
        />
    );
}

// The digits after the decimal point of a step: two for 0.01, none for 1.
function stepDecimals(step: number): number {
    return String(step).split('.')[1]?.length ?? 0;
}
