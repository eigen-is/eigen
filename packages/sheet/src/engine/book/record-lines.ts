// Where the fields of a sheet's records go when rows or columns are inserted or deleted: a merge moves as its lines
// do, a filter that reaches the last line keeps reaching it, a rule's formula follows the lines it names. The record
// store plans a line edit with it, and the undo stack shifts the record ops it keeps with it, so a record and an op
// that names it land in one place. A rule is given the fields an op sets, which may be all of a record or a few.

import type { Edit, FormulaNode, LineEdit } from '@workspace/formula/text';
import {
    GONE,
    GRID_COLUMNS,
    GRID_ROWS,
    mapIndex,
    mapSpan,
    parseStored,
    storedKey,
    transformLines,
} from '@workspace/formula/text';
import type {
    CommentRecord,
    ConditionalFormatRecord,
    FieldsOf,
    FilterColumnRecord,
    FilterRecord,
    LinesOp,
    MergeRecord,
    Rect,
    SheetFields,
    Span,
    ValidationRecord,
} from '@workspace/lib/sheets/ops';
import { sameRect } from '@workspace/lib/sheets/rect';
import { mapChartRefs } from '../chart-data';

// How a span meets the grid's end under a line edit: a merge's end moves as a line does, a filter's end on the last
// line stays there, and a rule's or a chart's range over the whole axis, Excel's `A:A`, also stays whole.
export type Reach = 'closed' | 'open' | 'whole';

// One line edit as the fields of records go through it.
export class LineMap {
    public readonly rows: boolean;
    // The edit that undoes this one, as a formula's transform takes it.
    private readonly back: LineEdit;
    private readonly axis: Edit;
    private readonly inverse: Edit;
    // Whether the inverse edit gives back every line, span and formula mapped in the current `through`.
    private kept = true;

    public constructor(public readonly edit: LinesOp) {
        const { rows, insert, index, count } = edit;
        this.rows = rows;
        this.back = { ...edit, insert: !insert };
        this.axis = { insert, index, count, lines: rows ? GRID_ROWS : GRID_COLUMNS };
        this.inverse = { ...this.axis, insert: !insert };
    }

    // What a rule makes of a record, and whether the inverse edit gives back all it mapped: a record that only
    // shifted needs no op to put it back.
    public through<R>(rule: () => R): readonly [after: R, kept: boolean] {
        this.kept = true;
        const after = rule();
        return [after, this.kept];
    }

    // Whether the edit takes a line away.
    public gone(index: number): boolean {
        return mapIndex(this.axis, index) === GONE;
    }

    public line(index: number): number {
        const after = mapIndex(this.axis, index);
        if (after === GONE || mapIndex(this.inverse, after) !== index) this.kept = false;
        return after;
    }

    public span(start: number, end: number, reach: Reach): Span | null {
        const after = spanAfter(this.axis, start, end, reach);
        const back = after && spanAfter(this.inverse, after[0], after[1], reach);
        if (!back || back[0] !== start || back[1] !== end) this.kept = false;
        return after;
    }

    public rect(rect: Rect, reach: Reach): Rect | null {
        const [top, left, bottom, right] = rect;
        const after = this.span(...lineSpan(rect, this.rows), reach);
        return after && (this.rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]]);
    }

    // The ranges of a rule that are left: the list itself when no range moves.
    public ranges(list: Rect[]): Rect[] {
        const next = list.flatMap((range) => {
            const after = this.rect(range, 'whole');
            return after ? [sameRect(after, range) ? range : after] : [];
        });
        return next.length === list.length && next.every((range, i) => range === list[i]) ? list : next;
    }

    // An insert before the last frozen line freezes the new lines too, up to the grid's end; a delete takes the
    // frozen lines it deletes.
    public frozen(count: number): number {
        const after = frozenAfter(this.axis, count);
        if (frozenAfter(this.inverse, after) !== count) this.kept = false;
        return after;
    }

    // A rule's formula through the edit, read at `host`; `rule` is the record before the edit, which the inverse edit
    // read at the formula's new host must give back.
    public formula(
        rule: ConditionalFormatRecord,
        ruled: ConditionalFormatRecord,
        sheet: string,
        host: number,
    ): ConditionalFormatRecord | 'key-too-long' {
        const formula = withFormula(ruled, (tree) => transformLines(tree, this.edit, sheet, host).tree);
        if (formula === 'key-too-long') return formula;
        const backHost = lineSpan(formula.ranges[0], this.rows)[0];
        const back = withFormula(formula, (tree) => transformLines(tree, this.back, sheet, backHost).tree);
        if (back === 'key-too-long' || formulaOf(back) !== formulaOf(rule)) this.kept = false;
        return formula;
    }
}

// Each rule below returns the fields it was given when none of them moves, and nothing when the record is gone.

export function sheetAfter(fields: FieldsOf<SheetFields>, map: LineMap): FieldsOf<SheetFields> {
    const frozen = map.rows ? fields.frozenRows : fields.frozenColumns;
    if (typeof frozen !== 'number') return fields;
    const after = map.frozen(frozen);
    if (after === frozen) return fields;
    return map.rows ? { ...fields, frozenRows: after || null } : { ...fields, frozenColumns: after || null };
}

export function mergeAfter<R extends FieldsOf<MergeRecord>>(fields: R, map: LineMap): R | undefined {
    const { rect } = fields;
    if (!rect) return fields;
    const after = map.rect(rect, 'closed');
    // A merge the edit cuts to one cell is a merge no more, as in Excel.
    const single =
        after && after[0] === after[2] && after[1] === after[3] && (rect[0] !== rect[2] || rect[1] !== rect[3]);
    if (!after || single) return undefined;
    return sameRect(after, rect) ? fields : { ...fields, rect: after };
}

