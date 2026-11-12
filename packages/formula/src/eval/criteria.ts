// Criteria, as COUNTIF, SUMIFS and their kin take them. A criterion is read once per call: an operator in front if
// there is one, and an operand typed the way a cell entry is. A tally then walks the criteria ranges row by row
// over the planes of their columns, stops at the first criterion a cell fails, and keeps the count of the cells
// that met them all and the numbers beside those. A row costs the columns that reach it, and the blank cells under
// them are counted without a visit. An equality criterion on a column that has an index gives the rows to walk.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { ColumnIndex, firstFrom } from '../store/column-index';
import type { StringTable } from '../store/strings';
import { EQUALS, GREATER, HASH, LESS } from '../text/chars';
import { spelledBoolean } from '../values/coerce';
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
import { Reach } from './walk';

const Op = { Equal: 0, NotEqual: 1, Less: 2, LessEqual: 3, Greater: 4, GreaterEqual: 5 } as const;

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
        // An operand is typed the way a cell entry is, so one that spells a boolean matches booleans and no text.
        const truth = spelledBoolean(operand);
        if (number !== undefined) num = number;
        else if (truth !== undefined) {
            kind = CellKind.Boolean;
            ref = truth ? 1 : 0;
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

// What the criteria of a call matched, with the lists it is worked out in. There is one per level of calls, used
// again by every call, so a criteria function allocates nothing but its criteria as read.
export class Tally {
    // The cells that met every criterion.
    public count = 0;
    // The numbers beside them, row by row: the first `found` of `numbers`.
    public numbers = new Float64Array(8);
    public found = 0;
    // The first error beside them, which is then the result of the call.
    public error: FormulaError | null = null;
    // The criteria ranges of the call, each with its criterion: the call wrapper writes them.
    public readonly ranges: Reference[] = [];
    public readonly criteria: Held[] = [];
    // Per criterion: as it is read, and whether a blank cell meets it.
    private readonly read: Criterion[] = [];
    private readonly blanks: boolean[] = [];
    // Per column, then per criterion: the column it is checked in and how many of its rows hold a cell.
    private readonly columns: (Column | undefined)[] = [];
    private readonly used: number[] = [];
    // Per column: the column of the numbers, and the row from which no cell can change the outcome. With a
    // criterion that refuses a blank none matches from there on, and without one every cell does and holds no number.
    private readonly counted: (Column | undefined)[] = [];
    private readonly stops: number[] = [];
    // The columns that are not past that row yet, at the row the walk is at.
    private readonly reach = new Reach();

    // Walks the first `pairs` of the ranges, which are of one size and computed, each against its criterion.
    // `values` is the range of that size whose numbers are kept beside the cells that match, or null for none.
    public walk(ctx: Evaluator, pairs: number, values: Reference | null): void {
        const { ranges, criteria, read, blanks, columns, used, counted, stops, reach } = this;
        const { strings, sheets } = ctx.workbook;
        const rows = ranges[0].bottom - ranges[0].top + 1;
        const width = ranges[0].right - ranges[0].left + 1;
        // Whether a blank cell meets every criterion.
        let open = true;
        for (let i = 0; i < pairs; i += 1) {
            read[i] = criterionOf(strings, criteria[i]);
            blanks[i] = meets(read[i], strings, CellKind.Empty, 0, 0);
            open &&= blanks[i];
        }
        this.count = 0;
        this.found = 0;
        this.error = null;
        let last = 0;
        reach.clear(width);
        for (let across = 0; across < width; across += 1) {
            const value = values === null ? undefined : sheets[values.sheet].columns[values.left + across];
            counted[across] = value;
            let stop = open
                ? value === undefined || values === null
                    ? 0
                    : Math.min(value.length - values.top, rows)
                : rows;
            for (let i = 0; i < pairs; i += 1) {
                const column = sheets[ranges[i].sheet].columns[ranges[i].left + across];
                const held = column === undefined ? 0 : Math.max(0, Math.min(column.length - ranges[i].top, rows));
                columns[across * pairs + i] = column;
                used[across * pairs + i] = held;
                if (open) stop = Math.max(stop, held);
                else if (!blanks[i]) stop = Math.min(stop, held);
            }
            stops[across] = Math.max(stop, 0);
            reach.add(across, stops[across]);
            last = Math.max(last, stops[across]);
            if (open) this.count += rows - stops[across];
        }
        // Of one column an equality criterion can list its rows, and the shortest list is the one walked.
        let driver = -1;
        let listed: readonly number[] | null = null;
        for (let i = 0; width === 1 && i < pairs; i += 1) {
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
        // Cells are walked row by row. Of one column all rows are one band, so the loop over its rows is the inner
        // one, which is what a criteria function costs; of several columns every row is a band of its own.
        const first = listed === null ? 0 : ranges[driver].top;
        const top = values === null ? 0 : values.top;
        const end = listed === null ? last : listed.length;
        const band = width === 1 ? Math.max(end, 1) : 1;
        const reaching = reach.columns;
        let { numbers } = this;
        let count = this.count;
        let found = 0;
        let live = reach.count;
        let from = listed === null ? 0 : firstFrom(listed, first);
        while (from < end) {
            // Where a column ends, the ones that go on move up in the lists, so a row costs the columns it has.
            // The rows up to the next such end are walked in a loop of their own, which calls nothing.
            let until = end;
            if (listed === null) {
                live = reach.cut(from);
                if (width > 1) until = Math.min(end, reach.shortest);
                for (let across = 0; across < live; across += 1) {
                    const was = reaching[across];
                    reaching[across] = across;
                    stops[across] = stops[was];
                    counted[across] = counted[was];
                    for (let i = 0; i < pairs; i += 1) {
                        columns[across * pairs + i] = columns[was * pairs + i];
                        used[across * pairs + i] = used[was * pairs + i];
                    }
                }
            }
            for (; from < until; from += band) {
                const to = Math.min(from + band, until);
                for (let across = 0, base = 0; across < live; across += 1, base += pairs) {
                    const stop = stops[across];
                    const value = counted[across];
                    for (let at = from; at < to; at += 1) {
                        const offset = listed === null ? at : listed[at] - first;
                        if (offset >= stop) break;
                        let i = 0;
                        for (; i < pairs; i += 1) {
                            if (i === driver) continue;
                            const column = columns[base + i];
                            const row = ranges[i].top + offset;
                            if (column === undefined || offset >= used[base + i]) {
                                if (!blanks[i]) break;
                            } else if (
                                !meets(read[i], strings, column.kind[row] & KIND_MASK, column.num[row], column.ref[row])
                            )
                                break;
                        }
                        if (i < pairs) continue;
                        count += 1;
                        const row = top + offset;
                        if (value === undefined || row >= value.length) continue;
                        const kind = value.kind[row] & KIND_MASK;
                        if (kind === CellKind.Error) {
                            this.error = ctx.workbook.error(value.ref[row]);
                            return;
                        }
                        if (kind !== CellKind.Number) continue;
                        if (found === numbers.length) {
                            numbers = new Float64Array(found * 2);
                            numbers.set(this.numbers);
                            this.numbers = numbers;
                        }
                        numbers[found++] = value.num[row];
                    }
                }
            }
        }
        this.count = count;
        this.found = found;
    }
}
