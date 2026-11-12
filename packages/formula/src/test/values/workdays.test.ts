import { describe, expect, test } from 'bun:test';
import { NUM, VALUE } from '../../values/errors';
import { addWorkdays, countWorkdays } from '../../values/workdays';

// 45000 is Wednesday 15 March 2023; 45002 is that Friday and 45003 the Saturday.
const none = () => new Float64Array(0);
const days = (...holidays: number[]) => Float64Array.from(holidays);

describe('countWorkdays', () => {
    test('both ends count, and a span that runs back is negative', () => {
        expect(countWorkdays(45000, 45400, 1, none())).toBe(287);
        expect(countWorkdays(45400, 45000, 1, none())).toBe(-287);
        expect(countWorkdays(45000, 45000, 1, none())).toBe(1);
        expect(countWorkdays(0, 1, 1, none())).toBe(0);
    });

    test('a holiday counts once, on a working day, cut down to its day', () => {
        expect(countWorkdays(45000, 45010, 1, days(45002, 45003, 45003))).toBe(7);
        expect(countWorkdays(45000, 45010, 1, days(45002.5, 45002))).toBe(7);
        expect(countWorkdays(45000, 45010, 1, days(2, 4, 6))).toBe(8);
        expect(countWorkdays(45000, 45010, 1, days(45002, -1))).toBe(7);
        expect(countWorkdays(45000, 45010, 1, days(45002, -693594))).toBe(NUM);
        expect(countWorkdays(45000, 45010, 1, days(1e300))).toBe(NUM);
    });

    test('the days off by code and by text', () => {
        const by = (weekend: number | string | boolean | null) => countWorkdays(45000, 45010, weekend, none());
        expect([1, 2, 3, 4, 5, 6, 7].map(by)).toEqual([8, 9, 9, 8, 7, 7, 7]);
        expect([11, 12, 13, 14, 15, 16, 17].map(by)).toEqual([10, 10, 10, 9, 9, 9, 9]);
        expect([0, 8, 10, 18, -1, null, false].map(by)).toEqual([NUM, NUM, NUM, NUM, NUM, NUM, NUM]);
        expect([true, 1.9, '0000011'].map(by)).toEqual([8, 8, 8]);
        expect(['1111111', '0000000', '1111110', '1000000'].map(by)).toEqual([0, 11, 1, 10]);
        expect(['1', '', '000001', '00000111', '0000012', '0000011 '].map(by)).toEqual(Array(6).fill(VALUE));
    });
});

describe('addWorkdays', () => {
    test('on and back, from a working day and from a weekend', () => {
        expect(addWorkdays(45000, 10, 1, none())).toBe(45014);
        expect(addWorkdays(45000, -10, 1, none())).toBe(44986);
        expect(addWorkdays(45004, 10, 1, none())).toBe(45016);
        expect(addWorkdays(45004, -1, 1, none())).toBe(45002);
        expect(addWorkdays(45004, 0, 1, none())).toBe(45004);
        expect(addWorkdays(45000, -1.9, 1, none())).toBe(44998);
        expect(addWorkdays(45000, 1048576, 1, none())).toBe(1513006);
    });

    test("Google's answers across serial 0", () => {
        expect(countWorkdays(0, 10, 1, none())).toBe(7);
        expect(countWorkdays(1, 10, 1, none())).toBe(7);
        expect(addWorkdays(0, 5, 1, none())).toBe(6);
        expect(addWorkdays(5, -5, 1, none())).toBe(-2);
        expect(addWorkdays(5, -6, 1, none())).toBe(-3);
        expect(addWorkdays(5, -10, 1, none())).toBe(-9);
    });

    // The model: a week whose days are named in the test, walked a day at a time. -141500 is a Thursday, and
    // the first day of the calendar a Monday, so the 400th after it is a Tuesday.
    test('agrees with a walk day by day, before 1900 and at the first day too', () => {
        const from = new Map([
            [45000, 2],
            [-12, 0],
            [-141500, 3],
            [-693593 + 400, 1],
        ]);
        const off: [number | string, number[]][] = [
            [1, [5, 6]],
            [4, [1, 2]],
            [11, [6]],
            ['1111110', [0, 1, 2, 3, 4, 5]],
            ['0101010', [1, 3, 5]],
        ];
        let wrong = 0;
        for (const [first, weekday] of from) {
            for (const [weekend, free] of off) {
                const works = (day: number) => !free.includes((((weekday + day - first) % 7) + 7) % 7);
                for (let start = first; start < first + 7; start += 1) {
                    for (let count = -30; count <= 30; count += 1) {
                        let day = start;
                        let between = 0;
                        for (let left = Math.abs(count); left > 0; left -= 1) {
                            day += Math.sign(count);
                            while (!works(day)) day += Math.sign(count);
                        }
                        for (let at = Math.min(start, day); at <= Math.max(start, day); at += 1)
                            if (works(at)) between += 1;
                        if (addWorkdays(start, count, weekend, none()) !== day) wrong += 1;
                        if (countWorkdays(start, day, weekend, none()) !== (day < start ? -between : between))
                            wrong += 1;
                    }
                }
            }
        }
        expect(wrong).toBe(0);
    });

    test('agrees with a walk by its own count, for every start of a week and every week', () => {
        let wrong = 0;
        for (const weekend of [1, 4, 11, '1111110', '0101010']) {
            for (let start = 45000; start < 45007; start += 1) {
                for (let count = -30; count <= 30; count += 1) {
                    let day = start;
                    for (let left = Math.abs(count); left > 0; left -= 1) {
                        day += Math.sign(count);
                        while (countWorkdays(day, day, weekend, none()) === 0) day += Math.sign(count);
                    }
                    if (addWorkdays(start, count, weekend, none()) !== day) wrong += 1;
                }
            }
        }
        expect(wrong).toBe(0);
    });

    test('a holiday on the way pushes the end on, which may meet the next', () => {
        expect(addWorkdays(45000, 3, 1, days(45002, 45003, 45003))).toBe(45006);
        expect(addWorkdays(45000, 2, 1, days(45005, 45002, 45001))).toBe(45007);
        expect(addWorkdays(45007, -2, 1, days(45005, 45002, 45006))).toBe(45000);
        expect(addWorkdays(45000, -3, 1, days(45002))).toBe(44995);
        expect(addWorkdays(45000, 3, 1, days(-2.5))).toBe(45005);
        expect(addWorkdays(45000, 3, 1, days(2958466))).toBe(NUM);
    });

    test('a day outside the calendar is #NUM!, and a week with no working day #VALUE!', () => {
        expect(addWorkdays(-693593, -1, 1, none())).toBe(NUM);
        expect(addWorkdays(-693592, -1, 1, none())).toBe(-693593);
        expect(addWorkdays(2958465, 1, 1, none())).toBe(NUM);
        expect(addWorkdays(45000, 1e300, 1, none())).toBe(NUM);
        expect(addWorkdays(45000, -1e300, 1, none())).toBe(NUM);
        expect(addWorkdays(45000, 10, '1111111', none())).toBe(VALUE);
        expect(addWorkdays(45000, 0, 'abc', none())).toBe(45000);
        expect(addWorkdays(45000, 10, 0, none())).toBe(NUM);
    });
});
