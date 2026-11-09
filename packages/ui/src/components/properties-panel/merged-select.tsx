// The properties panel's select, such as a chart's type or a table of contents' levels. It shows a merged value: the
// option all selected objects share, or a '—' placeholder when they disagree. A numeric value goes through numToStr
// first, as a select holds strings.

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import type { MergedValue } from './merged-value';
import { isMixed } from './merged-value';

type MergedSelectProps<T extends string> = {
    value: MergedValue<T>;
    onChange: (v: T) => void;
    options: readonly { value: T; label: string }[];
};

export function MergedSelect<T extends string>({ value, onChange, options }: MergedSelectProps<T>) {
    const mixed = isMixed(value);
    // The select stays controlled. Radix shows the placeholder for '', and a switch to undefined would make React
    // warn that the select went from controlled to uncontrolled.
    const controlled = mixed || value === undefined ? '' : value;
    return (
        <Select
            value={controlled}
            onValueChange={(v) => {
                const option = options.find((o) => o.value === v);
                if (option) onChange(option.value);
            }}
        >
            <SelectTrigger size="xs" className="w-full">
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

// A stored number as the select's string; MIXED and undefined pass through. A value missing from the options keeps
// its string, so the select shows no option and nothing is overwritten. Its onChange turns it back with Number(v).
export const numToStr = (v: MergedValue<number>): MergedValue<string> =>
    isMixed(v) ? v : v === undefined ? undefined : String(v);
