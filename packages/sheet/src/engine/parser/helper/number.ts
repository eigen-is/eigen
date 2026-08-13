import type { FormulaArg } from '../../types';

// Excel epoch (1899-12-30 UTC). Matches the date-serial convention used elsewhere
// in the codebase (xlsx import, `datenum_local`) and accounts for the Lotus 1900
// leap-year bug. Used to coerce Date values into day-based serials so that date
// arithmetic — `EOMONTH(a,0) - EOMONTH(a,-1)` returning the days in a month — works
// the same as in Excel. Without this, formulajs's Date returns get fed into
// `Date - Date` via `valueOf()` and produce milliseconds, breaking templates that
// expect day counts.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

// Convert a formula argument into a number. Matches Excel semantics: TRUE/FALSE
// become 1/0; Date becomes its Excel serial (days since 1899-12-30);
// null/undefined/arrays become undefined; unparseable strings surface as NaN so
// callers can propagate #VALUE! errors via `Number.isNaN(result)` checks. Arrays
// produce undefined because scalar operators coerce them to their `?? 0` fallback,
// matching the runtime path formulajs already handles internally.
export function toNumber(value: FormulaArg | Date): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return (value.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
    if (typeof value !== 'string') return undefined;
    // Empty/whitespace stays NaN (not Number's 0) so `""+1` propagates #VALUE!.
    return value.trim() === '' ? Number.NaN : Number(value);
}

export function invertNumber(value: FormulaArg): number | undefined {
    const num = toNumber(value);
    return num !== undefined ? -1 * num : undefined;
}
