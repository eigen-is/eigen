import type { FormulaValue } from '../../types.ts';

// Convert a formula value into a number. Matches Excel semantics: TRUE/FALSE become
// 1/0; null/undefined become undefined; unparseable strings surface as NaN so callers
// can propagate #VALUE! errors via `Number.isNaN(result)` checks.
export function toNumber(value: FormulaValue): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return undefined;
    return value.indexOf('.') > -1 ? parseFloat(value) : parseInt(value, 10);
}

export function invertNumber(value: FormulaValue): number | undefined {
    const num = toNumber(value);
    return num !== undefined ? -1 * num : undefined;
}
