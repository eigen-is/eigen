// A sheet's data-validation rules where they enter a workbook, such as a decoded snapshot and a collaborator's write:
// the shape check and the caps every reader of a rule trusts. A peer can store anything under an id, so an entry that
// is not well formed, or past a cap, is left out where it arrives. It also holds the range helpers the writers and
// the readers of rules share, such as the coalescing of a rule's ranges and the order of rule ids.

import { isRecord } from '../core/guards';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from './defaults';
import type { DataValidationRule, SheetValidation, SingleRange } from './types';

// The most ranges one rule holds. Excel applies a rule to a selection, which holds at most 2,048 ranges, and the
// largest rule in our xlsx corpus has 1,024. The editor's cuts split a range into up to four, so the cap leaves room
// for four times Excel's. It bounds what one write of a rule costs every tab.
export const MAX_VALIDATION_RANGES = 4 * 2048;

// The most rules one sheet holds. The sheet in our xlsx corpus with the most has 16. With the range cap it bounds what
// a reader that walks every rule pays, such as the export, which cuts each rule out of the cells of every higher one.
export const MAX_VALIDATIONS = 1024;

// The type each field of a rule holds. Typed against the rule, so a field added to it fails the build until it is
// checked here too.
const RULE_FIELDS: Record<keyof DataValidationRule, 'string' | 'boolean'> = {
    type: 'string',
    type2: 'string',
    value1: 'string',
    value2: 'string',
    hintShow: 'boolean',
    hintValue: 'string',
    prohibitInput: 'boolean',
    rangeTxt: 'string',
    validity: 'string',
    remote: 'boolean',
};
const REQUIRED_RULE_FIELDS: ReadonlySet<string> = new Set<keyof DataValidationRule>([
    'type',
    'type2',
    'value1',
    'value2',
]);

export function isSheetValidation(value: unknown): value is SheetValidation {
    if (!isRecord(value)) return false;
    const { ranges, rule } = value;
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_VALIDATION_RANGES || !isRecord(rule)) {
        return false;
    }
    return (
        ranges.every(
            (range) =>
                isRecord(range) &&
                isSpan(range['row'], REFERENCE_ROW_COUNT) &&
                isSpan(range['column'], REFERENCE_COLUMN_COUNT),
        ) &&
        Object.entries(RULE_FIELDS).every(
            ([field, kind]) =>
                typeof rule[field] === kind || (rule[field] === undefined && !REQUIRED_RULE_FIELDS.has(field)),
        )
    );
}

export function isSheetValidations(value: unknown): value is Record<string, SheetValidation> {
    if (!isRecord(value)) return false;
    const entries = Object.values(value);
    return entries.length <= MAX_VALIDATIONS && entries.every(isSheetValidation);
}

// A sheet's entries without the ones that are not well formed, and past MAX_VALIDATIONS without the highest ids. A map
// whose every entry is well formed comes back as the same object, so normalizing a draft sheet writes nothing.
export function wellFormedValidations(value: unknown): Record<string, SheetValidation> {
    if (isSheetValidations(value)) return value;
    if (!isRecord(value)) return {};
    const entries = Object.entries(value).filter((entry): entry is [string, SheetValidation] =>
        isSheetValidation(entry[1]),
    );
    entries.sort(([a], [b]) => compareValidationIds(a, b));
    return Object.fromEntries(entries.slice(0, MAX_VALIDATIONS));
}

// The order of rule ids, for the rule that wins a cell two rules cover: the highest id. A longer id is higher, and
// ids of one length compare by their characters. So of the rules an import numbers in the file's order, the last one
// wins.
export function compareValidationIds(a: string, b: string): number {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

// The same cells in fewer ranges. Two ranges of one width join where they touch or overlap, first down the rows,
// then across the columns, so a duplicate goes too. One cell pasted down a column lands a range per row, and they
// become one range.
export function coalescedRanges(ranges: readonly SingleRange[]): SingleRange[] {
    return mergedAlong(mergedAlong(ranges, 'row'), 'column');
}

export function rangesOverlap(a: SingleRange, b: SingleRange): boolean {
    return a.row[0] <= b.row[1] && b.row[0] <= a.row[1] && a.column[0] <= b.column[1] && b.column[0] <= a.column[1];
}

function isSpan(span: unknown, count: number): boolean {
    return (
        Array.isArray(span) &&
        span.length === 2 &&
        span.every((end) => Number.isInteger(end) && end >= 0 && end < count) &&
        span[0] <= span[1]
    );
}

// Ranges sorted by their span across the axis, then joined along it where one span repeats and the runs touch.
function mergedAlong(ranges: readonly SingleRange[], axis: 'row' | 'column'): SingleRange[] {
    const across = axis === 'row' ? 'column' : 'row';
    const sorted = [...ranges].sort(
        (a, b) => a[across][0] - b[across][0] || a[across][1] - b[across][1] || a[axis][0] - b[axis][0],
    );
    const merged: SingleRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        const sameSpan = last && last[across][0] === range[across][0] && last[across][1] === range[across][1];
        if (!sameSpan || range[axis][0] > last[axis][1] + 1) {
            merged.push(range);
            continue;
        }
        if (range[axis][1] <= last[axis][1]) continue;
        const run = [last[axis][0], range[axis][1]];
        merged[merged.length - 1] = axis === 'row' ? { row: run, column: last.column } : { row: last.row, column: run };
    }
    return merged;
}
