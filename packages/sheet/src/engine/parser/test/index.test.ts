import { expect } from 'bun:test';

function tolerance(precision?: number): number {
    if (precision === void 0 || precision === null) {
        precision = 7;
    }

    return 0.5 * 10 ** -precision;
}

// Custom matcher for close-to comparison. Both sides are expected to be plain
// objects with numeric-ish leaf values; the matcher compares them key-by-key
// with a numeric tolerance (see `tolerance()` above).
expect.extend({
    toBeMatchCloseTo(actual: unknown, expected: unknown, precision?: number) {
        const a = actual as Record<string, unknown>;
        const e = expected as Record<string, unknown>;
        let pass = false;

        for (const key of Object.keys(a)) {
            const av = a[key];
            const ev = e[key];

            if (av === ev || (Number.isNaN(av) && Number.isNaN(ev))) {
                pass = true;
            } else if (typeof av === 'number' && typeof ev === 'number' && Math.abs(av - ev) < tolerance(precision)) {
                pass = true;
            } else {
                pass = false;
            }
        }

        return {
            message: () => `Expected ${actual} to be closely equal to ${expected}`,
            pass,
        };
    },
});

// Type declaration for the custom matcher
declare module 'bun:test' {
    interface Matchers<T> {
        toBeMatchCloseTo(expected: T, precision?: number): T;
    }
}
