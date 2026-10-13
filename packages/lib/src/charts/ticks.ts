// Ported from d3-array 3.2 (ISC, Mike Bostock): src/ticks.js and src/nice.js, ascending domains only.

const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

// [first, last, increment] as integers: a negative increment is the inverse of a step below one, so
// the ticks are i / -inc and 0.1 + 0.2 never reaches a label.
function tickSpec(start: number, stop: number, count: number): [number, number, number] {
    const step = (stop - start) / Math.max(0, count);
    const power = Math.floor(Math.log10(step));
    const error = step / 10 ** power;
    const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
    let i1: number;
    let i2: number;
    let inc: number;
    if (power < 0) {
        inc = 10 ** -power / factor;
        i1 = Math.round(start * inc);
        i2 = Math.round(stop * inc);
        if (i1 / inc < start) ++i1;
        if (i2 / inc > stop) --i2;
        inc = -inc;
    } else {
        inc = 10 ** power * factor;
        i1 = Math.round(start / inc);
        i2 = Math.round(stop / inc);
        if (i1 * inc < start) ++i1;
        if (i2 * inc > stop) --i2;
    }
    if (i2 < i1 && 0.5 <= count && count < 2) return tickSpec(start, stop, count * 2);
    return [i1, i2, inc];
}

export function ticks(start: number, stop: number, count: number): number[] {
    if (!(count > 0)) return [];
    if (start === stop) return [start];
    const [i1, i2, inc] = tickSpec(start, stop, count);
    if (!(i2 >= i1)) return [];
    return Array.from({ length: i2 - i1 + 1 }, (_, i) => (inc < 0 ? (i1 + i) / -inc : (i1 + i) * inc));
}

function tickIncrement(start: number, stop: number, count: number): number {
    return tickSpec(start, stop, count)[2];
}

export function tickStep(start: number, stop: number, count: number): number {
    const inc = tickIncrement(start, stop, count);
    return inc < 0 ? 1 / -inc : inc;
}

// d3-scale's ten-step bound: d3-array's loop never settles for a small count on a domain across zero.
export function nice(start: number, stop: number, count: number): [number, number] {
    let prestep: number | undefined;
    for (let iteration = 0; iteration < 10; iteration++) {
        const step = tickIncrement(start, stop, count);
        if (step === prestep || step === 0 || !Number.isFinite(step)) return [start, stop];
        if (step > 0) {
            start = Math.floor(start / step) * step;
            stop = Math.ceil(stop / step) * step;
        } else {
            start = Math.ceil(start * step) / step;
            stop = Math.floor(stop * step) / step;
        }
        prestep = step;
    }
    return [start, stop];
}

// Intl caps fraction digits; a step this small has no readable labels anyway.
const MAX_FRACTION_DIGITS = 20;

// Canvas and docs ticks: as many decimals as the step has, so every tick reads alike ("0.5", "1.0").
export function formatTickValue(value: number, step: number): string {
    let digits = Math.max(0, -Math.floor(Math.log10(step)));
    while (digits < MAX_FRACTION_DIGITS && !Number.isInteger(Number((step * 10 ** digits).toPrecision(12)))) digits++;
    digits = Math.min(digits, MAX_FRACTION_DIGITS);
    return new Intl.NumberFormat('en', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: 'negative',
    }).format(value);
}

// A 100% stack's ticks, shares read as percents ("0%", "25%").
export function formatPercentTick(value: number, step: number): string {
    return `${formatTickValue(value * 100, step * 100)}%`;
}
