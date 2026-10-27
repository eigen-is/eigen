// A new event starts at the next quarter hour, and an end time computed from a start wraps past midnight
// instead of running off the clock.
import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The helpers share a file with the picker, which loads Radix's popover: the later files get it as it loads here.
installHappyDom();

const { addMinutes, roundToNext15Minutes, timeToMinutes } = await import('../../components/time-select');

describe('roundToNext15Minutes', () => {
    test('a time between quarters moves up to the next one and drops its seconds', () => {
        expect(roundToNext15Minutes(new Date(2026, 9, 27, 14, 7, 42))).toEqual(new Date(2026, 9, 27, 14, 15));
    });

    test('a time on a quarter stays there', () => {
        expect(roundToNext15Minutes(new Date(2026, 9, 27, 14, 30, 5))).toEqual(new Date(2026, 9, 27, 14, 30));
    });

    test('a time just before midnight rounds into the next day', () => {
        expect(roundToNext15Minutes(new Date(2026, 9, 27, 23, 53))).toEqual(new Date(2026, 9, 28, 0, 0));
    });
});

describe('addMinutes', () => {
    test('adds within the day', () => {
        expect(addMinutes('09:00', 30)).toBe('09:30');
    });

    test('wraps past midnight in either direction', () => {
        expect(addMinutes('23:45', 30)).toBe('00:15');
        expect(addMinutes('00:10', -30)).toBe('23:40');
    });
});

test('a time that is not hh:mm reads as no time', () => {
    expect(timeToMinutes('10:05')).toBe(605);
    expect(timeToMinutes('soon')).toBe(-1);
});
