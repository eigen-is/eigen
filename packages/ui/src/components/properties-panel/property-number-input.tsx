import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type PropertyNumberInputProps = {
    value: number | undefined;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
};

export function PropertyNumberInput({ value, onChange, min, max, step, placeholder }: PropertyNumberInputProps) {
    const [localValue, setLocalValue] = useState(() => String(value ?? ''));
    const [focused, setFocused] = useState(false);

    const externalStr = String(value ?? '');
    if (!focused && localValue !== externalStr) {
        setLocalValue(externalStr);
    }

    return (
        <Input
            type="number"
            className="h-7 text-xs"
            value={focused ? localValue : externalStr}
            placeholder={placeholder}
            onChange={(e) => {
                const raw = e.target.value;
                setLocalValue(raw);
                if (raw !== '' && raw !== '-') {
                    const v = Number(raw);
                    if (!Number.isNaN(v)) onChange(v);
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
        />
    );
}
