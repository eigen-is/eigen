import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePropertyGesture } from './property-gesture';

type PropertyNumberInputProps = {
    value: number | undefined;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
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
}: PropertyNumberInputProps) {
    const [localValue, setLocalValue] = useState(() => String(value ?? ''));
    const [focused, setFocused] = useState(false);
    const beginGesture = usePropertyGesture();
    const release = useRef<(() => void) | null>(null);

    const endGesture = useCallback(() => {
        release.current?.();
        release.current = null;
    }, []);
    // A gesture the field never sees end: Escape mid-edit deselects and unmounts the section, and so
    // does a peer deleting the element. An unreleased hold would merge every later edit into one step.
    useEffect(() => endGesture, [endGesture]);

    const externalStr = String(value ?? '');
    if (!focused && localValue !== externalStr) {
        setLocalValue(externalStr);
    }

    return (
        <Input
            type="number"
            className={cn('h-7 text-xs', className)}
            value={focused ? localValue : externalStr}
            placeholder={placeholder}
            onChange={(e) => {
                const raw = e.target.value;
                setLocalValue(raw);
                if (raw !== '' && raw !== '-') {
                    const v = Number(raw);
                    // Clamped BEFORE it is written: the input's own min/max only drive the spinner and
                    // validity styling, so typing 0 into a width would otherwise reach the document. An
                    // absent bound is no bound; a row wanting out-of-range entry (Angle) passes neither.
                    const lo = min ?? Number.NEGATIVE_INFINITY;
                    const hi = max ?? Number.POSITIVE_INFINITY;
                    if (!Number.isNaN(v)) {
                        release.current ??= beginGesture();
                        onChange(Math.min(hi, Math.max(lo, v)));
                    }
                }
            }}
            // Enter and Escape end the edit where the caret stays in the field, so the next one is a
            // step of its own; every other way out is a blur.
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') endGesture();
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
                endGesture();
                setFocused(false);
                if (localValue === '' || localValue === '-') {
                    setLocalValue(externalStr);
                }
            }}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
        />
    );
}
