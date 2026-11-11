import { describe, expect, test } from 'bun:test';
import {
    dateSerial,
    daysInMonth,
    isLeapYear,
    LAST_SERIAL,
    secondOfDay,
    serialDay,
    serialMonth,
    serialYear,
    timeSerial,
    weekday,
} from '../../values/dates';

const civil = (serial: number) => [serialYear(serial), serialMonth(serial), serialDay(serial)];

describe('dateSerial', () => {
    test("Excel's answers around its leap day of 1900", () => {
        expect(dateSerial(1900, 1, 1)).toBe(1);
        expect(dateSerial(1900, 2, 28)).toBe(59);
        expect(dateSerial(1900, 2, 29)).toBe(60);
        expect(dateSerial(1900, 3, 1)).toBe(61);
        expect(dateSerial(1900, 1, 0)).toBe(0);
        expect(dateSerial(1900, 3, 0)).toBe(60);
        expect(dateSerial(1901, 1, 1)).toBe(367);
    });

    test("the oracle's dates", () => {
        expect(dateSerial(2020, 1, 31)).toBe(43861);
        expect(dateSerial(2020, 1, 1)).toBe(43831);
        expect(dateSerial(2024, 2, 29)).toBe(45351);
        expect(dateSerial(2023, 2, 28)).toBe(44985);
        expect(dateSerial(2026, 1, 5)).toBe(46027);
        expect(dateSerial(2029, 1, 1)).toBe(47119);
        expect(dateSerial(1930, 1, 1)).toBe(10959);
        expect(dateSerial(9999, 12, 31)).toBe(LAST_SERIAL);
        expect(LAST_SERIAL).toBe(2958465);
    });

    test('months and days roll over and under as DATE does', () => {
        expect(dateSerial(2020, 13, 1)).toBe(44197);
        expect(dateSerial(2020, 13, 1)).toBe(dateSerial(2021, 1, 1));
        expect(dateSerial(2020, 1, 0)).toBe(43830);
        expect(dateSerial(2020, 0, 1)).toBe(dateSerial(2019, 12, 1));
        expect(dateSerial(2020, -11, 1)).toBe(dateSerial(2019, 1, 1));
        expect(dateSerial(2020, -12, 1)).toBe(dateSerial(2018, 12, 1));
        expect(dateSerial(2020, 25, 1)).toBe(dateSerial(2022, 1, 1));
        expect(dateSerial(2020, 1, 366)).toBe(dateSerial(2020, 12, 31));
        expect(dateSerial(2021, 3, -1)).toBe(dateSerial(2021, 2, 27));
        expect(dateSerial(2024, 2, 30)).toBe(dateSerial(2024, 3, 1));
    });

    test('a date before 1900 is a negative serial, a year past 9999 one past the last', () => {
        expect(dateSerial(1899, 12, 31)).toBe(0);
        expect(dateSerial(1899, 12, 30)).toBe(-1);
        expect(dateSerial(1900, 0, 1)).toBe(-30);
        expect(dateSerial(10000, 1, 1)).toBe(LAST_SERIAL + 1);
    });
});

describe('serial to civil date', () => {
    test("Excel's answers", () => {
        expect(civil(0)).toEqual([1900, 1, 0]);
        expect(civil(1)).toEqual([1900, 1, 1]);
        expect(civil(31)).toEqual([1900, 1, 31]);
        expect(civil(32)).toEqual([1900, 2, 1]);
        expect(civil(59)).toEqual([1900, 2, 28]);
        expect(civil(60)).toEqual([1900, 2, 29]);
        expect(civil(61)).toEqual([1900, 3, 1]);
        expect(civil(366)).toEqual([1900, 12, 31]);
        expect(civil(367)).toEqual([1901, 1, 1]);
        expect(civil(43861)).toEqual([2020, 1, 31]);
        expect(civil(45351)).toEqual([2024, 2, 29]);
        expect(civil(73050)).toEqual([2099, 12, 31]);
        expect(civil(73051)).toEqual([2100, 1, 1]);
        expect(civil(LAST_SERIAL)).toEqual([9999, 12, 31]);
    });

    test('every day agrees with a count that walks the calendar', () => {
        const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let year = 1900;
        let month = 1;
        let day = 1;
        let wrong = 0;
        for (let serial = 1; serial <= LAST_SERIAL; serial++) {
            if (serialYear(serial) !== year || serialMonth(serial) !== month || serialDay(serial) !== day) wrong++;
            if (dateSerial(year, month, day) !== serial) wrong++;
            const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0 || year === 1900);
            const length = month === 2 && leap ? 29 : (lengths[month - 1] ?? 0);
            if (daysInMonth(year, month) !== length) wrong++;
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
    });
});

