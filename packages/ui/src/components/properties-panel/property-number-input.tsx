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

// The panel's number field. It writes on EVERY change — a keystroke, a spinner click, an arrow-key
// step — so the edit is wrapped in one gesture from the first of them until the field is left or
// committed: typing "250" is one undo step, not the three ⌘Z would otherwise walk back through.
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

    return (
        <Input
            type="number"
            className={cn('h-7 text-xs', className)}
            value={draft ?? String(value ?? '')}
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
            onFocus={() => setDraft(String(value ?? ''))}
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
