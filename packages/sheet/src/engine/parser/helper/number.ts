// How the formula engine reads a value as a number: a boolean as 1 or 0, a Date as its Excel serial, text by its digits.
// Operators and functions coerce through it, such as `*` and MATCH's match_type, and a Date result is stored as its
// serial through it.

import type { FormulaArg } from '../../types';

const DAY_MS = 86_400_000;
// Excel serial 1 is 1900-01-01, and serial 60 is the 1900-02-29 that never existed
// (the Lotus leap-year bug), so every date from 1900-03-01 on sits one day later.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 31);
const LOTUS_LEAP_MS = Date.UTC(1900, 2, 1);

// formulajs builds its Dates at local midnight, so the serial comes from the local calendar fields: west of Greenwich
// the UTC instant is the day before.
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

// A blank or an array has no number, so it gives undefined. An operator never gets an array, a function's scalar
// parameter may.
export function toNumber(value: FormulaArg | Date): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return dateToSerial(value);
    if (typeof value !== 'string') return undefined;
    // Number reads a blank text as 0, which no Excel function does.
    return value.trim() === '' ? Number.NaN : Number(value);
}

// The operand of `<`, `>`, `<=` and `>=`.
export function comparisonOperand(value: FormulaArg): number | string {
    const operand = value ?? 0;
    if (typeof operand === 'boolean') return operand ? 1 : 0;
    if (typeof operand !== 'object') return operand;

    const primitive = operand.valueOf();
    return typeof primitive === 'number' ? primitive : String(operand);
}
