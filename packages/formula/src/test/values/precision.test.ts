import { describe, expect, test } from 'bun:test';
import { compare15, equal15, round15, roundDecimal, snapSum } from '../../values/precision';

function seeded(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The 15 digits of the number as one whole number, cut `digits` places after the decimal point, half away from zero.
function slowRound(n: number, digits: number): number {
    if (n === 0) return 0;
    const [mantissa = '', exponent = ''] = Math.abs(n).toExponential(14).split('e');
    const shown = BigInt(mantissa.replace('.', ''));
    const drop = 14 - Number(exponent) - digits;
    if (drop <= 0) return Number(n.toPrecision(15));
    const unit = 10n ** BigInt(drop);
    const kept = (shown + unit / 2n) / unit;
    if (kept === 0n) return 0;
    return Number(`${n < 0 ? '-' : ''}${kept}e${-digits}`);
}

describe('round15', () => {
    test('keeps 15 significant digits', () => {
        expect(round15(0.1 + 0.2)).toBe(0.3);
        expect(round15(1 / 3)).toBe(0.333333333333333);
        expect(round15(2 / 3)).toBe(0.666666666666667);
        expect(round15(-2 / 3)).toBe(-0.666666666666667);
        expect(round15(1000000000000000.2)).toBe(1e15);
        expect(round15(4.1 - 4)).toBe(0.0999999999999996);
        expect(round15(1.2e200)).toBe(1.2e200);
        expect(round15(5e-324)).toBe(5e-324);
    });

    test('leaves a number of 15 digits or fewer alone', () => {
        for (const n of [0, 1, -1, 0.1, 1.005, 2.675, 123456789012345, 1e-300, 43861.25]) expect(round15(n)).toBe(n);
    });
});

describe('compare15 and equal15', () => {
    test("Excel's answers", () => {
        expect(equal15(0.1 + 0.2, 0.3)).toBe(true);
        expect(equal15(0.1 * 3, 0.3)).toBe(true);
        expect(equal15((1 / 3) * 3, 1)).toBe(true);
        expect(equal15(49 / 49, 1)).toBe(true);
        expect(equal15(2 ** 53 + 1, 2 ** 53)).toBe(true);
        expect(equal15(1.2e200 + 1e100, 1.2e200)).toBe(true);
        expect(equal15(4.1 - 4, 0.1)).toBe(false);
        expect(equal15(0.1 + 0.2 - 0.3, 0)).toBe(false);
        expect(equal15(0.7 - 0.4, 0.3)).toBe(true);
    });

    test('orders by the rounded values', () => {
        expect(compare15(1, 2)).toBe(-1);
        expect(compare15(2, 1)).toBe(1);
        expect(compare15(-1, 1)).toBe(-1);
        expect(compare15(0, 0)).toBe(0);
        expect(compare15(0, -0)).toBe(0);
        expect(compare15(0.1 + 0.2, 0.3)).toBe(0);
        expect(compare15(0.3, 0.1 + 0.2)).toBe(0);
        expect(compare15(4.1 - 4, 0.1)).toBe(-1);
        expect(compare15(0.1, 4.1 - 4)).toBe(1);
        expect(compare15(0, 5e-324)).toBe(-1);
        expect(compare15(-1e-300, 0)).toBe(-1);
        expect(compare15(1e300, 1.0000000000001e300)).toBe(-1);
    });

    // The Excel experiment: 1 plus 22 last bits equals 1 and plus 23 does not; at 1E10 the line is between 26 and 28.
    test("Excel's line between equal and not is the half of the 15th digit", () => {
        expect(equal15(1 + 22 * 2 ** -52, 1)).toBe(true);
        expect(equal15(1 + 23 * 2 ** -52, 1)).toBe(false);
        expect(equal15(1e10 + 26 * 2 ** -19, 1e10)).toBe(true);
        expect(equal15(1e10 + 28 * 2 ** -19, 1e10)).toBe(false);
        expect(equal15(1, 1 + 2 ** -48)).toBe(true);
        expect(equal15(1, 1 + 2 ** -47)).toBe(false);
    });

    test('a 16 digit id equals another that agrees in 15 digits', () => {
        expect(equal15(1234567890123451, 1234567890123452)).toBe(true);
        expect(equal15(1234567890123410, 1234567890123420)).toBe(false);
    });

    test('agrees with rounding both sides, on pairs a few last bits apart', () => {
        const random = seeded(15);
        const bits = new Float64Array(1);
        const words = new BigInt64Array(bits.buffer);
        for (let i = 0; i < 20000; i++) {
            const a = (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20);
            bits[0] = a;
            words[0] = (words[0] ?? 0n) + BigInt(Math.floor(random() * 400) - 200);
            const b = bits[0] ?? 0;
            const ra = round15(a);
            const rb = round15(b);
            expect(compare15(a, b)).toBe(ra < rb ? -1 : ra > rb ? 1 : 0);
            expect(equal15(a, b)).toBe(ra === rb);
        }
    });
});

describe('snapSum', () => {
    test('the sums Excel answers with 0', () => {
        expect(snapSum(0.1 + 0.2 - 0.3, 0.1 + 0.2)).toBe(0);
        expect(snapSum(1 - 0.9 - 0.1, 1 - 0.9)).toBe(0);
        expect(snapSum(1.333 + 1.225 - 1.333 - 1.225, 1.333 + 1.225 - 1.333)).toBe(0);
        expect(snapSum(0.1 + 0.2 + -0.3, 0.1 + 0.2)).toBe(0);
        expect(snapSum(1e15 + 0.3 - 1e15, 1e15 + 0.3)).toBe(0);
        expect(snapSum(1 + 2 ** -50 - 1, 1 + 2 ** -50)).toBe(0);
    });

    // x is `steps` last bits above `base`; Excel answers x - base and base - x with 0 up to 7 steps, at 1, 1E10
    // and 1E-10, and with the difference from 8 steps on.
    test("Excel's limit: a result 50 bits or more under its left operand is 0", () => {
        for (const base of [1, 1e10, 1e-10]) {
            const bit = 2 ** (Math.floor(Math.log2(base)) - 52);
            for (const steps of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 23, 64, 4096]) {
                const x = base + steps * bit;
                const kept = steps >= 8;
                expect([base, steps, snapSum(x - base, x)]).toEqual([base, steps, kept ? steps * bit : 0]);
                expect([base, steps, snapSum(base - x, base)]).toEqual([base, steps, kept ? -steps * bit : 0]);
            }
        }
        expect(snapSum(1 + 2 ** -40 - 1, 1 + 2 ** -40)).toBe(2 ** -40);
        expect(snapSum(1e15 + 1 - 1e15, 1e15 + 1)).toBe(1);
    });

    test('only the left operand decides: 2 - x is 0 at 15 last bits of x, x - 2 stays at 8', () => {
        const bit = 2 ** -52;
        expect(snapSum(2 - (2 - 15 * bit), 2)).toBe(0);
        expect(snapSum(2 - (2 - 16 * bit), 2)).toBe(16 * bit);
        expect(snapSum(2 - 8 * bit - 2, 2 - 8 * bit)).toBe(-8 * bit);
        expect(snapSum(2 - 7 * bit - 2, 2 - 7 * bit)).toBe(0);
        expect(snapSum(-(2 - 7 * bit) + 2, -(2 - 7 * bit))).toBe(0);
    });

    test('the limit steps at a power of two, down to the smallest numbers', () => {
        for (const exponent of [-960, -300, -1, 0, 1, 52, 300, 1023]) {
            const power = 2 ** exponent;
            const limit = 2 ** (exponent - 49);
            const under = power * (1 - 2 ** -53);
            const over = power * (1 + 2 ** -52);
            const most = power * (2 - 2 ** -52);
            for (const left of [power, over, most, -power]) {
                expect([left, snapSum(limit, left)]).toEqual([left, limit]);
                expect([left, snapSum(-limit, left)]).toEqual([left, -limit]);
                expect([left, snapSum(limit * (1 - 2 ** -53), left)]).toEqual([left, 0]);
            }
            expect([under, snapSum(limit / 2, under)]).toEqual([under, limit / 2]);
            expect([under, snapSum((limit / 2) * (1 - 2 ** -53), under)]).toEqual([under, 0]);
        }
        expect(snapSum(5e-324, 5e-324)).toBe(5e-324);
        expect(snapSum(5e-324, 2 ** -1030)).toBe(5e-324);
        expect(snapSum(5e-324, 2 ** -1024)).toBe(0);
        expect(snapSum(2 ** -1074, 2 ** -1025)).toBe(2 ** -1074);
        expect(snapSum(2 ** -1074, 1.5 * 2 ** -1025)).toBe(2 ** -1074);
    });

    test('a result that is not tiny against its left operand stays', () => {
        expect(snapSum(30.2 - 30, 30.2)).toBe(0.1999999999999993);
        expect(snapSum(43.1 - 43.2 + 1, 43.1 - 43.2)).toBe(0.8999999999999986);
        expect(snapSum(4.1 - 4, 4.1)).toBe(4.1 - 4);
        expect(snapSum(0.1 + 0.2 - 0.3 + 0, 0.1 + 0.2 - 0.3)).toBe(0.1 + 0.2 - 0.3);
        expect(snapSum(1e-20, 0)).toBe(1e-20);
        expect(snapSum(1e-20, 1e-20)).toBe(1e-20);
        expect(snapSum(0, 0)).toBe(0);
        expect(snapSum(0, 5)).toBe(0);
        expect(snapSum(3, 1)).toBe(3);
        expect(snapSum(1e300, 1e300)).toBe(1e300);
        expect(snapSum(1e308, 1e308)).toBe(1e308);
    });
});

