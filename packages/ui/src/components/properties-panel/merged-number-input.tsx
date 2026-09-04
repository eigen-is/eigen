import { isMixed, type MergedValue } from './merged-value';
import { PropertyNumberInput } from './property-number-input';

type MergedNumberInputProps = {
    value: MergedValue<number>;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    className?: string;
};

export function MergedNumberInput({ value, onChange, min, max, step, disabled, className }: MergedNumberInputProps) {
    const mixed = isMixed(value);
    return (
        <PropertyNumberInput
            value={mixed ? undefined : value}
            onChange={onChange}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            className={className}
            placeholder={mixed ? '—' : undefined}
        />
    );
}
