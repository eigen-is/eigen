// Excel's 15 significant digits on top of plain doubles. Arithmetic keeps every bit; these rules apply where a
// number is compared, where a sum comes out next to zero and where a rounding function cuts decimals or counts
// whole steps, so that 0.1+0.2 equals 0.3, ROUND(1.005,2) is 1.01 and ROUNDDOWN(0.29,2) is 0.29. The evaluator's
// operators and the function library call them once per cell, so each takes its cheap exit before it reads any
// decimal digits.

// A sum whose leading bit lies this many bits or more under its left operand's is what binary rounding left of a
// decimal zero.
const SNAP_BITS = 50;

// Two numbers further apart than this, relative to the larger, differ within their first 15 digits.
const CLOSE_RATIO = 2e-14;

// Under a half by less than this, relative to the number, its 15 digit decimal may be the half itself.
const HALF_RATIO = 6e-15;

// The powers a double holds exactly, so that scaling by one rounds once.
export const POWERS_OF_TEN: readonly number[] = [
    1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20,
    1e21, 1e22,
];

// The 15 digit decimal of a number without its sign: one digit, a point, 14 digits, e, a sign and the exponent.
export function decimal15(n: number): string {
    return Math.abs(n).toExponential(14);
}

export function digitsOf(decimal: string): string {
    return decimal.charAt(0) + decimal.slice(2, 16);
}

export function exponentOf(decimal: string): number {
    return Number(decimal.slice(17));
}

export function round15(n: number): number {
    return Number(n.toPrecision(15));
}

export function equal15(a: number, b: number): boolean {
    return compare15(a, b) === 0;
}

// Negative, zero or positive, as a sort wants it.
export function compare15(a: number, b: number): number {
    if (a === b) return 0;
    if (Math.abs(a - b) <= CLOSE_RATIO * Math.max(Math.abs(a), Math.abs(b))) {
        a = round15(a);
        b = round15(b);
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

// The result of one a + b or a - b, or 0 when it is tiny against `a`, the left operand. Excel goes by a's binary
// exponent, so the limit is a power of two: the largest one that is not above |a|, shifted down.
export function snapSum(result: number, a: number): number {
    const left = Math.abs(a);
    const raised = Math.abs(result) * 2 ** (SNAP_BITS - 1);
    if (raised >= left) return result;
    if (raised * 2 <= left) return 0;
    let power = 1;
    while (power > left) power /= 2;
    while (power * 2 <= left) power *= 2;
    return raised < power ? 0 : result;
}

// Rounds half away from zero at `digits` decimals; negative digits round left of the decimal point. It rounds the
// 15 digit decimal Excel shows and not the double under it, which for 1.005 lies just below the half.
export function roundDecimal(n: number, digits: number): number {
    const power = POWERS_OF_TEN[Math.abs(digits)];
    if (power !== undefined) {
        const scaled = Math.abs(digits < 0 ? n / power : n * power);
        const whole = Math.floor(scaled + 0.5);
        if (whole + 0.5 - scaled > HALF_RATIO * scaled) {
            if (whole === 0) return 0;
            const rounded = digits < 0 ? whole * power : whole / power;
            return n < 0 ? -rounded : rounded;
        }
    }
    // The 15 digits as one whole number, cut where the rounding falls, in arithmetic that is exact.
    const decimal = decimal15(n);
    const cut = 14 - exponentOf(decimal) - digits;
    if (cut <= 0) return round15(n);
    const unit = POWERS_OF_TEN[cut];
    if (unit === undefined || unit > 1e15) return 0;
    const shown = Number(digitsOf(decimal));
    let kept = Math.floor(shown / unit);
    if (2 * (shown - kept * unit) >= unit) kept += 1;
    if (kept === 0) return 0;
    return Number(`${n < 0 ? '-' : ''}${kept}e${-digits}`);
}

// Cuts at `digits` decimals toward zero, or with `away` steps to the next number of that many decimals away from
// zero when anything is cut off. As roundDecimal it works on the 15 digit decimal, so 0.29 times 100, a double
// just under 29, cuts to 29. A step past the largest number is an infinity.
export function cutDecimal(n: number, digits: number, away: boolean): number {
    const power = POWERS_OF_TEN[Math.abs(digits)];
    if (power !== undefined) {
        const scaled = Math.abs(digits < 0 ? n / power : n * power);
        const whole = Math.floor(scaled);
        const margin = HALF_RATIO * scaled;
        if (scaled - whole > margin && whole + 1 - scaled > margin) {
            const kept = away ? whole + 1 : whole;
            if (kept === 0) return 0;
            const cut = digits < 0 ? kept * power : kept / power;
            return n < 0 ? -cut : cut;
        }
    }
    const decimal = decimal15(n);
    const drop = 14 - exponentOf(decimal) - digits;
    if (drop <= 0) return round15(n);
    // Past 15 digits nothing is kept: every 15 digit number is under 1e15.
    const unit = POWERS_OF_TEN[Math.min(drop, 15)];
    const shown = Number(digitsOf(decimal));
    const kept = Math.floor(shown / unit) + (away && shown % unit !== 0 ? 1 : 0);
    if (kept === 0) return 0;
    if (digits < -308) return n < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    return Number(`${n < 0 ? '-' : ''}${kept}e${-digits}`);
}
