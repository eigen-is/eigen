import {useMemo} from 'react';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {RRule, Frequency} from 'rrule';

type RecurrencePickerProps = {
    value: string | null;
    onChange: (rrule: string | null) => void;
    startDate: Date;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function getWeekdayIndex(date: Date): number {
    const day = date.getDay();
    return day === 0 ? 6 : day - 1;
}

function getWeekOfMonth(date: Date): number {
    return Math.ceil(date.getDate() / 7);
}

function getOrdinal(n: number): string {
    if (n === 1) return 'first';
    if (n === 2) return 'second';
    if (n === 3) return 'third';
    if (n === 4) return 'fourth';
    return 'last';
}

export function RecurrencePicker({value, onChange, startDate}: RecurrencePickerProps) {
    const weekdayIdx = getWeekdayIndex(startDate);
    const weekOfMonth = getWeekOfMonth(startDate);
    const dayName = DAY_NAMES[weekdayIdx];
    const monthName = startDate.toLocaleString('en', {month: 'long'});
    const dayOfMonth = startDate.getDate();

    const presets = useMemo(() => {
        const byDay = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU][weekdayIdx];

        return [
            {
                label: 'Does not repeat',
                value: 'none',
            },
            {
                label: 'Daily',
                value: new RRule({freq: Frequency.DAILY}).toString(),
            },
            {
                label: `Weekly on ${dayName}`,
                value: new RRule({freq: Frequency.WEEKLY, byweekday: [byDay]}).toString(),
            },
            {
                label: `Monthly on the ${getOrdinal(weekOfMonth)} ${dayName}`,
                value: new RRule({freq: Frequency.MONTHLY, byweekday: [byDay.nth(weekOfMonth)]}).toString(),
            },
            {
                label: `Annually on ${monthName} ${dayOfMonth}`,
                value: new RRule({freq: Frequency.YEARLY, bymonth: [startDate.getMonth() + 1], bymonthday: [dayOfMonth]}).toString(),
            },
            {
                label: 'Every weekday (Monday to Friday)',
                value: new RRule({freq: Frequency.WEEKLY, byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR]}).toString(),
            },
        ];
    }, [weekdayIdx, weekOfMonth, dayName, monthName, dayOfMonth, startDate]);

    const currentValue = value || 'none';

    const rruleText = useMemo(() => {
        if (!value) return null;
        try {
            const rule = RRule.fromString(value);
            return rule.toText();
        } catch {
            return value;
        }
    }, [value]);

    const matchedPreset = presets.find(p => p.value === currentValue);
    const selectValue = matchedPreset ? currentValue : 'custom';

    return (
        <div className="flex items-center gap-3">
            <Select
                value={selectValue}
                onValueChange={(v) => {
                    if (v === 'none') {
                        onChange(null);
                    } else {
                        onChange(v);
                    }
                }}
            >
                <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Does not repeat">
                        {matchedPreset ? matchedPreset.label : (rruleText ? `Custom: ${rruleText}` : 'Does not repeat')}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {presets.map((preset) => (
                        <SelectItem key={preset.value} value={preset.value}>
                            {preset.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

export function rruleToText(rrule: string | null): string | null {
    if (!rrule) return null;
    try {
        const rule = RRule.fromString(rrule);
        return rule.toText();
    } catch {
        return rrule;
    }
}
