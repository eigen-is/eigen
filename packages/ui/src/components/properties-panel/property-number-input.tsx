// The number field of the properties panels, such as a shape's size in Slides or a chart axis bound.
// It writes on every change and folds one edit into one undo step. When it is not focused it shows at
// least its step's decimals and up to two of the value's own: 16 at a step of 0.01 is 16.00, a 2.67 px
// stroke at a step of 1 stays 2.67, and 3 stays 3. The browser shows it in its own number format.

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
    const shown = value === undefined ? '' : step === undefined ? String(value) : showNumber(value, step);

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

// The value's own decimals count up to this many, so a 2.6666… px stroke shows 2.67.
const MAX_OWN_DECIMALS = 2;

function showNumber(value: number, step: number): string {
    const decimals = Math.max(decimalsOf(step), decimalsOf(roundDecimal(value, MAX_OWN_DECIMALS)));
    return roundDecimal(value, decimals).toFixed(decimals);
}

// The digits after the decimal point: two for 0.01, none for 1.
function decimalsOf(n: number): number {
    return String(n).split('.')[1]?.length ?? 0;
}

// Rounds half away from zero on the decimal the number prints as, where toFixed rounds the binary value:
// it shows 1.15 to one decimal as 1.1. Shifting by exponent notation keeps 1.005 at 100.5, where
// 1.005 * 100 is 100.4999….
function roundDecimal(n: number, digits: number): number {
    const shifted = Number(`${Math.abs(n)}e${digits}`);
    // A number String writes in exponent notation itself, such as 1e-7, is past the shift: toFixed rounds it.
    if (!Number.isFinite(shifted)) return n;
    return Math.sign(n) * Number(`${Math.round(shifted)}e-${digits}`);
}