describe('roundDecimal', () => {
    test("Excel's answers", () => {
        expect(roundDecimal(1.005, 2)).toBe(1.01);
        expect(roundDecimal(2.675, 2)).toBe(2.68);
        expect(roundDecimal(2.5, 0)).toBe(3);
        expect(roundDecimal(-2.5, 0)).toBe(-3);
        expect(roundDecimal(1234.567, 1)).toBe(1234.6);
        expect(roundDecimal(1234.567, -1)).toBe(1230);
        expect(roundDecimal(-0.5, 0)).toBe(-1);
    });

    test('negative digits, zero and numbers with nothing to round', () => {
        expect(roundDecimal(1250, -2)).toBe(1300);
        expect(roundDecimal(-1250, -2)).toBe(-1300);
        expect(roundDecimal(49, -2)).toBe(0);
        expect(roundDecimal(50, -2)).toBe(100);
        expect(roundDecimal(0, 3)).toBe(0);
        expect(roundDecimal(1.5, 5)).toBe(1.5);
        expect(roundDecimal(0.1 + 0.2, 20)).toBe(0.3);
        expect(roundDecimal(1e300, 2)).toBe(1e300);
        expect(roundDecimal(1e-300, 2)).toBe(0);
        expect(roundDecimal(1.23e-28, 29)).toBe(1.2e-28);
        expect(roundDecimal(1.25e30, -29)).toBe(1.3e30);
    });

    test('never answers negative zero', () => {
        expect(Object.is(roundDecimal(-0.001, 0), 0)).toBe(true);
        expect(Object.is(roundDecimal(-0, 2), 0)).toBe(true);
        expect(Object.is(roundDecimal(-4, -1), 0)).toBe(true);
    });

    test('a number a few bits under a half rounds as the decimal Excel shows', () => {
        expect(roundDecimal(0.285, 2)).toBe(0.29);
        expect(roundDecimal(1.45, 1)).toBe(1.5);
        expect(roundDecimal(8.345, 2)).toBe(8.35);
        expect(roundDecimal(-1.005, 2)).toBe(-1.01);
        expect(roundDecimal(0.49999999999999994, 0)).toBe(1);
        expect(roundDecimal(0.4999999999999, 0)).toBe(0);
        expect(roundDecimal(9.004999999999994, 2)).toBe(9);
        expect(roundDecimal(9.004999999999995, 2)).toBe(9.01);
    });

    test('agrees with the slow version on halves and their neighbours', () => {
        const random = seeded(1005);
        const bits = new Float64Array(1);
        const words = new BigInt64Array(bits.buffer);
        for (let i = 0; i < 40000; i++) {
            const digits = Math.floor(random() * 12) - 3;
            const half = (Math.floor(random() * 10 ** Math.floor(random() * 9)) + 0.5) / 10 ** digits;
            bits[0] = random() < 0.5 ? half : -half;
            words[0] = (words[0] ?? 0n) + BigInt(Math.floor(random() * 120) - 60);
            const n = bits[0] ?? 0;
            expect([n, digits, roundDecimal(n, digits)]).toEqual([n, digits, slowRound(n, digits)]);
        }
    });

    test('agrees with the slow version on random numbers of every size', () => {
        const random = seeded(2675);
        for (let i = 0; i < 40000; i++) {
            const n = (random() - 0.5) * 10 ** Math.floor(random() * 50 - 25);
            const digits = Math.floor(random() * 60) - 30;
            expect([n, digits, roundDecimal(n, digits)]).toEqual([n, digits, slowRound(n, digits)]);
        }
    });
});
