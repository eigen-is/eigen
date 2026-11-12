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

describe('dateSerial and serialDate', () => {
    test("Google's days around serial 0 and its limits", () => {
        expect(civil(0)).toEqual([1899, 12, 30]);
        expect(civil(1)).toEqual([1899, 12, 31]);
        expect(civil(2)).toEqual([1900, 1, 1]);
        expect(civil(-1)).toEqual([1899, 12, 29]);
        expect(civil(59)).toEqual([1900, 2, 27]);
        expect(civil(60)).toEqual([1900, 2, 28]);
        expect(civil(61)).toEqual([1900, 3, 1]);
        expect(civil(-36)).toEqual([1899, 11, 24]);
        expect(civil(-366)).toEqual([1898, 12, 29]);
        expect(civil(-141500)).toEqual([1512, 8, 1]);
        expect(civil(-141639)).toEqual([1512, 3, 15]);
        expect(civil(-36522)).toEqual([1800, 1, 1]);
        expect(civil(-328716)).toEqual([1000, 1, 1]);
        expect(civil(-657434)).toEqual([100, 1, 1]);
        expect(civil(FIRST_SERIAL)).toEqual([1, 1, 1]);
        expect(civil(LAST_SERIAL)).toEqual([9999, 12, 31]);
        expect([FIRST_SERIAL, LAST_SERIAL]).toEqual([-693593, 2958465]);
    });

    test("Excel's days from 1 March 1900 on", () => {
        expect(dateSerial(1900, 3, 1)).toBe(61);
        expect(dateSerial(2020, 1, 31)).toBe(43861);
        expect(dateSerial(2024, 2, 29)).toBe(45351);
        expect(dateSerial(2026, 1, 5)).toBe(46027);
        expect(dateSerial(1930, 1, 1)).toBe(10959);
        expect(civil(73050)).toEqual([2099, 12, 31]);
        expect(civil(73051)).toEqual([2100, 1, 1]);
    });

    test('months and days roll over and under, 1900 has no leap day', () => {
        expect(dateSerial(2020, 13, 1)).toBe(dateSerial(2021, 1, 1));
        expect(dateSerial(2020, 0, 1)).toBe(dateSerial(2019, 12, 1));
        expect(dateSerial(2020, -12, 1)).toBe(dateSerial(2018, 12, 1));
        expect(dateSerial(2020, 1, 366)).toBe(dateSerial(2020, 12, 31));
        expect(dateSerial(2021, 3, -1)).toBe(dateSerial(2021, 2, 27));
        expect(dateSerial(1900, 2, 29)).toBe(61);
        expect(dateSerial(1900, 1, 0)).toBe(1);
        expect(dateSerial(0, 12, 31)).toBe(FIRST_SERIAL - 1);
        expect(dateSerial(10000, 1, 1)).toBe(LAST_SERIAL + 1);
    });

    // The model: a count that walks the calendar a day at a time from Monday 1 January of the year 1, with the
    // leap rule written out, and keeps the week numbers as a person would count them.
    test('every day of the calendar agrees with a count that walks it', () => {
        let year = 1;
        let month = 1;
        let day = 1;
        let weekday = 0;
        let sundayWeek = 1;
        let mondayWeek = 1;
        let iso = 1;
        let wrong = 0;
        const firsts: number[] = [];
        for (let serial = FIRST_SERIAL; serial <= LAST_SERIAL; serial++) {
            if (day === 1) firsts.push(serial);
            if (month === 1 && day === 1) {
                sundayWeek = 1;
                mondayWeek = 1;
            } else {
                if (weekday === 6) sundayWeek++;
                if (weekday === 0) mondayWeek++;
            }
            // A Monday from 29 December to 4 January starts the week whose Thursday is in January.
            if (weekday === 0) iso = (month === 12 && day >= 29) || (month === 1 && day <= 4) ? 1 : iso + 1;
            const date = serialDate(serial);
            if (date.year !== year || date.month !== month || date.day !== day) wrong++;
            if (dateSerial(year, month, day) !== serial) wrong++;
            if (weekdayFromMonday(serial) !== weekday) wrong++;
            if (weekNumber(serial, 1) !== sundayWeek || weekNumber(serial, 2) !== mondayWeek) wrong++;
            if (isoWeek(serial) !== iso || weekNumber(serial, 21) !== iso) wrong++;
            const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
            const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
            if (daysInMonth(year, month) !== length) wrong++;
            weekday = (weekday + 1) % 7;
            day++;
            if (day > length) {
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

        // The months, from the walk's own list of first days: every 7th day, a few months on and back.
        firsts.push(LAST_SERIAL + 1);
        let at = 0;
        for (let serial = FIRST_SERIAL; serial <= LAST_SERIAL; serial += 7) {
            while (firsts[at + 1] <= serial) at++;
            for (const months of [-25, -12, -1, 0, 1, 11, 1200]) {
                const to = at + months;
                const inRange = to >= 0 && to < firsts.length - 1;
                const length = inRange ? firsts[to + 1] - firsts[to] : 0;
                const same = inRange ? firsts[to] + Math.min(serial - firsts[at] + 1, length) - 1 : NUM;
                if (shiftMonths(serial, months, false) !== same) wrong++;
                if (shiftMonths(serial, months, true) !== (inRange ? firsts[to] + length - 1 : NUM)) wrong++;
            }
        }
        expect(wrong).toBe(0);
    });
});

describe('dateOf and timeOf', () => {
    test('a year under 1000 counts from 1900, a later one is the year written, and every part is cut down', () => {
        expect(dateOf(0, 1, 1)).toBe(2);
        expect(dateOf(99, 1, 1)).toBe(36161);
        expect(dateOf(999, 1, 1)).toBe(dateSerial(2899, 1, 1));
        expect(dateOf(1000, 1, 1)).toBe(-328716);
        expect(dateOf(1899, 12, 31)).toBe(1);
        expect(dateOf(2024.9, -0.5, 15.9)).toBe(45245);
        expect(dateOf(1900, 1, -2)).toBe(-1);
    });

    test('a date outside the calendar, a negative year and a month from 32767 on are #NUM!', () => {
        expect(dateOf(9999, 12, 32)).toBe(NUM);
        expect(dateOf(-1, 1, 1)).toBe(NUM);
        expect(dateOf(2024, 32767, 1)).toBe(NUM);
    });

    test('a day that is no 16-bit number is the largest of them', () => {
        expect(dateOf(2024, 2, 32768)).toBe(78089);
        expect(dateOf(2024, 2, 1e300)).toBe(78089);
        expect(dateOf(2024, 2, -32769)).toBe(78089);
        expect(dateOf(2024, 2, -32768)).toBe(45323 - 32769);
        expect(dateOf(1000, 1, -365000)).toBe(dateOf(1000, 1, 32767));
    });

    test('the time is what the whole days leave, to the bit Excel leaves', () => {
        expect(timeOf(12, 0, 0)).toBe(0.5);
        expect(timeOf(24, 0, 0)).toBe(0);
        expect(timeOf(32767, 0, 0)).toBe(0.29166666666674246);
        expect(timeOf(1, -60, 0)).toBe(0);
        expect(timeOf(0, 0, -0.4)).toBe(NUM);
        expect(timeOf(0, 32768, 0)).toBe(NUM);
        expect(timeOf(24, -98305, 0)).toBe(timeOf(0, 32767, 0));
        expect(timeOf(0, -65536, 0)).toBe(0);
    });
});

describe('shiftMonths', () => {
    test('the same day, or the last when the month is shorter', () => {
        expect(shiftMonths(45322, 1, false)).toBe(45351);
        expect(shiftMonths(45351, 12, false)).toBe(45716);
        expect(shiftMonths(45000, -1236, false)).toBe(7380);
        expect(shiftMonths(45000, 0, true)).toBe(45016);
        expect(shiftMonths(31, -1, false)).toBe(0);
        expect(shiftMonths(40, -2, true)).toBe(1);
    });

    test('a day outside the calendar is #NUM!', () => {
        expect(shiftMonths(FIRST_SERIAL, -1, false)).toBe(NUM);
        expect(shiftMonths(FIRST_SERIAL + 31, -1, false)).toBe(FIRST_SERIAL);
        expect(shiftMonths(LAST_SERIAL, 1, false)).toBe(NUM);
        expect(shiftMonths(45322, 1e300, false)).toBe(NUM);
        expect(shiftMonths(45322, -1e300, true)).toBe(NUM);
    });
});

describe('weeks', () => {
    test('the type says which day is 1', () => {
        expect([1, 2, 3, 11, 12, 13, 14, 15, 16, 17].map((type) => weekdayNumber(45000, type))).toEqual([
            ...[4, 3, 2, 3, 2, 1, 7, 6, 5, 4],
        ]);
        expect([1, 2, 3, 17].map((type) => weekdayNumber(-141500, type))).toEqual([5, 4, 3, 5]);
        expect([0, 4, 10, 18, 21].map((type) => weekdayNumber(45000, type))).toEqual([NUM, NUM, NUM, NUM, NUM]);
    });

    test('a week starts on the day the type names', () => {
        expect(weekNumber(45298, 1)).toBe(2);
        expect(weekNumber(45298, 2)).toBe(1);
        expect(weekNumber(45000, 14)).toBe(11);
        expect(weekNumber(0, 1)).toBe(52);
        expect(weekNumber(1, 1)).toBe(53);
        expect(weekNumber(45000, 3)).toBe(NUM);
    });
});
