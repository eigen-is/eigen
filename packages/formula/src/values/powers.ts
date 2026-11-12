// Powers and roots, for the ^ operator, POWER and GEOMEAN. A whole power and the root of a product are worked out
// in twice the digits a number holds, so the answer is the nearest number to the exact one on every machine,
// where the machine's own power differs in its last digit from one to the next. A wide number is three numbers
// in a Float64Array: a value, what that value lost in rounding, and a count of binary places that keeps the value
// away from the largest and the smallest number.

import type { FormulaError } from './errors';
import { DIV0, NUM } from './errors';
import { equal15 } from './precision';

// A negative base has no power from this whole exponent on. Excel's own limit lies above 2^31, where (-1)^(2^31)
// is 1, and at or under 2^49, where it is #NUM!.
const MOST_TIMES = 2 ** 49;

// A wide value outside these two is moved by STEP binary places.
const STEP = 600;
const HIGH = 2 ** 300;
const LOW = 2 ** -300;
const UP = 2 ** STEP;
const DOWN = 2 ** -STEP;

// Splits a number into two halves of 26 bits, whose products are exact.
const SPLIT = 2 ** 27 + 1;

// A negative base has a power for a whole exponent and for an odd root, as (-8)^(1/3) is -2. A result too large
// is #DIV/0! when the exponent is negative, as dividing by a power that came out 0.
export function power(base: number, exponent: number): number | FormulaError {
    if (base === 0) return exponent === 0 ? NUM : exponent < 0 ? DIV0 : 0;
    let result: number;
    if (Number.isInteger(exponent)) {
        if (base < 0 && Math.abs(exponent) >= MOST_TIMES) return NUM;
        result = wholePower(base, exponent);
    } else if (base < 0) {
        const root = Math.round(1 / exponent);
        if (Math.abs(root % 2) !== 1 || !equal15(1 / exponent, root)) return NUM;
        result = -((-base) ** exponent);
    } else result = base ** exponent;
    return Number.isFinite(result) || exponent > 0 ? result : DIV0;
}

// The root of the product of numbers above 0, as many times as there are numbers: their geometric mean. The
// logarithms give it to twelve digits or so, and the product itself against that estimate raised says by how
// much it is off.
export function rootOfProduct(values: Float64Array): number {
    const product = Float64Array.of(1, 0, 0);
    const factor = new Float64Array(3);
    let logarithms = 0;
    for (let i = 0; i < values.length; i += 1) {
        logarithms += Math.log(values[i]);
        widen(factor, values[i]);
        multiply(product, factor);
    }
    const estimate = Math.exp(logarithms / values.length);
    widen(factor, estimate);
    const raised = raise(factor, values.length);
    const level = 2 ** (product[2] - raised[2]);
    const off = (product[0] * level - raised[0] + (product[1] * level - raised[1])) / raised[0];
    return estimate + (estimate * off) / values.length;
}

function wholePower(base: number, exponent: number): number {
    const wide = new Float64Array(3);
    widen(wide, base);
    const [value, rest, places] = raise(wide, Math.abs(exponent));
    if (exponent >= 0) return narrow(value, places);
    // One over a wide value: the quotient, and what the division left.
    const quotient = 1 / value;
    const back = quotient * value;
    return narrow(quotient + quotient * (1 - back - lost(quotient, value, back) - quotient * rest), -places);
}

// `wide` multiplied by itself a whole number of times, by squaring; `wide` is used up.
function raise(wide: Float64Array, times: number): Float64Array {
    const result = Float64Array.of(1, 0, 0);
    for (let left = times; left > 0; left = Math.floor(left / 2)) {
        if (left % 2 === 1) multiply(result, wide);
        if (left > 1) multiply(wide, wide);
    }
    return result;
}

// Multiplies `wide` by `factor`, which may be `wide` itself.
function multiply(wide: Float64Array, factor: Float64Array): void {
    const product = wide[0] * factor[0];
    const rest = wide[0] * factor[1] + wide[1] * factor[0] + lost(wide[0], factor[0], product);
    const value = product + rest;
    const size = Math.abs(value);
    const moved = size > HIGH ? DOWN : size < LOW ? UP : 1;
    wide[2] += factor[2] + (size > HIGH ? STEP : size < LOW ? -STEP : 0);
    wide[0] = value * moved;
    wide[1] = (rest - (value - product)) * moved;
}

function widen(wide: Float64Array, value: number): void {
    const size = Math.abs(value);
    wide[0] = size > HIGH ? value * DOWN : size < LOW ? value * UP : value;
    wide[1] = 0;
    wide[2] = size > HIGH ? STEP : size < LOW ? -STEP : 0;
}

// The number a wide value stands for: an infinity when it is too large, 0 or next to it when too small.
function narrow(value: number, places: number): number {
    let result = value;
    for (let left = places; left !== 0 && result !== 0 && result - result === 0; left -= Math.sign(left) * STEP) {
        result *= left > 0 ? UP : DOWN;
    }
    return result;
}

// What a * b lost when it was rounded to `product`.
function lost(a: number, b: number, product: number): number {
    const scaledA = SPLIT * a;
    const highA = scaledA - (scaledA - a);
    const lowA = a - highA;
    const scaledB = SPLIT * b;
    const highB = scaledB - (scaledB - b);
    const lowB = b - highB;
    return highA * highB - product + highA * lowB + lowA * highB + lowA * lowB;
}
