// Guards and readers for values that arrive untyped, such as a JSON body, a clipboard payload, an awareness state or
// an attribute a peer stored. They use no React and no DOM, so the server imports them too.

// Arrays are objects too, and every caller reads named fields: a forged `[]` payload would otherwise pass
// as a record and read `undefined` for all of them.
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A stored number held to a range, such as a size a peer wrote: a finite number past a bound reads as that bound, and
// anything else, NaN and the infinities included, reads as null.
export function readNumberIn(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}
