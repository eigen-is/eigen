import { describe, expect, test } from 'bun:test';
import {
    dateOf,
    dateSerial,
    daysInMonth,
    FIRST_SERIAL,
    isoWeek,
    LAST_SERIAL,
    serialDate,
    shiftMonths,
    timeOf,
    weekdayFromMonday,
    weekdayNumber,
    weekNumber,
} from '../../values/dates';
import { NUM } from '../../values/errors';

const civil = (serial: number) => {
    const date = serialDate(serial);
    return [date.year, date.month, date.day];
};

describe('dateSerial', () => {
    test("Excel's answers around its leap day of 1900", () => {
        expect(dateSerial(1900, 1, 1)).toBe(1);
        expect(dateSerial(1900, 2, 28)).toBe(59);
        expect(dateSerial(1900, 2, 29)).toBe(60);
        expect(dateSerial(1900, 3, 1)).toBe(61);
        expect(dateSerial(1900, 1, 0)).toBe(FIRST_SERIAL);
        expect(dateSerial(1900, 3, 0)).toBe(60);
        expect(dateSerial(1901, 1, 1)).toBe(367);
    });

    test("the oracle's dates", () => {
        expect(dateSerial(2020, 1, 31)).toBe(43861);
        expect(dateSerial(2024, 2, 29)).toBe(45351);
        expect(dateSerial(2023, 2, 28)).toBe(44985);
        expect(dateSerial(2026, 1, 5)).toBe(46027);
        expect(dateSerial(1930, 1, 1)).toBe(10959);
        expect(dateSerial(9999, 12, 31)).toBe(LAST_SERIAL);
        expect(LAST_SERIAL).toBe(2958465);
    });

    test('months and days roll over and under as DATE does', () => {
        expect(dateSerial(2020, 13, 1)).toBe(dateSerial(2021, 1, 1));
        expect(dateSerial(2020, 1, 0)).toBe(43830);
        expect(dateSerial(2020, 0, 1)).toBe(dateSerial(2019, 12, 1));
        expect(dateSerial(2020, -12, 1)).toBe(dateSerial(2018, 12, 1));
        expect(dateSerial(2020, 25, 1)).toBe(dateSerial(2022, 1, 1));
        expect(dateSerial(2020, 1, 366)).toBe(dateSerial(2020, 12, 31));
        expect(dateSerial(2021, 3, -1)).toBe(dateSerial(2021, 2, 27));
        expect(dateSerial(2024, 2, 30)).toBe(dateSerial(2024, 3, 1));
    });

    test('a date Excel does not have is outside the first and the last serial', () => {
        expect(dateSerial(1899, 12, 30)).toBeLessThan(FIRST_SERIAL);
        expect(dateSerial(1900, 0, 1)).toBeLessThan(FIRST_SERIAL);
        expect(dateSerial(10000, 1, 1)).toBe(LAST_SERIAL + 1);
    });
});

describe('serialDate', () => {
    test("Excel's answers", () => {
        expect(civil(0)).toEqual([1900, 1, 0]);
        expect(civil(1)).toEqual([1900, 1, 1]);
        expect(civil(32)).toEqual([1900, 2, 1]);
        expect(civil(59)).toEqual([1900, 2, 28]);
        expect(civil(60)).toEqual([1900, 2, 29]);
        expect(civil(61)).toEqual([1900, 3, 1]);
        expect(civil(366)).toEqual([1900, 12, 31]);
        expect(civil(367)).toEqual([1901, 1, 1]);
        expect(civil(45351)).toEqual([2024, 2, 29]);
        expect(civil(73050)).toEqual([2099, 12, 31]);
        expect(civil(73051)).toEqual([2100, 1, 1]);
        expect(civil(LAST_SERIAL)).toEqual([9999, 12, 31]);
    });

    test('every day agrees with a count that walks the calendar', () => {
        let year = 1900;
        let month = 1;
        let day = 1;
        let wrong = 0;
        for (let serial = 1; serial <= LAST_SERIAL; serial++) {
            const date = serialDate(serial);
            if (date.year !== year || date.month !== month || date.day !== day) wrong++;
            if (dateSerial(year, month, day) !== serial) wrong++;
            day++;
            if (day > (year === 1900 && month === 2 ? 29 : daysInMonth(year, month))) {
                day = 1;
                month++;
            }
            if (month > 12) {
                month = 1;
                year++;
            }
        }
        expect(wrong).toBe(0);
        expect([year, month, day]).toEqual([10000, 1, 1]);
    });
});

