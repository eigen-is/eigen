// Adding one number to a sum many times over, as an aggregate must for a stretch of equal elements of an array,
// such as the million blank rows under a column's cells. The answer is the one a loop of single additions gives,
// bit for bit, in a few steps: while the sum stays between two powers of two, every addition rounds the same way.

// `start` after `value` was added to it `times` times, one addition at a time.
export function repeated(start: number, value: number, times: number): number {
    let sum = start;
    let left = times;
    while (left > 0) {
        const once = sum + value;
        if (once === sum) return once;
        const twice = once + value;
        const step = twice - once;
        const size = Math.abs(sum);
        // The power of two at or under the sum: the logarithm can be off by one, which the comparisons mend.
        let low = size === 0 ? 0 : 2 ** Math.floor(Math.log2(size));
        if (low > size) low /= 2;
        else if (low * 2 <= size) low *= 2;
        const reached = Math.abs(twice);
        // Two equal steps that stay between the same powers of two, on the same side of zero, are the step of
        // every addition up to the next power: there the spacing of doubles changes, so that one is made singly.
        if (once - sum === step && reached >= low && reached < 2 * low && twice > 0 === sum > 0) {
            const span = reached > size ? 2 * low - size : size - low;
            const steps = Math.min(left, Math.ceil(span / Math.abs(step)) - 1);
            sum += steps * step;
            left -= steps;
        } else {
            sum = once;
            left -= 1;
        }
    }
    return sum;
}
