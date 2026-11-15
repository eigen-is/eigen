// The records of one sheet in the workbook model, such as its merges, its filter, its comments and the rules over its
// ranges, kept by type and id as frozen objects a change replaces, so an unchanged record keeps its reference. It
// answers the read handle's questions, merges through an index, and works out where every record goes when rows or
// columns are inserted or deleted or a block of cells moves, with the record ops that undo puts after the inverse
// edit. The workbook's applier calls it: it checks and plans first and writes only once nothing can refuse.

import type { Edit, FormulaNode, LineEdit, Move } from '@workspace/formula/text';
import {
    GONE,
    GRID_COLUMNS,
    GRID_ROWS,
    mapIndex,
    mapSpan,
    parseStored,
    storedKey,
    transformLines,
    transformMove,
} from '@workspace/formula/text';
import type { SingleRange } from '@workspace/lib/sheets';
import { compareRules } from '@workspace/lib/sheets';
import type {
    ConditionalFormatRecord,
    FieldsOf,
    MoveOp,
    RecordOp,
    Records,
    RecordType,
    Rect,
    SheetContent,
    SheetFields,
    ValidationRecord,
} from '@workspace/lib/sheets/ops';
import { mapChartRefs } from '../chart-data';

type Kind = Exclude<RecordType, 'sheet'>;
type ChangedKind = Exclude<Kind, 'conditionalFormat'>;
type Span = [first: number, last: number];

// A line edit or a move worked out on one sheet: the record ops that undo applies after the inverse edit, in an order
// that applies, and the writes, which cannot fail.
export type Planned = { readonly restore: readonly RecordOp[]; readonly commit: () => void };

const KINDS: readonly Kind[] = [
    'merge',
    'filter',
    'filterColumn',
    'comment',
    'conditionalFormat',
    'validation',
    'image',
    'chart',
];

// A merge is listed under every band of this many rows it covers, so a read looks at the merges near its rows only.
const BAND_SHIFT = 6;

// The op type is a union over the record types, so an op of a type known only as a type parameter is made here: made
// whole or deleted, or with some of its fields set, which a rule never is.
type MadeBody<T extends Kind> =
    | { sheet: string; id: string; set: Records[T]; whole: 1 }
    | { sheet: string; id: string; set?: undefined };
type ChangeBody<T extends ChangedKind> = { sheet: string; id: string; set: FieldsOf<Records[T]> };
const MADE_OP: { readonly [T in Kind]: (body: MadeBody<T>) => RecordOp } = {
    merge: (body) => ({ kind: 'record', type: 'merge', ...body }),
    filter: (body) => ({ kind: 'record', type: 'filter', ...body }),
    filterColumn: (body) => ({ kind: 'record', type: 'filterColumn', ...body }),
    comment: (body) => ({ kind: 'record', type: 'comment', ...body }),
    conditionalFormat: (body) => ({ kind: 'record', type: 'conditionalFormat', ...body }),
    validation: (body) => ({ kind: 'record', type: 'validation', ...body }),
    image: (body) => ({ kind: 'record', type: 'image', ...body }),
    chart: (body) => ({ kind: 'record', type: 'chart', ...body }),
};
const CHANGE_OP: { readonly [T in ChangedKind]: (body: ChangeBody<T>) => RecordOp } = {
    merge: (body) => ({ kind: 'record', type: 'merge', ...body }),
    filter: (body) => ({ kind: 'record', type: 'filter', ...body }),
    filterColumn: (body) => ({ kind: 'record', type: 'filterColumn', ...body }),
    comment: (body) => ({ kind: 'record', type: 'comment', ...body }),
    validation: (body) => ({ kind: 'record', type: 'validation', ...body }),
    image: (body) => ({ kind: 'record', type: 'image', ...body }),
    chart: (body) => ({ kind: 'record', type: 'chart', ...body }),
};

export class SheetRecords {
    private readonly stored: { readonly [T in Kind]: Map<string, Records[T]> } = {
        merge: new Map(),
        filter: new Map(),
        filterColumn: new Map(),
        comment: new Map(),
        conditionalFormat: new Map(),
        validation: new Map(),
        image: new Map(),
        chart: new Map(),
    };
    // The merges by band of rows, each with its rectangle, and the comments by cell, ids in order.
    private readonly mergeBands = new Map<number, Map<string, Rect>>();
    private readonly commentCells = new Map<number, string[]>();
    private sheetFields: SheetFields;