describe('calendar', () => {
    test('leap years, with 1900 as Excel has it', () => {
        expect(isLeapYear(1900)).toBe(true);
        expect(isLeapYear(1904)).toBe(true);
        expect(isLeapYear(2000)).toBe(true);
        expect(isLeapYear(2024)).toBe(true);
        expect(isLeapYear(2100)).toBe(false);
        expect(isLeapYear(2023)).toBe(false);
    });

    test('days in a month', () => {
        expect(daysInMonth(1900, 2)).toBe(29);
        expect(daysInMonth(2023, 2)).toBe(28);
        expect(daysInMonth(2024, 2)).toBe(29);
        expect(daysInMonth(2100, 2)).toBe(28);
        expect(daysInMonth(2026, 1)).toBe(31);
        expect(daysInMonth(2026, 4)).toBe(30);
        expect(daysInMonth(2026, 12)).toBe(31);
    });

    test("weekday is 1 for Sunday, and Excel's are a day off before March 1900", () => {
        expect(weekday(1)).toBe(1);
        expect(weekday(60)).toBe(4);
        expect(weekday(61)).toBe(5);
        expect(weekday(0)).toBe(7);
        expect(weekday(7)).toBe(7);
        expect(weekday(8)).toBe(1);
        expect(weekday(46027)).toBe(2);
        expect(weekday(46337)).toBe(4);
        expect(weekday(LAST_SERIAL)).toBe(6);
    });
});

describe('time', () => {
    test('hours, minutes and seconds to a fraction of a day', () => {
        expect(timeSerial(12, 0, 0)).toBe(0.5);
        expect(timeSerial(6, 0, 0)).toBe(0.25);
        expect(timeSerial(13, 30, 0)).toBe(0.5625);
        expect(timeSerial(0, 0, 1)).toBe(1 / 86400);
        expect(timeSerial(25, 30, 0)).toBe(1.0625);
        expect(timeSerial(0, 90, 0)).toBe(0.0625);
        expect(timeSerial(0, 0, 0)).toBe(0);
    });

    test("TIME(25,0,0) is Excel's 0.04166666666666674 once the whole day is taken off", () => {
        expect(timeSerial(25, 0, 0) - 1).toBe(0.04166666666666674);
    });

    test('the second of the day rounds to the nearest second and wraps at midnight', () => {
        expect(secondOfDay(0)).toBe(0);
        expect(secondOfDay(0.5)).toBe(43200);
        expect(secondOfDay(0.5625)).toBe(48600);
        expect(secondOfDay(46027.5625)).toBe(48600);
        expect(secondOfDay(0.999999999)).toBe(0);
        expect(secondOfDay(0.99999)).toBe(86399);
        expect(secondOfDay(0.5 + 0.4 / 86400)).toBe(43200);
        expect(secondOfDay(0.5 + 0.6 / 86400)).toBe(43201);
        expect(secondOfDay(1.0625)).toBe(5400);
    });

    test('every second of a day survives the round trip, alone and on a date', () => {
        let wrong = 0;
        for (let second = 0; second < 86400; second++) {
            const fraction = timeSerial(Math.floor(second / 3600), Math.floor(second / 60) % 60, second % 60);
            if (secondOfDay(fraction) !== second) wrong++;
            if (secondOfDay(46027 + fraction) !== second) wrong++;
            if (secondOfDay(LAST_SERIAL + fraction) !== second) wrong++;
        }
        expect(wrong).toBe(0);
    });
});