test('the days of a month are those of the real calendar, 28 in February 1900', () => {
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
});

describe('dateOf and timeOf', () => {
    test('a year under 1900 counts from 1900 and every part is cut down', () => {
        expect(dateOf(0, 1, 1)).toBe(1);
        expect(dateOf(1899, 12, 31)).toBe(693962);
        expect(dateOf(2024.9, -0.5, 15.9)).toBe(45245);
        expect(dateOf(1900, 1, 0)).toBe(0);
    });

    test('a date Excel does not have, a negative year and a month from 32767 on are #NUM!', () => {
        expect(dateOf(1900, 0, 1)).toBe(NUM);
        expect(dateOf(9999, 12, 32)).toBe(NUM);
        expect(dateOf(-1, 1, 1)).toBe(NUM);
        expect(dateOf(2024, 32767, 1)).toBe(NUM);
        expect(dateOf(2024, 2, 32768)).toBe(78089);
    });

    test('the time is what the whole days leave, to the bit Excel leaves', () => {
        expect(timeOf(12, 0, 0)).toBe(0.5);
        expect(timeOf(24, 0, 0)).toBe(0);
        expect(timeOf(32767, 0, 0)).toBe(0.29166666666674246);
        expect(timeOf(1, -60, 0)).toBe(0);
        expect(timeOf(0, 0, -0.4)).toBe(NUM);
        expect(timeOf(0, 32768, 0)).toBe(NUM);
    });
});

describe('shiftMonths', () => {
    test('the same day, or the last when the month is shorter', () => {
        expect(shiftMonths(45322, 1, false)).toBe(45351);
        expect(shiftMonths(45351, 12, false)).toBe(45716);
        expect(shiftMonths(45000, -1236, false)).toBe(7380);
        expect(shiftMonths(45000, 0, true)).toBe(45016);
    });

    test('February 1900 ends on its 28th, and serial 60 is still a 29th', () => {
        expect(shiftMonths(31, 1, false)).toBe(59);
        expect(shiftMonths(60, 0, false)).toBe(59);
        expect(shiftMonths(60, 1, false)).toBe(89);
        expect(shiftMonths(60, 0, true)).toBe(59);
    });

    test('a month Excel does not have is #NUM!', () => {
        expect(shiftMonths(31, -1, false)).toBe(NUM);
        expect(shiftMonths(31, -1, true)).toBe(NUM);
        expect(shiftMonths(0, 0, false)).toBe(0);
        expect(shiftMonths(LAST_SERIAL, 1, false)).toBe(NUM);
        expect(shiftMonths(45322, 1e300, false)).toBe(NUM);
        expect(shiftMonths(45322, -1e300, true)).toBe(NUM);
    });
});

describe('weeks', () => {
    test("a weekday counts from Monday, and Excel's are a day off before March 1900", () => {
        expect(weekdayFromMonday(2)).toBe(0);
        expect(weekdayFromMonday(0)).toBe(5);
        expect(weekdayFromMonday(60)).toBe(2);
        expect(weekdayFromMonday(61)).toBe(3);
        expect(weekdayFromMonday(46027)).toBe(0);
    });

    test('the type says which day is 1', () => {
        expect([1, 2, 3, 11, 12, 13, 14, 15, 16, 17].map((type) => weekdayNumber(45000, type))).toEqual([
            ...[4, 3, 2, 3, 2, 1, 7, 6, 5, 4],
        ]);
        expect([0, 4, 10, 18, 21].map((type) => weekdayNumber(45000, type))).toEqual([NUM, NUM, NUM, NUM, NUM]);
    });

    test('the week of 1 January is week 1, and a day before the first week start of 1900 is in week 0', () => {
        expect(weekNumber(0, 1)).toBe(0);
        expect(weekNumber(0, 2)).toBe(1);
        expect(weekNumber(366, 2)).toBe(54);
        expect(weekNumber(45298, 1)).toBe(2);
        expect(weekNumber(45298, 2)).toBe(1);
        expect(weekNumber(45000, 3)).toBe(NUM);
        expect(weekNumber(45656, 21)).toBe(1);
    });

    test('an ISO week belongs to the year of its Thursday, at both ends of the calendar too', () => {
        expect(isoWeek(1)).toBe(52);
        expect(isoWeek(2)).toBe(1);
        expect(isoWeek(44563)).toBe(52);
        expect(isoWeek(44564)).toBe(1);
        expect(isoWeek(LAST_SERIAL)).toBe(52);
    });
});