    public constructor(
        private readonly sheet: string,
        fields: SheetFields,
        records: SheetContent['records'],
    ) {
        this.sheetFields = Object.freeze(fields);
        for (const type of KINDS) {
            for (const [id, record] of Object.entries(records[type] ?? {})) this.replace(type, id, record);
        }
    }

    public get fields(): SheetFields {
        return this.sheetFields;
    }

    public records<T extends Kind>(type: T): ReadonlyMap<string, Records[T]> {
        return this.stored[type];
    }

    public merge(row: number, column: number): Rect | undefined {
        for (const rect of this.mergeBands.get(row >> BAND_SHIFT)?.values() ?? []) {
            if (row >= rect[0] && row <= rect[2] && column >= rect[1] && column <= rect[3]) return rect;
        }
        return undefined;
    }

    public touchesMerge(rect: Rect): boolean {
        return this.mergesMeeting(rect).size > 0;
    }

    public mergesIn(rect: Rect): readonly Rect[] {
        return [...this.mergesMeeting(rect).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }

    // Where two rules cover a cell, the last in order has it.
    public validation(row: number, column: number): ValidationRecord | undefined {
        let found: [string, ValidationRecord] | undefined;
        for (const [id, record] of this.stored.validation) {
            if (!record.ranges.some((range) => covers(range, row, column))) continue;
            if (!found || compareRules(record.order, id, found[1].order, found[0]) > 0) found = [id, record];
        }
        return found?.[1];
    }

    public comments(row: number, column: number): readonly string[] {
        return this.commentCells.get(cellKey(row, column)) ?? [];
    }

    // Whole makes or replaces a record, a `set` alone changes the fields it names, null clearing one, and no `set`
    // deletes. A write that is skipped, such as a change of a record that is gone, returns no inverse.
    public write(op: RecordOp): RecordOp[] | 'merge-overlap' {
        if (op.whole) {
            switch (op.type) {
                case 'merge':
                    if (this.overlaps(op.id, op.set.rect)) return 'merge-overlap';
                    return this.swap('merge', op.id, op.set);
                case 'filter': {
                    const live = [...this.stored.filter.keys()];
                    const restore = live.flatMap((id) => this.removeFilter(id));
                    this.replace('filter', op.id, op.set);
                    return restore.length > 0 ? restore : [MADE_OP.filter({ sheet: this.sheet, id: op.id })];
                }
                case 'filterColumn':
                    if (!this.stored.filter.has(op.set.filter)) return [];
                    return this.swap('filterColumn', op.id, op.set);
                default:
                    return this.swap(op.type, op.id, op.set);
            }
        }
        if (op.type === 'sheet') {
            const before = fieldsBefore(this.sheetFields, op.set);
            this.sheetFields = Object.freeze(withFields(this.sheetFields, op.set));
            return Object.keys(before).length > 0
                ? [{ kind: 'record', sheet: this.sheet, type: 'sheet', id: op.id, set: before }]
                : [];
        }
        if (!op.set) return op.type === 'filter' ? this.removeFilter(op.id) : this.swap(op.type, op.id, undefined);
        if (op.type === 'merge') {
            const old = this.stored.merge.get(op.id);
            if (old && this.overlaps(op.id, op.set.rect ?? old.rect)) return 'merge-overlap';
        }
        if (op.type === 'filterColumn') {
            const old = this.stored.filterColumn.get(op.id);
            if (old && !this.stored.filter.has(op.set.filter ?? old.filter)) return [];
        }
        return this.change(op.type, op.id, op.set);
    }

    // Whether an insert of `count` lines would push a record off the grid's end: a comment or a merge on a pushed
    // line, or a record range that starts or ends on one. A range that reaches the last line is open and passes.
    public blocksPush(rows: boolean, count: number): boolean {
        const last = (rows ? GRID_ROWS : GRID_COLUMNS) - 1;
        const pushed = last + 1 - count;
        const spanPushed = (start: number, end: number) => start >= pushed || (end >= pushed && end !== last);
        const rangePushed = (range: SingleRange) => spanPushed(...lineSpan(range, rows));
        for (const { rect } of this.stored.merge.values()) if (rect[rows ? 2 : 3] >= pushed) return true;
        for (const { row, column } of this.stored.comment.values()) if ((rows ? row : column) >= pushed) return true;
        for (const { rect } of this.stored.filter.values()) if (rangePushed(rectRange(rect))) return true;
        for (const { column, rows: spans } of this.stored.filterColumn.values()) {
            if (rows ? spans.some(([start, end]) => spanPushed(start, end)) : column >= pushed) return true;
        }
        for (const { ranges } of [...this.stored.conditionalFormat.values(), ...this.stored.validation.values()]) {
            if (ranges.some(rangePushed)) return true;
        }
        return false;
    }

    // Lines inserted or deleted on this sheet or another: on this one every range, place and the frozen panes move;
    // on any, a rule's formula and a chart's refs follow the lines they name.
    public planLines(edit: LineEdit): Planned | 'key-too-long' {
        const here = edit.sheet === this.sheet;
        const { rows } = edit;
        const axis: Edit = {
            insert: edit.insert,
            index: edit.index,
            count: edit.count,
            lines: rows ? GRID_ROWS : GRID_COLUMNS,
        };
        const inverse: Edit = { ...axis, insert: !edit.insert };
        const inverseEdit: LineEdit = { ...edit, insert: !edit.insert };
        const writes: (() => void)[] = [];
        const restore: RecordOp[] = [];
        // Undo puts back a record the inverse edit does not give back as it was.
        let kept = true;
        const span = (start: number, end: number, open: boolean): Span | null => {
            const after = spanAfter(axis, start, end, open);
            const back = after && spanAfter(inverse, after[0], after[1], open);
            if (!back || back[0] !== start || back[1] !== end) kept = false;
            return after;
        };
        const line = (index: number): number => {
            const after = mapIndex(axis, index);
            if (after === GONE || mapIndex(inverse, after) !== index) kept = false;
            return after;
        };
        // The list itself when no range moves.
        const ranges = (list: SingleRange[]): SingleRange[] => {
            const next = list.flatMap((range) => {
                const [start, end] = lineSpan(range, rows);
                const after = span(start, end, true);
                if (!after) return [];
                if (after[0] === start && after[1] === end) return [range];
                return [rows ? { ...range, row: after } : { ...range, column: after }];
            });
            return next.length === list.length && next.every((range, i) => range === list[i]) ? list : next;
        };
        const settle = <T extends ChangedKind>(type: T, id: string, old: Records[T], next: Records[T] | undefined) => {
            if (next !== old) writes.push(() => this.replace(type, id, next));
            if (!kept || next === undefined) restore.push(this.restoreOp(type, id, old, next === undefined));
            kept = true;
        };
        // A rule changes only whole, so it comes back whole.
        const settleRule = (id: string, old: ConditionalFormatRecord, next: ConditionalFormatRecord | undefined) => {
            if (next !== old) writes.push(() => this.replace('conditionalFormat', id, next));
            if (!kept || next === undefined) restore.push(this.wholeOp('conditionalFormat', id, old));
            kept = true;
        };

        if (here) {
            const key = rows ? 'frozenRows' : 'frozenColumns';
            const frozen = this.sheetFields[key] ?? 0;
            const after = frozenAfter(axis, frozen);
            if (after !== frozen) {
                const set = rows ? { frozenRows: after || null } : { frozenColumns: after || null };
                writes.push(() => {
                    this.sheetFields = Object.freeze(withFields(this.sheetFields, set));
                });
            }
            if (frozenAfter(inverse, after) !== frozen) {
                const set = rows ? { frozenRows: frozen } : { frozenColumns: frozen };
                restore.push({ kind: 'record', sheet: this.sheet, type: 'sheet', id: this.sheet, set });
            }
            for (const [id, merge] of this.stored.merge) {
                const [top, left, bottom, right] = merge.rect;
                const after = rows ? span(top, bottom, false) : span(left, right, false);
                const rect: Rect | null =
                    after && (rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]]);
                // A merge the edit cuts to one cell is a merge no more, as in Excel.
                const single = rect && rect[0] === rect[2] && rect[1] === rect[3] && (top !== bottom || left !== right);
                settle('merge', id, merge, !rect || single ? undefined : sameRect(rect, merge.rect) ? merge : { rect });
            }
            const removed = new Set<string>();
            for (const [id, filter] of this.stored.filter) {
                // The header row holds the filter's buttons, so a delete of it removes the filter.
                const header = rows && !edit.insert && mapIndex(axis, filter.rect[0]) === GONE;
                const [range] = header ? [] : ranges([rectRange(filter.rect)]);
                if (!range) removed.add(id);
                const rect = range && rangeRect(range);
                settle('filter', id, filter, !rect ? undefined : sameRect(rect, filter.rect) ? filter : { rect });
            }
            for (const [id, column] of this.stored.filterColumn) {
                if (removed.has(column.filter)) {
                    settle('filterColumn', id, column, undefined);
                    continue;
                }
                if (!rows) {
                    const after = line(column.column);
                    const next = after === column.column ? column : { ...column, column: after };
                    settle('filterColumn', id, column, after === GONE ? undefined : next);
                    continue;
                }
                const spans = column.rows.flatMap(([start, end]) => {
                    const after = span(start, end, true);
                    return after ? [after] : [];
                });
                const same =
                    spans.length === column.rows.length &&
                    spans.every((s, i) => s[0] === column.rows[i][0] && s[1] === column.rows[i][1]);
                settle('filterColumn', id, column, same ? column : { ...column, rows: spans });
            }
            for (const [id, comment] of this.stored.comment) {
                const place = rows ? comment.row : comment.column;
                const after = line(place);
                const next =
                    after === place ? comment : rows ? { ...comment, row: after } : { ...comment, column: after };
                settle('comment', id, comment, after === GONE ? undefined : next);
            }
            for (const [id, validation] of this.stored.validation) {
                const next = ranges(validation.ranges);
                const moved = next === validation.ranges ? validation : { ...validation, ranges: next };
                settle('validation', id, validation, next.length === 0 ? undefined : moved);
            }
        }
        for (const [id, rule] of this.stored.conditionalFormat) {
            const next = here ? ranges(rule.ranges) : rule.ranges;
            if (next.length === 0) {
                settleRule(id, rule, undefined);
                continue;
            }
            const ruled = next === rule.ranges ? rule : { ...rule, ranges: next };
            // The formula is read at the top-left of the first range the edit leaves, at the first line it leaves of it.
            const first = here ? rule.ranges.findIndex((range) => spanAfter(axis, ...lineSpan(range, rows), true)) : 0;
            const [start] = lineSpan(rule.ranges[first], rows);
            const host = here && mapIndex(axis, start) === GONE ? edit.index + edit.count : start;
            const formula = withFormula(ruled, (tree) => transformLines(tree, edit, this.sheet, host));
            if (formula === 'key-too-long') return formula;
            const backHost = lineSpan(formula.ranges[0], rows)[0];
            const back = withFormula(formula, (tree) => transformLines(tree, inverseEdit, this.sheet, backHost));
            if (back === 'key-too-long' || formulaOf(back) !== formulaOf(rule)) kept = false;
            settleRule(id, rule, formula);
        }
        for (const [id, chart] of this.stored.chart) {
            const next = mapChartRefs(chart, (ref) => {
                if (ref.sheetId !== edit.sheet) return ref;
                const [start, end] = rows ? ref.row : ref.column;
                const after = span(start, end, true);
                if (!after) return null;
                if (after[0] === start && after[1] === end) return ref;
                return rows ? { ...ref, row: after } : { ...ref, column: after };
            });
            settle('chart', id, chart, next);
        }
        return {
            restore,
            commit: () => {
                for (const write of writes) write();
            },
        };
    }

    // A block of cells moved on this sheet or to another. `source` holds the sheet the block leaves, which is this one
    // for a move on one sheet. Its comments and the merges wholly in it go along, and on one sheet so do the rule
    // ranges wholly in it; a merge it lands on whole goes, and one it cuts, where it leaves or lands, refuses.
    public planMove(op: MoveOp, source: SheetRecords): Planned | 'merge-cut' | 'key-too-long' {
        const block = op.from;
        const [top, left, bottom, right] = block;
        const rowShift = op.toRow - top;
        const columnShift = op.toColumn - left;
        const shifted = ([t, l, b, r]: Rect): Rect => [t + rowShift, l + columnShift, b + rowShift, r + columnShift];
        const target = shifted(block);
        const fromHere = op.sheet === this.sheet;
        const toHere = op.toSheet === this.sheet;
        const oneSheet = op.sheet === op.toSheet;
        const move: Move = {
            fromSheet: op.sheet,
            row: top,
            column: left,
            rows: bottom - top + 1,
            columns: right - left + 1,
            toSheet: op.toSheet,
            toRow: op.toRow,
            toColumn: op.toColumn,
        };
        const reverse: Move = {
            ...move,
            fromSheet: op.toSheet,
            row: op.toRow,
            column: op.toColumn,
            toSheet: op.sheet,
            toRow: top,
            toColumn: left,
        };
        const writes: (() => void)[] = [];
        const restore: RecordOp[] = [];

        const near = toHere || fromHere;
        const carried = near ? source.mergesMeeting(block) : new Map<string, Rect>();
        if (fromHere && [...carried.values()].some((rect) => !within(rect, block))) return 'merge-cut';
        if (toHere) {
            for (const [id, rect] of this.mergesMeeting(target)) {
                if (oneSheet && carried.has(id)) continue;
                if (!within(rect, target)) return 'merge-cut';
                const merge = this.stored.merge.get(id);
                if (merge) restore.push(this.restoreOp('merge', id, merge, true));
                writes.push(() => this.replace('merge', id, undefined));
            }
        }
        const comments = near
            ? [...source.stored.comment].filter(([, { row, column }]) => covers(rectRange(block), row, column))
            : [];
        if (toHere) {
            const moving = new Set(comments.map(([id]) => id));
            // The move back takes along what lies where the block landed, so undo puts it back after.
            for (const [id, comment] of this.stored.comment) {
                if (moving.has(id) || !covers(rectRange(target), comment.row, comment.column)) continue;
                if (!oneSheet) restore.push(MADE_OP.comment({ sheet: op.sheet, id }));
                restore.push(this.restoreOp('comment', id, comment, !oneSheet));
            }
            for (const [id, rect] of carried) writes.push(() => this.replace('merge', id, { rect: shifted(rect) }));
            for (const [id, comment] of comments) {
                writes.push(() =>
                    this.replace('comment', id, { row: comment.row + rowShift, column: comment.column + columnShift }),
                );
            }
        }
        if (fromHere && !oneSheet) {
            for (const id of carried.keys()) writes.push(() => this.replace('merge', id, undefined));
            for (const [id] of comments) writes.push(() => this.replace('comment', id, undefined));
        }

        const carries = oneSheet && fromHere;
        // The list itself when no range moves.
        const moved = (list: SingleRange[]): SingleRange[] =>
            carries && list.some((range) => within(rangeRect(range), block))
                ? list.map((range) => (within(rangeRect(range), block) ? rectRange(shifted(rangeRect(range))) : range))
                : list;
        const returns = (list: readonly SingleRange[]) =>
            carries && list.some((range) => !within(rangeRect(range), block) && within(rangeRect(range), target));
        for (const [id, validation] of this.stored.validation) {
            const ranges = moved(validation.ranges);
            if (ranges !== validation.ranges)
                writes.push(() => this.replace('validation', id, { ...validation, ranges }));
            if (returns(validation.ranges)) restore.push(this.restoreOp('validation', id, validation, false));
        }
        for (const [id, rule] of this.stored.conditionalFormat) {
            const ranges = moved(rule.ranges);
            const ruled = ranges === rule.ranges ? rule : { ...rule, ranges };
            const host = moveHost(rule.ranges, block, fromHere, ranges[0] !== rule.ranges[0]);
            const formula = host ? withFormula(ruled, (tree) => transformMove(tree, move, this.sheet, ...host)) : ruled;
            if (formula === 'key-too-long') return formula;
            const backHost = moveHost(
                formula.ranges,
                target,
                toHere,
                carries && within(rangeRect(formula.ranges[0]), target),
            );
            const back = backHost
                ? withFormula(formula, (tree) => transformMove(tree, reverse, this.sheet, ...backHost))
                : formula;
            if (formula !== rule) writes.push(() => this.replace('conditionalFormat', id, formula));
            if (back === 'key-too-long' || formulaOf(back) !== formulaOf(rule) || returns(rule.ranges)) {
                restore.push(this.wholeOp('conditionalFormat', id, rule));
            }
        }
        return {
            restore,
            commit: () => {
                for (const write of writes) write();
            },
        };
    }

    // The merges with a cell in the rectangle, by id.
    private mergesMeeting(rect: Rect): Map<string, Rect> {
        const found = new Map<string, Rect>();
        for (let band = rect[0] >> BAND_SHIFT; band <= rect[2] >> BAND_SHIFT; band += 1) {
            for (const [id, merge] of this.mergeBands.get(band) ?? []) if (meets(merge, rect)) found.set(id, merge);
        }
        return found;
    }

    private overlaps(id: string, rect: Rect): boolean {
        return [...this.mergesMeeting(rect).keys()].some((other) => other !== id);
    }

    // The filter of this id and its columns go, and come back in that order.
    private removeFilter(id: string): RecordOp[] {
        const restore = this.swap('filter', id, undefined);
        if (restore.length === 0) return restore;
        for (const [columnId, column] of this.stored.filterColumn) {
            if (column.filter === id) restore.push(...this.swap('filterColumn', columnId, undefined));
        }
        return restore;
    }

    // Puts a record in place of the one under its id and returns the op that puts the old one back.
    private swap<T extends Kind>(type: T, id: string, record: Records[T] | undefined): RecordOp[] {
        const old = this.stored[type].get(id);
        if (old === undefined && record === undefined) return [];
        this.replace(type, id, record);
        return [old === undefined ? MADE_OP[type]({ sheet: this.sheet, id }) : this.wholeOp(type, id, old)];
    }

    private change<T extends ChangedKind>(type: T, id: string, set: FieldsOf<Records[T]>): RecordOp[] {
        const old = this.stored[type].get(id);
        if (old === undefined) return [];
        const before = fieldsBefore(old, set);
        this.replace(type, id, withFields(old, set));
        return Object.keys(before).length > 0 ? [CHANGE_OP[type]({ sheet: this.sheet, id, set: before })] : [];
    }

    private wholeOp<T extends Kind>(type: T, id: string, record: Records[T]): RecordOp {
        return MADE_OP[type]({ sheet: this.sheet, id, set: record, whole: 1 });
    }

    // A record that is gone comes back whole; one that is there has every field set back, since a whole make of a
    // filter would take its columns.
    private restoreOp<T extends ChangedKind>(type: T, id: string, old: Records[T], gone: boolean): RecordOp {
        return gone ? this.wholeOp(type, id, old) : CHANGE_OP[type]({ sheet: this.sheet, id, set: old });
    }

    // Every write lands here, which keeps the merge bands and the comment cells in step.
    private replace<T extends Kind>(type: T, id: string, record: Records[T] | undefined): void {
        if (type === 'merge') this.indexMerge(id, false);
        if (type === 'comment') this.indexComment(id, false);
        if (record === undefined) this.stored[type].delete(id);
        else {
            Object.freeze(record);
            this.stored[type].set(id, record);
        }
        if (type === 'merge') this.indexMerge(id, true);
        if (type === 'comment') this.indexComment(id, true);
    }

    private indexMerge(id: string, add: boolean): void {
        const merge = this.stored.merge.get(id);
        if (!merge) return;
        for (let band = merge.rect[0] >> BAND_SHIFT; band <= merge.rect[2] >> BAND_SHIFT; band += 1) {
            const merges = this.mergeBands.get(band) ?? new Map<string, Rect>();
            if (add) this.mergeBands.set(band, merges.set(id, merge.rect));
            else if (merges.delete(id) && merges.size === 0) this.mergeBands.delete(band);
        }
    }

    private indexComment(id: string, add: boolean): void {
        const comment = this.stored.comment.get(id);
        if (!comment) return;
        const key = cellKey(comment.row, comment.column);
        const ids = (this.commentCells.get(key) ?? []).filter((other) => other !== id);
        const at = ids.findIndex((other) => other > id);
        if (add) ids.splice(at < 0 ? ids.length : at, 0, id);
        if (ids.length > 0) this.commentCells.set(key, ids);
        else this.commentCells.delete(key);
    }
}

