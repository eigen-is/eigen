import type { FormulaArg } from '../../types.ts';

// Convert a formula argument into a number. Matches Excel semantics: TRUE/FALSE
// become 1/0; null/undefined/arrays become undefined; unparseable strings surface
// as NaN so callers can propagate #VALUE! errors via `Number.isNaN(result)` checks.
// Arrays produce undefined because scalar operators coerce them to their `?? 0`
// fallback, matching the runtime path formulajs already handles internally.
export function toNumber(value: FormulaArg): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value !== 'string') return undefined;
    return value.indexOf('.') > -1 ? parseFloat(value) : parseInt(value, 10);
}

export function invertNumber(value: FormulaArg): number | undefined {
    const num = toNumber(value);
    return num !== undefined ? -1 * num : undefined;
}
