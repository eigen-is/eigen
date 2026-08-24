import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { isMixed, type MergedValue } from './merged-value';

type MergedSelectProps<T extends string> = {
    value: MergedValue<T>;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
};

export function MergedSelect<T extends string>({ value, onChange, options }: MergedSelectProps<T>) {
    const mixed = isMixed(value);
    // Always-controlled: '' (never undefined) for mixed — Radix renders the placeholder for '',
    // while flipping to undefined would switch the Select controlled→uncontrolled (React warning).
    const controlled = mixed || value === undefined ? '' : value;
    return (
        // onValueChange is the library seam: Radix types it (value: string) => void, so the cast back
        // to the option union lives here and nowhere else.
        <Select value={controlled} onValueChange={(v) => onChange(v as T)}>
            <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder={mixed ? '—' : undefined} />
            </SelectTrigger>
            <SelectContent>
                {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                        {o.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
