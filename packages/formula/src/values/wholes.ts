// The arithmetic of whole numbers that GCD, LCM and MULTINOMIAL do. Each number is cut to a whole one first, and a
// negative one, one past 2^53 or an answer past it is #NUM!: above that a number no longer tells its neighbours apart.

import type { FormulaError } from './errors';
import { NUM } from './errors';

const LARGEST = 2 ** 53;
// The largest number whose factorial a cell can hold.
const LARGEST_FACTORIAL = 170;

function divisor(a: number, b: number): number {
    let high = a;
    let low = b;
    while (low !== 0) [high, low] = [low, high % low];
    return high;
}

// The largest whole number that divides every one of `numbers`, and 0 of none.
export function greatestDivisor(numbers: readonly number[]): number | FormulaError {
    let found = 0;
    for (const number of numbers) {
        if (number < 0 || number > LARGEST) return NUM;
        found = divisor(found, Math.trunc(number));
    }
    return found;
}

// The smallest whole number that every one of `numbers` divides: 0 when one of them is 0, and 0 of none.
export function leastMultiple(numbers: readonly number[]): number | FormulaError {
    let found = numbers.length === 0 ? 0 : 1;
    for (const number of numbers) {
        if (number < 0 || number > LARGEST) return NUM;
        const whole = Math.trunc(number);
        found = whole === 0 || found === 0 ? 0 : (found / divisor(found, whole)) * whole;
        if (found > LARGEST) return NUM;
    }
    return found;
}

// In how many ways a set of as many things as the numbers add up to splits into groups of these sizes.
export function multinomial(numbers: readonly number[]): number | FormulaError {
    let total = 0;
    let ways = 1;
    for (const number of numbers) {
        if (number < 0) return NUM;
        const size = Math.trunc(number);
        if (total + size > LARGEST_FACTORIAL) return NUM;
        for (let k = 1; k <= size; k += 1) ways = (ways * (total + k)) / k;
        total += size;
    }
    return Math.round(ways);
}
