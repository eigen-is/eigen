import type { FormulaArg } from '../../types';

const DAY_MS = 86_400_000;
// Excel serial 1 is 1900-01-01, and serial 60 is the 1900-02-29 that never existed
// (the Lotus leap-year bug), so every date from 1900-03-01 on sits one day later.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 31);
const LOTUS_LEAP_MS = Date.UTC(1900, 2, 1);

// The one Date-to-serial conversion. formulajs builds its Dates in LOCAL time (DATE(2026,1,5)
// is local midnight), so the serial is taken from the local calendar fields, never from the
// UTC instant — west of Greenwich that instant belongs to the previous day.
export function dateToSerial(value: Date): number {
    const local = Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
    );
    return (local - EXCEL_EPOCH_MS + (local >= LOTUS_LEAP_MS ? DAY_MS : 0)) / DAY_MS;
}

// Arrays produce undefined because scalar operators coerce them to their `?? 0` fallback,
// matching the runtime path formulajs already handles internally.
export function toNumber(value: FormulaArg | Date): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return dateToSerial(value);
    if (typeof value !== 'string') return undefined;
    // Empty/whitespace stays NaN (not Number's 0) so `""+1` propagates #VALUE!.
    return value.trim() === '' ? Number.NaN : Number(value);
}

export function invertNumber(value: FormulaArg): number | undefined {
    const num = toNumber(value);
    return num !== undefined ? -1 * num : undefined;
}

// Operand of an ordering comparison (`<`, `>`, `<=`, `>=`); Excel's real ordering rules (SHEETS-TODO Q2) land here.
export function comparisonOperand(value: FormulaArg): number | string {
    const operand = value ?? 0;
    if (typeof operand === 'boolean') return operand ? 1 : 0;
    if (typeof operand !== 'object') return operand;

    const primitive = operand.valueOf();
    return typeof primitive === 'number' ? primitive : String(operand);
}
