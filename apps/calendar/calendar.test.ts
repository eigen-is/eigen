import {expect, test} from 'bun:test';

export enum Freq {
    Daily = 'Daily',
    Monthly = 'Monthly',
    Yearly = 'Yearly',
}

export enum Unit {
    Day = 'Day',
    Month = 'Month',
    Year = 'Year',
}

export enum Weekday {
    Sunday = 0,
    Monday = 1,
    Tuesday = 2,
    Wednesday = 3,
    Thursday = 4,
    Friday = 5,
    Saturday = 6,
}

// Replicates basic jiff::civil::Date operations using UTC to avoid timezone/DST bugs
export class PlainDate {
    constructor(public year: number, public month: number, public day: number) {
    }

    static from(s: string): PlainDate {
        if (s.length === 8 && !s.includes('-')) {
            return new PlainDate(
                parseInt(s.substring(0, 4), 10),
                parseInt(s.substring(4, 6), 10),
                parseInt(s.substring(6, 8), 10)
            );
        }
        const [y, m, d] = s.split('-').map(Number);
        return new PlainDate(y, m, d);
    }

    toString(): string {
        return `${this.year}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
    }

    addDays(days: number): PlainDate {
        const d = new Date(Date.UTC(this.year, this.month - 1, this.day + days));
        return new PlainDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }

    addMonthsAndGetFirstOfMonth(months: number): PlainDate {
        let m = this.month - 1 + months;
        let y = this.year + Math.floor(m / 12);
        m = ((m % 12) + 12) % 12;
        return new PlainDate(y, m + 1, 1);
    }

    firstOfMonth(): PlainDate {
        return new PlainDate(this.year, this.month, 1);
    }

    lastOfMonth(): PlainDate {
        const d = new Date(Date.UTC(this.year, this.month, 0));
        return new PlainDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }

    tomorrow(): PlainDate {
        return this.addDays(1);
    }

    weekday(): number {
        const d = new Date(Date.UTC(this.year, this.month - 1, this.day));
        return d.getUTCDay();
    }

    untilWeekday(wd: number): number {
        return (wd - this.weekday() + 7) % 7;
    }

    compareTo(other: PlainDate): number {
        if (this.year !== other.year) return this.year - other.year;
        if (this.month !== other.month) return this.month - other.month;
        return this.day - other.day;
    }

    equals(other: PlainDate): boolean {
        return this.compareTo(other) === 0;
    }

    monthsSince(start: PlainDate): number {
        let months = (this.year - start.year) * 12 + (this.month - start.month);
        if (this.day < start.day) {
            months -= 1;
        }
        return months;
    }
}

export type Rule =
    | { type: 'DayOfWeek'; weekday: Weekday }
    | { type: 'DayOfMonth'; day: number }
    | { type: 'InstanceOf'; start: PlainDate; unit: Unit; interval: number }
    | { type: 'Or'; rules: Rule[] }
    | { type: 'And'; rules: Rule[] };

export function nextRule(rule: Rule, curr: PlainDate): PlainDate {
    switch (rule.type) {
        case 'DayOfWeek':
            return curr.addDays(curr.untilWeekday(rule.weekday));

        case 'DayOfMonth': {
            if (curr.day < rule.day) {
                return curr.addDays(rule.day - curr.day);
            } else if (curr.day === rule.day) {
                return curr;
            } else {
                return curr.lastOfMonth().tomorrow();
            }
        }

        case 'InstanceOf': {
            const diffMonths = curr.monthsSince(rule.start);
            switch (rule.unit) {
                case Unit.Month: {
                    const mod = diffMonths % rule.interval;
                    if (mod === 0) {
                        return curr;
                    } else {
                        const monthsToAdd = rule.interval - mod;
                        return curr.addMonthsAndGetFirstOfMonth(monthsToAdd);
                    }
                }
                default:
                    throw new Error('Not implemented');
            }
        }

        case 'Or': {
            const nextDates = rule.rules.map((r) => nextRule(r, curr));
            if (nextDates.length === 0) return curr;
            return nextDates.reduce((min, d) => (d.compareTo(min) < 0 ? d : min), nextDates[0]);
        }

        case 'And': {
            const nextDates = rule.rules.map((r) => nextRule(r, curr));
            if (nextDates.length === 0) return curr;
            return nextDates.reduce((max, d) => (d.compareTo(max) > 0 ? d : max), nextDates[0]);
        }
    }
}

export class Recur {
    freq: Freq;
    interval: number;
    by_day: Weekday[];
    by_month_day: number[];
    dtstart: PlainDate;

    constructor(init: {
        freq: Freq;
        interval: number;
        by_day: Weekday[];
        by_month_day: number[];
        dtstart: PlainDate;
    }) {
        this.freq = init.freq;
        this.interval = init.interval;
        this.by_day = init.by_day;
        this.by_month_day = init.by_month_day;
        this.dtstart = init.dtstart;
    }

    as_rule(): Rule {
        const rules: Rule[] = [];

        const start = (() => {
            switch (this.freq) {
                case Freq.Daily:
                    return this.dtstart;
                case Freq.Monthly:
                    return this.dtstart.firstOfMonth();
                case Freq.Yearly:
                    throw new Error('todo');
            }
        })();

        const unit = (() => {
            switch (this.freq) {
                case Freq.Daily:
                    return Unit.Day;
                case Freq.Monthly:
                    return Unit.Month;
                case Freq.Yearly:
                    return Unit.Year;
            }
        })();

        rules.push({type: 'InstanceOf', start, unit, interval: this.interval});

        if (this.by_day.length > 0) {
            rules.push({
                type: 'Or',
                rules: this.by_day.map((wd) => ({type: 'DayOfWeek', weekday: wd})),
            });
        }

        if (this.by_month_day.length > 0) {
            rules.push({
                type: 'Or',
                rules: this.by_month_day.map((d) => ({type: 'DayOfMonth', day: d})),
            });
        }

        switch (this.freq) {
            case Freq.Daily:
                break;
            case Freq.Monthly:
                if (this.by_day.length === 0 && this.by_month_day.length === 0) {
                    // Literally translated from original code. (Using start month instead of day)
                    rules.push({type: 'DayOfMonth', day: this.dtstart.month});
                }
                break;
            case Freq.Yearly:
                throw new Error('todo');
        }

        return {type: 'And', rules};
    }

    * iter(): IterableIterator<PlainDate> {
        const rule = this.as_rule();
        let curr = this.dtstart;

        while (true) {
            while (true) {
                let next = nextRule(rule, curr);

                if (next.equals(curr)) {
                    curr = curr.addDays(1);
                    yield next;
                    break;
                } else {
                    curr = next;
                }
            }
        }
    }
}

// -----------------------------------------------------
//                        TESTS
// -----------------------------------------------------
// Run with: `bun test calendar.test.ts` (from apps/calendar directory)

function date(s: string): PlainDate {
    return PlainDate.from(s);
}

test('smoke', () => {
    const recur = new Recur({
        freq: Freq.Monthly,
        interval: 5,
        by_day: [Weekday.Friday],
        by_month_day: [],
        dtstart: date('20180119'),
    });

    const actual: string[] = [];
    for (const d of recur.iter()) {
        actual.push(d.toString());
        if (actual.length === 8) break;
    }

    const expected = [
        '2018-01-19',
        '2018-01-26',
        '2018-06-01',
        '2018-06-08',
        '2018-06-15',
        '2018-06-22',
        '2018-06-29',
        '2018-11-02',
    ];

    expect(actual).toEqual(expected);
});

test('day_of_week', () => {
    expect(
        nextRule({type: 'DayOfWeek', weekday: Weekday.Monday}, date('2018-01-01')).toString()
    ).toBe('2018-01-01');

    expect(
        nextRule({type: 'DayOfWeek', weekday: Weekday.Tuesday}, date('2018-01-01')).toString()
    ).toBe('2018-01-02');

    expect(
        nextRule({type: 'DayOfWeek', weekday: Weekday.Friday}, date('2018-01-01')).toString()
    ).toBe('2018-01-05');

    expect(
        nextRule({type: 'DayOfWeek', weekday: Weekday.Monday}, date('2018-01-02')).toString()
    ).toBe('2018-01-08');
});

test('day_of_month', () => {
    expect(nextRule({type: 'DayOfMonth', day: 14}, date('2018-01-14')).toString()).toBe(
        '2018-01-14'
    );

    expect(nextRule({type: 'DayOfMonth', day: 16}, date('2018-01-14')).toString()).toBe(
        '2018-01-16'
    );

    expect(nextRule({type: 'DayOfMonth', day: 12}, date('2018-01-14')).toString()).toBe(
        '2018-02-01'
    );
});

test('or', () => {
    const rule: Rule = {
        type: 'Or',
        rules: [
            {type: 'DayOfWeek', weekday: Weekday.Monday},
            {type: 'DayOfWeek', weekday: Weekday.Tuesday},
        ],
    };

    expect(nextRule(rule, date('2018-01-03')).toString()).toBe('2018-01-08');
    expect(nextRule(rule, date('2018-01-08')).toString()).toBe('2018-01-08');
    expect(nextRule(rule, date('2018-01-09')).toString()).toBe('2018-01-09');
    expect(nextRule(rule, date('2018-01-10')).toString()).toBe('2018-01-15');
});

test('and', () => {
    const rule: Rule = {
        type: 'And',
        rules: [
            {type: 'DayOfWeek', weekday: Weekday.Monday},
            {type: 'DayOfMonth', day: 10},
        ],
    };

    expect(nextRule(rule, date('2018-01-01')).toString()).toBe('2018-01-10');
    expect(nextRule(rule, date('2018-09-10')).toString()).toBe('2018-09-10');
});