import { describe, expect, test } from 'bun:test';
import { NUM } from '../../index';
import { evaluate } from '../recalc/support';

function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

// What SUM(start, value, value, …) is, `times` values, by the rules Excel was seen to follow: one addition at a
// time from 0, and a result of the last addition that lies 49 bits or more under the sum before it is 0.
function literal(start: number, value: number, times: number) {
    let sum = 0 + start;
    let before = 0;
    for (let i = 0; i < times; i += 1) {
        before = sum;
        sum += value;
    }
    if (!Number.isFinite(sum)) return NUM;
    let exponent = Math.floor(Math.log2(Math.abs(before)));
    if (2 ** exponent > Math.abs(before)) exponent -= 1;
    if (before !== 0 && Math.abs(sum) < 2 ** (exponent - 49)) return 0;
    return Math.abs(sum) < 2.2250738585072014e-308 ? 0 : sum;
}

// The same sum through the engine: `times` blank rows, each `value` once the comparison is multiplied.
function engine(start: number, value: number, times: number) {
    return evaluate(`=SUM(A1,(B1:B${times}="")*A2)`, { A1: start, A2: value });
}

function check(start: number, value: number, times: number): void {
    const expected = literal(start, value, times);
    const got = engine(start, value, times);
    if (!Object.is(got, expected))
        throw new Error(`SUM(${start}, ${value} × ${times}) is ${got}, literally ${expected}`);
}

describe('one value added many times is the sum a loop of additions gives, bit for bit', () => {
    test('any two numbers', () => {
        const next = random(11);
        const number = () => (next() < 0.5 ? -1 : 1) * (1 + next()) * 2 ** Math.floor(next() * 120 - 60);
        for (let i = 0; i < 6000; i += 1) check(number(), number(), 2 + Math.floor(next() * 3000));
    });

    test('a value that ends on the half between two doubles of the sum', () => {
        const next = random(12);
        for (let i = 0; i < 6000; i += 1) {
            const power = 2 ** (50 + Math.floor(next() * 8));
            const unit = power / 2 ** 52;
            const sign = next() < 0.5 ? -1 : 1;
            const from =
                next() < 0.5 ? power + Math.floor(next() * 40) * unit : 2 * power - Math.floor(next() * 4000) * unit;
            const value = (next() < 0.3 ? -1 : 1) * (Math.floor(next() * 4) + 0.5) * unit;
            check(sign * from, sign * value, 2 + Math.floor(next() * 4000));
        }
    });

    test('a sum that changes its sign on the way', () => {
        const next = random(13);
        for (let i = 0; i < 3000; i += 1) {
            const times = 2 + Math.floor(next() * 3000);
            const value = (next() < 0.5 ? -1 : 1) * (1 + next()) * 2 ** Math.floor(next() * 40 - 20);
            check(-value * times * next(), value, times);
        }
    });

    test('a sum that grows through many powers of two', () => {
        const next = random(14);
        for (let i = 0; i < 40; i += 1) check(next() * 1e-9, (next() - 0.3) * 10 ** Math.floor(next() * 6), 1000000);
        check(0, 0.1, 1048576);
        check(-104857.6, 0.1, 1048576);
        check(1e300, 1e292, 1000000);
        check(1.7e308, 1e304, 20000);
    });

    test('zeros of either sign, and a value too small to move the sum', () => {
        for (const start of [0, -0, 1, -1e-300]) {
            for (const value of [0, -0, 1e-17, -1e-17, 3e-308]) check(start, value, 5000);
        }
    });

    test('the last addition lands on what binary rounding left of zero', () => {
        const next = random(15);
        let snapped = 0;
        for (let i = 0; i < 3000; i += 1) {
            const times = 2 + Math.floor(next() * 200);
            const value = [0.1, 0.2, 0.3, 0.7, 1.1, 1e-3][Math.floor(next() * 6)];
            let reached = 0;
            for (let k = 0; k < times; k += 1) reached += value;
            const start = -(next() < 0.5 ? reached : value * times);
            check(start, value, times);
            if (literal(start, value, times) === 0 && start !== -reached) snapped += 1;
        }
        expect(snapped).toBeGreaterThan(3);
    });
});