export function filterAfter<R extends FieldsOf<FilterRecord>>(fields: R, map: LineMap): R | undefined {
    const { rect } = fields;
    if (!rect) return fields;
    // The header row holds the filter's buttons, so a delete of it removes the filter.
    const after = map.rows && !map.edit.insert && map.gone(rect[0]) ? null : map.rect(rect, 'open');
    if (!after) return undefined;
    return sameRect(after, rect) ? fields : { ...fields, rect: after };
}

export function filterColumnAfter<R extends FieldsOf<FilterColumnRecord>>(fields: R, map: LineMap): R | undefined {
    const { column, rows } = fields;
    if (!map.rows) {
        if (typeof column !== 'number') return fields;
        const after = map.line(column);
        if (after === GONE) return undefined;
        return after === column ? fields : { ...fields, column: after };
    }
    if (!rows) return fields;
    const spans = rows.flatMap(([start, end]) => {
        const after = map.span(start, end, 'open');
        return after ? [after] : [];
    });
    const same = spans.length === rows.length && spans.every((s, i) => s[0] === rows[i][0] && s[1] === rows[i][1]);
    return same ? fields : { ...fields, rows: spans };
}

export function commentAfter<R extends FieldsOf<CommentRecord>>(fields: R, map: LineMap): R | undefined {
    const place = map.rows ? fields.row : fields.column;
    if (typeof place !== 'number') return fields;
    const after = map.line(place);
    if (after === GONE) return undefined;
    if (after === place) return fields;
    return map.rows ? { ...fields, row: after } : { ...fields, column: after };
}

export function validationAfter<R extends FieldsOf<ValidationRecord>>(fields: R, map: LineMap): R | undefined {
    const { ranges } = fields;
    if (!ranges) return fields;
    const next = map.ranges(ranges);
    if (next.length === 0) return undefined;
    return next === ranges ? fields : { ...fields, ranges: next };
}

// A rule of `sheet`, whose ranges move when its sheet is edited and whose formula follows the lines it names on any
// sheet. The formula is read at the top-left of the first range the edit leaves, on its first line that stays.
export function ruleAfter(
    rule: ConditionalFormatRecord,
    map: LineMap,
    sheet: string,
): ConditionalFormatRecord | undefined | 'key-too-long' {
    const { edit, rows } = map;
    const here = edit.sheet === sheet;
    const ranges = here ? map.ranges(rule.ranges) : rule.ranges;
    if (ranges.length === 0) return undefined;
    const ruled = ranges === rule.ranges ? rule : { ...rule, ranges };
    const first = here ? rule.ranges.findIndex((range) => map.rect(range, 'whole')) : 0;
    const [start] = lineSpan(rule.ranges[first], rows);
    const host = here && map.gone(start) ? edit.index + edit.count : start;
    return map.formula(rule, ruled, sheet, host);
}

// A chart on any sheet, whose refs follow the lines they name on the edited sheet.
export function chartAfter<C extends Readonly<Record<string, unknown>>>(chart: C, map: LineMap): C {
    return mapChartRefs(chart, (ref) => {
        if (ref.sheetId !== map.edit.sheet) return ref;
        const [start, end] = map.rows ? ref.row : ref.column;
        const after = map.span(start, end, 'whole');
        if (!after) return null;
        if (after[0] === start && after[1] === end) return ref;
        return map.rows ? { ...ref, row: [...after] } : { ...ref, column: [...after] };
    });
}

// The lines `start` to `end` after the edit, or null when none is left.
export function spanAfter(edit: Edit, start: number, end: number, reach: Reach): Span | null {
    const toEnd = reach !== 'closed' && end === edit.lines - 1;
    if (toEnd && reach === 'whole' && start === 0) return [start, end];
    const into = { start: 0, end: 0 };
    if (!mapSpan(edit, start, end, into)) return null;
    return [into.start, toEnd ? end : into.end];
}

function frozenAfter({ insert, index, count, lines }: Edit, frozen: number): number {
    if (index >= frozen) return frozen;
    return insert ? Math.min(frozen + count, lines) : frozen - Math.min(count, frozen - index);
}

// A formula rule with its stored key transformed: the rule as it came when its key stays.
export function withFormula(
    rule: ConditionalFormatRecord,
    transform: (tree: FormulaNode) => FormulaNode,
): ConditionalFormatRecord | 'key-too-long' {
    const text = formulaOf(rule);
    if (text === undefined || rule.type !== 'default') return rule;
    const key = keyThrough(text, transform);
    if (key === null) return 'key-too-long';
    return key === text ? rule : { ...rule, conditionValue: rule.conditionValue.with(0, key) };
}

export function formulaOf(rule: ConditionalFormatRecord): string | undefined {
    if (rule.type !== 'default' || rule.conditionName !== 'formula') return undefined;
    const [text] = rule.conditionValue;
    return typeof text === 'string' ? text : undefined;
}

// A stored key with its tree transformed, or null when the new key is too long to store: the key as it came when the
// tree stays, or when the text does not parse, which reads as an error on every reader.
export function keyThrough(text: string, transform: (tree: FormulaNode) => FormulaNode): string | null {
    const tree = parseStored(text);
    if ('reason' in tree) return text;
    const next = transform(tree);
    if (next === tree) return text;
    const key = storedKey(next);
    return typeof key === 'string' ? key : null;
}

export function lineSpan([top, left, bottom, right]: Rect, rows: boolean): Span {
    return rows ? [top, bottom] : [left, right];
}
