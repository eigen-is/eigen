import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';

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
                    if (!Number.isNaN(v)) onChange(Math.min(hi, Math.max(lo, v)));
                }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
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