// The lines `start` to `end` after the edit, or null when none is left. With `open`, an end on the axis's last line
// stays there, so a range that reaches the end of the grid keeps reaching it, and the whole axis, Excel's `A:A`,
// stays whole.
function spanAfter(edit: Edit, start: number, end: number, open: boolean): Span | null {
    if (open && start === 0 && end === edit.lines - 1) return [start, end];
    const into = { start: 0, end: 0 };
    if (!mapSpan(edit, start, end, into)) return null;
    return [into.start, open && end === edit.lines - 1 ? end : into.end];
}

// An insert before the last frozen line freezes the new lines too; a delete takes the frozen lines it deletes.
function frozenAfter({ insert, index, count }: Edit, frozen: number): number {
    if (index >= frozen) return frozen;
    return insert ? frozen + count : frozen - Math.min(count, frozen - index);
}

// A formula rule with its stored key transformed: the rule as it came when its key stays, or when its text does not
// parse, which reads as an error on every reader.
function withFormula(
    rule: ConditionalFormatRecord,
    transform: (tree: FormulaNode) => { tree: FormulaNode },
): ConditionalFormatRecord | 'key-too-long' {
    const text = formulaOf(rule);
    const tree = text === undefined ? null : parseStored(text);
    if (!tree || 'reason' in tree || rule.type !== 'default') return rule;
    const next = transform(tree).tree;
    if (next === tree) return rule;
    const key = storedKey(next);
    return typeof key === 'string' ? { ...rule, conditionValue: rule.conditionValue.with(0, key) } : 'key-too-long';
}

