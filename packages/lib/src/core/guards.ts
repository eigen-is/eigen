// Narrowing guards for values that arrive untyped — a JSON body, a clipboard payload, an awareness state.

// Arrays are objects too, and every caller reads named fields: a forged `[]` payload would otherwise pass
// as a record and read `undefined` for all of them.
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
