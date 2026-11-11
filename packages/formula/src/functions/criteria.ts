// Criteria, as COUNTIF, SUMIFS and their kin take them. A criterion is read once per call: an operator in front if
// there is one, and an operand typed the way a cell entry is. `tally` then walks the rows of the criteria ranges
// over the planes of their columns, stops at the first criterion a row fails, and keeps what every function of the
// family returns. An equality criterion on a column that has an index gives the rows to walk, so the rest are
// never read.

import type { Evaluator } from '../eval/evaluator';
import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { ColumnIndex, firstFrom } from '../store/column-index';
import type { StringTable } from '../store/strings';
import type { FormulaError } from '../values/errors';
import { errorOf, VALUE } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import { compare15, equal15 } from '../values/precision';
import { compareText, textKey } from '../values/text-order';
import type { Reference, Value } from '../values/value';
import { isError, isReference, OMITTED } from '../values/value';
import type { Pattern } from '../values/wildcard';
import { patternMatches, patternOf } from '../values/wildcard';

const Op = { Equal: 0, NotEqual: 1, Less: 2, LessEqual: 3, Greater: 4, GreaterEqual: 5 } as const;

const LESS = 60;
const EQUALS = 61;
const GREATER = 62;
const HASH = 35;

type Criterion = {
    readonly op: number;
    // The kind of cell the operand would be, and Empty for an operand of no characters.
    readonly kind: number;
    readonly num: number;
    // For a text the id of its upper-cased form, or -1 when no cell holds it; 1 for TRUE; the code of an error.
    readonly ref: number;
    // The upper-cased form of a text operand.
    readonly key: string;
    // Set for a text with a wildcard in it.
    readonly pattern: Pattern | null;
    // The criterion "" takes a blank cell beside a cell of empty text.
    readonly orBlank: boolean;
};

function criterionOf(strings: StringTable, value: Value): Criterion {
    let op: number = Op.Equal;
    let kind: number = CellKind.Number;
    let num = 0;
    let ref = 0;
    let key = '';
    let pattern: Pattern | null = null;
    let orBlank = false;
    if (typeof value === 'number') num = value;
    else if (typeof value === 'boolean') {
        kind = CellKind.Boolean;
        ref = value ? 1 : 0;
    } else if (isError(value)) {
        kind = CellKind.Error;
        ref = value.code;
    } else if (typeof value === 'string') {
        const first = value.charCodeAt(0);
        const second = value.charCodeAt(1);
        let from = 0;
        if (first === EQUALS) from = 1;
        else if (first === LESS) {
            op = second === GREATER ? Op.NotEqual : second === EQUALS ? Op.LessEqual : Op.Less;
            from = op === Op.Less ? 1 : 2;
        } else if (first === GREATER) {
            op = second === EQUALS ? Op.GreaterEqual : Op.Greater;
            from = op === Op.Greater ? 1 : 2;
        }
        const operand = value.slice(from);
        const number = parseNumber(operand);
        key = textKey(operand);
        const error = key.charCodeAt(0) === HASH ? errorOf(key) : null;
        if (number !== undefined) num = number;
        else if (key === 'TRUE' || key === 'FALSE') {
            kind = CellKind.Boolean;
            ref = key === 'TRUE' ? 1 : 0;
        } else if (error !== null && error.code !== 0) {
            kind = CellKind.Error;
            ref = error.code;
        } else if (operand === '' && from > 0) kind = CellKind.Empty;
        else {
            kind = CellKind.Text;
            orBlank = operand === '';
            if (op <= Op.NotEqual) {
                const read = patternOf(key);
                if (read.literal === null) pattern = read;
                else key = read.literal;
            }
            if (pattern === null) ref = strings.find(key);
        }
    }
    return { op, kind, num, ref, key, pattern, orBlank };
}

// Whether a cell, given as what its column holds for it, meets the criterion.
function meets(criterion: Criterion, strings: StringTable, kind: number, num: number, ref: number): boolean {
    const { op } = criterion;
    let order = 0;
    switch (criterion.kind) {
        case CellKind.Number:
            if (kind === CellKind.Number) order = compare15(num, criterion.num);
            else if (kind === CellKind.Text && op === Op.Equal) {
                const read = strings.number(ref);
                return read !== null && equal15(read, criterion.num);
            } else return op === Op.NotEqual;
            break;
        case CellKind.Text:
            if (kind !== CellKind.Text) return op === Op.NotEqual || (criterion.orBlank && kind === CellKind.Empty);
            if (criterion.pattern !== null) {
                return patternMatches(criterion.pattern, strings.text(strings.upper(ref))) === (op === Op.Equal);
            }
            if (op <= Op.NotEqual) return (strings.upper(ref) === criterion.ref) === (op === Op.Equal);
            order = compareText(strings.text(strings.upper(ref)), criterion.key);
            break;
        case CellKind.Boolean:
            if (kind !== CellKind.Boolean) return op === Op.NotEqual;
            order = ref - criterion.ref;
            break;
        case CellKind.Error:
            return op <= Op.NotEqual && (kind === CellKind.Error && ref === criterion.ref) === (op === Op.Equal);
        default:
            return op <= Op.NotEqual && (kind === CellKind.Empty) === (op === Op.Equal);
    }
    switch (op) {
        case Op.Equal:
            return order === 0;
        case Op.NotEqual:
            return order !== 0;
        case Op.Less:
            return order < 0;
        case Op.LessEqual:
            return order <= 0;
        case Op.Greater:
            return order > 0;
        default:
            return order >= 0;
    }
}

type Tally = {
    // The error that is the result of the call, when there is one.
    error: FormulaError | null;
    // The cells that met every criterion, and among the cells counted beside them the numbers.
    matched: number;
    numbers: number;
    sum: number;
    min: number;
    max: number;
};

