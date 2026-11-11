// Criteria, as COUNTIF, SUMIFS and their kin take them. A criterion is read once per call: an operator in front if
// there is one, and an operand typed the way a cell entry is. `tally` then walks the criteria ranges row by row
// over the planes of their columns, stops at the first criterion a cell fails, and keeps the count of the cells
// that met them all and the numbers beside those. An equality criterion on a column that has an index gives the
// rows to walk, so the rest are never read.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { ColumnIndex, firstFrom } from '../store/column-index';
import type { StringTable } from '../store/strings';
import type { FormulaError } from '../values/errors';
import { errorOf } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import { compare15, equal15 } from '../values/precision';
import { compareText, textKey } from '../values/text-order';
import type { Reference } from '../values/value';
import { isError } from '../values/value';
import type { Pattern } from '../values/wildcard';
import { patternMatches, patternOf } from '../values/wildcard';
import type { Evaluator } from './evaluator';
import type { Held } from './signature';

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

function criterionOf(strings: StringTable, value: Held): Criterion {
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

export type Tally = {
    // The cells that met every criterion.
    count: number;
    // The numbers beside them, row by row: the first `found` of `numbers`.
    numbers: Float64Array;
    found: number;
    // The first error beside them, which is then the result of the call.
    error: FormulaError | null;
};

// Walks `ranges`, which are of one size and computed, each against its criterion, into `tally`. `values` is the
// range of that size whose numbers are kept beside the cells that match, or null for none.
export function tally(
    ctx: Evaluator,
    ranges: readonly Reference[],
    criteria: readonly Held[],
    values: Reference | null,
    into: Tally,
): void {
    const { strings, sheets } = ctx.workbook;
    const rows = ranges[0].bottom - ranges[0].top + 1;
    const width = ranges[0].right - ranges[0].left + 1;
    const read = criteria.map((criterion) => criterionOf(strings, criterion));
    const blanks = read.map((criterion) => meets(criterion, strings, CellKind.Empty, 0, 0));
    const open = !blanks.includes(false);
    into.count = 0;
    into.found = 0;
    into.error = null;
    // Per column, then per criterion: the column it is checked in and how many of its rows hold a cell.
    const columns: (Column | undefined)[] = [];
    const used: number[] = [];
    const counted: (Column | undefined)[] = [];
    // Per column, the row from which no cell can change the outcome: with a criterion that refuses a blank none
    // matches from there on, and without one every cell does and holds no number.
    const stops: number[] = [];
    let last = 0;
    for (let across = 0; across < width; across += 1) {
        const value = values === null ? undefined : sheets[values.sheet].columns[values.left + across];
        counted[across] = value;
        let stop = open
            ? value === undefined || values === null
                ? 0
                : Math.min(value.length - values.top, rows)
            : rows;
        for (let i = 0; i < read.length; i += 1) {
            const column = sheets[ranges[i].sheet].columns[ranges[i].left + across];
            const held = column === undefined ? 0 : Math.max(0, Math.min(column.length - ranges[i].top, rows));
            columns[across * read.length + i] = column;
            used[across * read.length + i] = held;
            if (open) stop = Math.max(stop, held);
            else if (!blanks[i]) stop = Math.min(stop, held);
        }
        stops[across] = Math.max(stop, 0);
        last = Math.max(last, stops[across]);
        if (open) into.count += rows - stops[across];
    }
    // Of one column an equality criterion can list its rows, and the shortest list is the one walked.
    let driver = -1;
    let listed: readonly number[] | null = null;
    for (let i = 0; width === 1 && i < read.length; i += 1) {
        const criterion = read[i];
        const exact = criterion.op === Op.Equal && criterion.pattern === null && !blanks[i];
        const column = columns[i];
        if (column === undefined || !exact || criterion.kind === CellKind.Error) continue;
        const found = ColumnIndex.rows(column, strings, criterion.kind, criterion.num, criterion.ref);
        if (found !== null && (listed === null || found.length < listed.length)) {
            listed = found;
            driver = i;
        }
    }
    let at = listed === null ? 0 : firstFrom(listed, ranges[driver].top);
    const end = listed === null ? last : listed.length;
    for (; at < end; at += 1) {
        const offset = listed === null ? at : listed[at] - ranges[driver].top;
        if (offset >= last) break;
        for (let across = 0; across < width; across += 1) {
            if (offset >= stops[across]) continue;
            let i = 0;
            for (; i < read.length; i += 1) {
                if (i === driver) continue;
                const column = columns[across * read.length + i];
                const row = ranges[i].top + offset;
                if (column === undefined || offset >= used[across * read.length + i]) {
                    if (!blanks[i]) break;
                } else if (!meets(read[i], strings, column.kind[row] & KIND_MASK, column.num[row], column.ref[row]))
                    break;
            }
            if (i < read.length) continue;
            into.count += 1;
            const value = counted[across];
            const row = (values?.top ?? 0) + offset;
            if (value === undefined || row >= value.length) continue;
            const kind = value.kind[row] & KIND_MASK;
            if (kind === CellKind.Error) {
                into.error = ctx.workbook.error(value.ref[row]);
                return;
            }
            if (kind !== CellKind.Number) continue;
            if (into.found === into.numbers.length) {
                const longer = new Float64Array(into.found * 2);
                longer.set(into.numbers);
                into.numbers = longer;
            }
            into.numbers[into.found++] = value.num[row];
        }
    }
}
