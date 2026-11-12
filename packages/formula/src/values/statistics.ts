// The arithmetic the statistical functions share: how far numbers lie from their mean, the number at a place
// between two of a sorted list, and the rank of a number among others. Each takes plain lists of numbers that a
// function already collected, and answers a number. What a function makes of no number at all is its own.

// No number of an empty list.
export function mean(values: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[i];
    return sum / values.length;
}

export function squaredDeviations(values: Float64Array): number {
    return coDeviations(values, values);
}

// Both lists have one length.
export function coDeviations(xs: Float64Array, ys: Float64Array): number {
    const meanX = mean(xs);
    const meanY = mean(ys);
    let sum = 0;
    for (let i = 0; i < xs.length; i += 1) sum += (xs[i] - meanX) * (ys[i] - meanY);
    return sum;
}

// The number at a position from 0 that may lie between two places of a list that is sorted upward.
export function interpolated(sorted: Float64Array, position: number): number {
    const below = Math.floor(position);
    const part = position - below;
    return part === 0 ? sorted[below] : sorted[below] + part * (sorted[below + 1] - sorted[below]);
}

// The rank from 1 of a number among the others, counted from the largest or, ascending, from the smallest. Equal
// numbers take the first of their ranks, or share the mean of them. A number the list does not hold has rank 0.
export function rankAmong(values: Float64Array, value: number, ascending: boolean, shared: boolean): number {
    let ahead = 0;
    let ties = 0;
    for (let i = 0; i < values.length; i += 1) {
        if (values[i] === value) ties += 1;
        else if (values[i] < value === ascending) ahead += 1;
    }
    if (ties === 0) return 0;
    return shared ? ahead + (ties + 1) / 2 : ahead + 1;
}