function area(value: Value): Reference | FormulaError {
    if (isReference(value)) return value.next === null ? value : VALUE;
    return isError(value) ? value : VALUE;
}

// `pairs` is a range, its criterion, the next range, its criterion, and so on. `counted` is the range whose numbers
// are added up beside the cells that match, or null for none. With `resize` it is only where that range starts: it
// takes the shape of the criteria range, and left out it is the criteria range.
export function tally(ctx: Evaluator, pairs: readonly Value[], counted: Value | null, resize: boolean): Tally {
    const { strings } = ctx.workbook;
    const total: Tally = { error: VALUE, matched: 0, numbers: 0, sum: 0, min: Infinity, max: -Infinity };
    if (pairs.length % 2 !== 0) return total;
    let values: Reference | null = null;
    if (counted !== null && !(resize && counted === OMITTED)) {
        const given = area(counted);
        if (!isReference(given)) return { ...total, error: given };
        values = given;
    }
    const ranges: Reference[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
        const range = area(pairs[i]);
        if (!isReference(range)) return { ...total, error: range };
        const fits = values === null || resize ? (ranges[0] ?? range) : values;
        if (range.bottom - range.top !== fits.bottom - fits.top || range.right - range.left !== fits.right - fits.left)
            return total;
        ranges.push(range);
    }
    const rows = ranges[0].bottom - ranges[0].top + 1;
    const width = ranges[0].right - ranges[0].left + 1;
    if (counted === OMITTED) values = ranges[0];
    else if (values !== null && resize) {
        values = { ...values, bottom: values.top + rows - 1, right: values.left + width - 1 };
    }
    // Every formula in the ranges is computed before a criterion is read or a cell looked at: a text is known by
    // its id only once a cell holds it, and no formula may run while an index is in use.
    for (const range of ranges) ctx.recalc.settleArea(range);
    if (values !== null) ctx.recalc.settleArea(values);
    const criteria: Criterion[] = [];
    const blanks: boolean[] = [];
    for (let i = 1; i < pairs.length; i += 2) {
        const criterion = criterionOf(strings, pairs[i]);
        criteria.push(criterion);
        blanks.push(meets(criterion, strings, CellKind.Empty, 0, 0));
    }

    total.error = null;
    const open = !blanks.includes(false);
    // The columns are walked one by one, and a sum is added row by row: of a range of several columns the numbers
    // are kept with their rows, and so is the row of the first error.
    const kept: number[] = [];
    const keptRows: number[] = [];
    let errorRow = rows;
    const columns: (Column | undefined)[] = [];
    const used: number[] = [];
    for (let across = 0; across < width; across += 1) {
        const value = values === null ? undefined : ctx.workbook.sheets[values.sheet].columns[values.left + across];
        const valueTop = values?.top ?? 0;
        const valueUsed = value === undefined ? 0 : Math.min(value.length - valueTop, rows);
        // Rows from `stop` on hold no cell that can change the outcome: with a criterion that refuses a blank none
        // of them matches, and without one every one of them does.
        let stop = open ? valueUsed : rows;
        let driver = -1;
        let listed: readonly number[] | null = null;
        for (let i = 0; i < criteria.length; i += 1) {
            const { top, left, sheet } = ranges[i];
            const column = ctx.workbook.sheets[sheet].columns[left + across];
            const criterion = criteria[i];
            columns[i] = column;
            used[i] = column === undefined ? 0 : Math.min(column.length - top, rows);
            if (open) stop = Math.max(stop, used[i]);
            else if (!blanks[i]) stop = Math.min(stop, used[i]);
            const exact = criterion.op === Op.Equal && criterion.pattern === null && !blanks[i];
            if (column === undefined || !exact || criterion.kind === CellKind.Error) continue;
            const found = ColumnIndex.rows(column, strings, criterion.kind, criterion.num, criterion.ref);
            if (found !== null && (listed === null || found.length < listed.length)) {
                listed = found;
                driver = i;
            }
        }
        let at = listed === null ? 0 : firstFrom(listed, ranges[driver].top);
        const end = listed === null ? stop : listed.length;
        for (; at < end; at += 1) {
            const offset = listed === null ? at : listed[at] - ranges[driver].top;
            if (offset >= stop) break;
            let i = 0;
            for (; i < criteria.length; i += 1) {
                if (i === driver) continue;
                const column = columns[i];
                const row = ranges[i].top + offset;
                if (column === undefined || offset >= used[i]) {
                    if (!blanks[i]) break;
                } else if (!meets(criteria[i], strings, column.kind[row] & KIND_MASK, column.num[row], column.ref[row]))
                    break;
            }
            if (i < criteria.length) continue;
            total.matched += 1;
            if (value === undefined || offset >= valueUsed) continue;
            const row = valueTop + offset;
            const kind = value.kind[row] & KIND_MASK;
            if (kind === CellKind.Number) {
                const number = value.num[row];
                total.numbers += 1;
                if (width === 1) total.sum += number;
                else {
                    kept.push(number);
                    keptRows.push(offset);
                }
                if (number < total.min) total.min = number;
                if (number > total.max) total.max = number;
            } else if (kind === CellKind.Error && offset < errorRow) {
                total.error = ctx.workbook.error(value.ref[row]);
                errorRow = offset;
                if (width === 1) return total;
            }
        }
        if (open) total.matched += rows - Math.max(stop, 0);
    }
    const order = keptRows.map((_, at) => at).sort((a, b) => keptRows[a] - keptRows[b]);
    for (const at of order) total.sum += kept[at];
    return total;
}