function formulaOf(rule: ConditionalFormatRecord): string | undefined {
    if (rule.type !== 'default' || rule.conditionName !== 'formula') return undefined;
    const [text] = rule.conditionValue;
    return typeof text === 'string' ? text : undefined;
}

// Where a rule is read during a move: at the top-left of its first range, unless the block leaves from its sheet and
// takes cells of the rule but not its first range, which is then read at the first of its cells the block leaves where
// they are, so the formula does not follow the block. None when the block holds every range.
function moveHost(
    ranges: readonly SingleRange[],
    block: Rect,
    fromSheet: boolean,
    firstMoves: boolean,
): [number, number] | undefined {
    const [{ row, column }] = ranges;
    if (!fromSheet || firstMoves) return [row[0], column[0]];
    for (const { row, column } of ranges) {
        if (!covers(rectRange(block), row[0], column[0])) return [row[0], column[0]];
        if (column[1] > block[3]) return [row[0], block[3] + 1];
        if (row[1] > block[2]) return [block[2] + 1, column[0]];
    }
    return undefined;
}

function lineSpan(range: SingleRange, rows: boolean): Span {
    const [start, end] = rows ? range.row : range.column;
    return [start, end];
}

function rectRange([top, left, bottom, right]: Rect): SingleRange {
    return { row: [top, bottom], column: [left, right] };
}

function rangeRect({ row, column }: SingleRange): Rect {
    return [row[0], column[0], row[1], column[1]];
}

function sameRect(a: Rect, b: Rect): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function covers({ row, column }: SingleRange, r: number, c: number): boolean {
    return r >= row[0] && r <= row[1] && c >= column[0] && c <= column[1];
}

function meets(a: Rect, b: Rect): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function within(inner: Rect, outer: Rect): boolean {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function cellKey(row: number, column: number): number {
    return row * GRID_COLUMNS + column;
}

function withFields<R extends object>(record: R, set: FieldsOf<R>): R {
    const next = { ...record };
    for (const key in set) {
        const value = set[key];
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
    }
    return next;
}

// The old value of every field `set` changes, null where there was none.
function fieldsBefore<R extends object>(record: R, set: FieldsOf<R>): FieldsOf<R> {
    const before: FieldsOf<R> = {};
    for (const key in set) if (set[key] !== record[key]) before[key] = record[key] ?? null;
    return before;
}
