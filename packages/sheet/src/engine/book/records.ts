// The records of one sheet in the workbook model, such as its merges, its filter, its comments and the rules over its
// ranges, kept by type and id as frozen objects a change replaces, so an unchanged record keeps its reference. It
// works out where every record goes when rows or columns are inserted or deleted or a block of cells moves, with the
// record ops that undo puts after the inverse edit. The workbook's applier calls it: it checks and plans first and
// writes only once nothing can refuse.

import type { Move } from '@workspace/formula/text';
import { GRID_COLUMNS, GRID_ROWS, transformMove } from '@workspace/formula/text';
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import { compareRules } from '@workspace/lib/sheets';
import type {
    FieldsOf,
    LinesOp,
    MoveOp,
    RecordOp,
    Records,
    RecordType,
    Rect,
    SheetContent,
    SheetFields,
    ValidationRecord,
} from '@workspace/lib/sheets/ops';
import { covers, within } from '@workspace/lib/sheets/rect';
import { mapChartRefs } from '../chart-data';
import {
    chartAfter,
    commentAfter,
    filterAfter,
    filterColumnAfter,
    formulaOf,
    LineMap,
    lineSpan,
    mergeAfter,
    ruleAfter,
    sheetAfter,
    validationAfter,
    withFormula,
} from './record-lines';
import { RectIndex } from './rect-index';

type Kind = Exclude<RecordType, 'sheet'>;
type ChangedKind = Exclude<Kind, 'conditionalFormat'>;
type RuleKind = 'conditionalFormat' | 'validation';
// A line edit or a move worked out on one sheet: the record ops that undo applies after the inverse edit, in an order
// that applies, and the writes, which cannot fail.
export type Planned = { readonly restore: readonly RecordOp[]; readonly commit: () => void };

// Every record type of a sheet once: the mapped type fails the build on a type left out.
const KIND: { readonly [T in Kind]: T } = {
    merge: 'merge',
    filter: 'filter',
    filterColumn: 'filterColumn',
    comment: 'comment',
    conditionalFormat: 'conditionalFormat',
    validation: 'validation',
    image: 'image',
    chart: 'chart',
};
const KINDS = Object.values(KIND);

// The cells a record lies on, for the types a read finds by cell.
const RECTS: { readonly [T in Kind]?: (record: Records[T]) => readonly Rect[] } = {
    merge: ({ rect }) => [rect],
    comment: ({ row, column }) => [[row, column, row, column]],
    conditionalFormat: ({ ranges }) => ranges,
    validation: ({ ranges }) => ranges,
};

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
    private readonly places = {
        merge: new RectIndex(),
        comment: new RectIndex(),
        conditionalFormat: new RectIndex(),
        validation: new RectIndex(),
    };
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

    // Whether this sheet holds a record of one of the types of `records` under one of its ids.
    public sharesId(records: SheetContent['records']): boolean {
        return KINDS.some((type) => Object.keys(records[type] ?? {}).some((id) => this.stored[type].has(id)));
    }

    // The records as a snapshot holds them: by type and by id in order, a type with no record left out.
    public content(): SheetContent['records'] {
        const listed = <R>(records: ReadonlyMap<string, R>) =>
            Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : 1)));
        const { merge, filter, filterColumn, comment, conditionalFormat, validation, image, chart } = this.stored;
        const content: SheetContent['records'] = {
            merge: listed(merge),
            filter: listed(filter),
            filterColumn: listed(filterColumn),
            comment: listed(comment),
            conditionalFormat: listed(conditionalFormat),
            validation: listed(validation),
            image: listed(image),
            chart: listed(chart),
        } satisfies Required<SheetContent['records']>;
        for (const type of KINDS) if (this.stored[type].size === 0) delete content[type];
        return content;
    }

    // What the limit on records counts: the most records of one type.
    public weight(): { records: number } {
        return { records: Math.max(...KINDS.map((type) => this.stored[type].size)) };
    }

    public merge(row: number, column: number): Rect | undefined {
        return this.places.merge.meeting([row, column, row, column])[0]?.[1];
    }

    public touchesMerge(rect: Rect): boolean {
        return this.places.merge.meeting(rect).length > 0;
    }

    public mergesIn(rect: Rect): readonly Rect[] {
        const merges = this.places.merge.meeting(rect).map(([, merge]) => merge);
        return merges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }

    // Where two rules cover a cell, the last in order has it.
    public validation(row: number, column: number): ValidationRecord | undefined {
        let last: [string, ValidationRecord] | undefined;
        for (const [id] of this.places.validation.meeting([row, column, row, column])) {
            const rule = this.stored.validation.get(id);
            if (rule && (!last || compareRules(rule.order, id, last[1].order, last[0]) > 0)) last = [id, rule];
        }
        return last?.[1];
    }

    // The rules with a range in the rectangle, in rule order, each with those ranges: what a paint of a screen reads.
    public rulesIn<T extends RuleKind>(type: T, rect: Rect): { id: string; rule: Records[T]; ranges: Rect[] }[] {
        const found = [...Map.groupBy(this.places[type].meeting(rect), ([id]) => id)].flatMap(([id, pairs]) => {
            const rule = this.stored[type].get(id);
            return rule ? [{ id, rule, ranges: pairs.map(([, range]) => range) }] : [];
        });
        return found.sort((a, b) => compareRules(a.rule.order, a.id, b.rule.order, b.id));
    }

    public comments(row: number, column: number): readonly string[] {
        const found = this.places.comment.meeting([row, column, row, column]);
        return found.map(([id]) => id).sort();
    }

    // Whole makes or replaces a record, a `set` alone changes the fields it names, null clearing one, and no `set`
    // deletes. A write that is skipped, such as a change of a record that is gone, returns no inverse.
    public write(op: RecordOp): RecordOp[] | 'merge-overlap' | 'key-too-long' {
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
        if (op.type === 'chart') {
            const old = this.stored.chart.get(op.id);
            if (old && exceedsChartSpecBytes(withFields(old, op.set))) return 'key-too-long';
        }
        return this.change(op.type, op.id, op.set);
    }

    // Whether the insert would push a record off the grid's end: a comment or a merge on a pushed line, or a record
    // range that starts or ends on one. A range that reaches the last line is open and passes.
    public wouldPush({ rows, count }: LinesOp): boolean {
        const last = (rows ? GRID_ROWS : GRID_COLUMNS) - 1;
        const pushed = last + 1 - count;
        const spanPushed = (start: number, end: number) => start >= pushed || (end >= pushed && end !== last);
        const rectPushed = (rect: Rect) => spanPushed(...lineSpan(rect, rows));
        for (const { rect } of this.stored.merge.values()) if (rect[rows ? 2 : 3] >= pushed) return true;
        for (const { row, column } of this.stored.comment.values()) if ((rows ? row : column) >= pushed) return true;
        for (const { rect } of this.stored.filter.values()) if (rectPushed(rect)) return true;
        for (const { column, rows: spans } of this.stored.filterColumn.values()) {
            if (rows ? spans.some(([start, end]) => spanPushed(start, end)) : column >= pushed) return true;
        }
        for (const { ranges } of [...this.stored.conditionalFormat.values(), ...this.stored.validation.values()]) {
            if (ranges.some(rectPushed)) return true;
        }
        return false;
    }

    // Lines inserted or deleted on this sheet or another: on this one every range, place and the frozen panes move;
    // on any, a rule's formula and a chart's refs follow the lines they name.
    public planLines(edit: LinesOp): Planned | 'key-too-long' {
        const here = edit.sheet === this.sheet;
        const map = new LineMap(edit);
        const writes: (() => void)[] = [];
        const restore: RecordOp[] = [];
        // Undo puts back a record the inverse edit does not give back as it was.
        const settle = <T extends ChangedKind>(type: T, id: string, old: Records[T], next: Records[T] | undefined) => {
            if (next !== old) writes.push(() => this.replace(type, id, next));
            if (!map.kept || next === undefined) restore.push(this.restoreOp(type, id, old, next === undefined));
            map.kept = true;
        };

        if (here) {
            const fields = sheetAfter(this.sheetFields, map);
            if (fields !== this.sheetFields) {
                writes.push(() => {
                    this.sheetFields = Object.freeze(withFields(this.sheetFields, fields));
                });
            }
            if (!map.kept) {
                const { frozenRows, frozenColumns } = this.sheetFields;
                const set = map.rows ? { frozenRows } : { frozenColumns };
                restore.push({ kind: 'record', sheet: this.sheet, type: 'sheet', id: this.sheet, set });
            }
            map.kept = true;
            for (const [id, merge] of this.stored.merge) settle('merge', id, merge, mergeAfter(merge, map));
            const removed = new Set<string>();
            for (const [id, filter] of this.stored.filter) {
                const next = filterAfter(filter, map);
                if (!next) removed.add(id);
                settle('filter', id, filter, next);
            }
            for (const [id, column] of this.stored.filterColumn) {
                const next = removed.has(column.filter) ? undefined : filterColumnAfter(column, map);
                settle('filterColumn', id, column, next);
            }
            for (const [id, comment] of this.stored.comment) settle('comment', id, comment, commentAfter(comment, map));
            for (const [id, validation] of this.stored.validation) {
                settle('validation', id, validation, validationAfter(validation, map));
            }
        }
        for (const [id, rule] of this.stored.conditionalFormat) {
            const next = ruleAfter(rule, map, this.sheet);
            if (next === 'key-too-long') return next;
            if (next !== rule) writes.push(() => this.replace('conditionalFormat', id, next));
            // A rule changes only whole, so it comes back whole.
            if (!map.kept || next === undefined) restore.push(this.wholeOp('conditionalFormat', id, rule));
            map.kept = true;
        }
        for (const [id, chart] of this.stored.chart) {
            const next = chartAfter(chart, map);
            if (next !== chart && exceedsChartSpecBytes(next)) return 'key-too-long';
            settle('chart', id, chart, next);
        }
        return {
            restore: inOrder(restore),
            commit: () => {
                for (const write of writes) write();
            },
        };
    }

    // A block moved on this sheet or to another, `source` being the sheet it leaves: its comments, the merges and the
    // chart refs wholly in it go along, on one sheet its rule ranges too. A merge or a comment it lands on goes, and a
    // merge it cuts anywhere refuses.
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
        const carried = new Map(near ? source.places.merge.meeting(block) : []);
        if (fromHere && [...carried.values()].some((rect) => !within(rect, block))) return 'merge-cut';
        const comments = near ? source.places.comment.meeting(block) : [];
        if (toHere) {
            // What lies under where the block lands goes, merges and comments alike, but for what the block brings.
            const moving = new Set(comments.map(([id]) => id));
            for (const [id, rect] of this.places.merge.meeting(target)) {
                if (oneSheet && carried.has(id)) continue;
                if (!within(rect, target)) return 'merge-cut';
                restore.push(this.wholeOp('merge', id, { rect }));
                writes.push(() => this.replace('merge', id, undefined));
            }
            for (const [id, [row, column]] of this.places.comment.meeting(target)) {
                if (oneSheet && moving.has(id)) continue;
                restore.push(this.wholeOp('comment', id, { row, column }));
                writes.push(() => this.replace('comment', id, undefined));
            }
            for (const [id, rect] of carried) writes.push(() => this.replace('merge', id, { rect: shifted(rect) }));
            for (const [id, [row, column]] of comments) {
                writes.push(() => this.replace('comment', id, { row: row + rowShift, column: column + columnShift }));
            }
        }
        if (fromHere && !oneSheet) {
            for (const id of carried.keys()) writes.push(() => this.replace('merge', id, undefined));
            for (const [id] of comments) writes.push(() => this.replace('comment', id, undefined));
        }

        // A range wholly in the block goes along; one the block lands on stays, and as the move back would take it,
        // undo puts it back. A rule's ranges keep to its sheet, while a chart's refs follow the block to another.
        const along = (sheet: string, range: Rect) => sheet === op.sheet && within(range, block);
        const landedOn = (sheet: string, range: Rect) =>
            sheet === op.toSheet && !along(sheet, range) && within(range, target);
        const carries = oneSheet && fromHere;
        // The list itself when no range moves.
        const moved = (list: Rect[]): Rect[] =>
            carries && list.some((range) => along(this.sheet, range))
                ? list.map((range) => (along(this.sheet, range) ? shifted(range) : range))
                : list;
        const returns = (list: readonly Rect[]) => carries && list.some((range) => landedOn(this.sheet, range));
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
            const formula = host
                ? withFormula(ruled, (tree) => transformMove(tree, move, this.sheet, ...host).tree)
                : ruled;
            if (formula === 'key-too-long') return formula;
            const backHost = moveHost(formula.ranges, target, toHere, carries && within(formula.ranges[0], target));
            const back = backHost
                ? withFormula(formula, (tree) => transformMove(tree, reverse, this.sheet, ...backHost).tree)
                : formula;
            if (formula !== rule) writes.push(() => this.replace('conditionalFormat', id, formula));
            if (back === 'key-too-long' || formulaOf(back) !== formulaOf(rule) || returns(rule.ranges)) {
                restore.push(this.wholeOp('conditionalFormat', id, rule));
            }
        }
        for (const [id, chart] of this.stored.chart) {
            let landed = false;
            const next = mapChartRefs(chart, (ref) => {
                const range: Rect = [ref.row[0], ref.column[0], ref.row[1], ref.column[1]];
                landed ||= landedOn(ref.sheetId, range);
                if (!along(ref.sheetId, range)) return ref;
                const [t, l, b, r] = shifted(range);
                return { ...ref, sheetId: op.toSheet, row: [t, b], column: [l, r] };
            });
            if (next !== chart && exceedsChartSpecBytes(next)) return 'key-too-long';
            if (next !== chart) writes.push(() => this.replace('chart', id, next));
            if (landed) restore.push(this.restoreOp('chart', id, chart, false));
        }
        return {
            restore: inOrder(restore),
            commit: () => {
                for (const write of writes) write();
            },
        };
    }

    private overlaps(id: string, rect: Rect): boolean {
        return this.places.merge.meeting(rect).some(([other]) => other !== id);
    }

    // The filter of this id and its columns go, and come back in that order.
    private removeFilter(id: string): RecordOp[] {
        const restore = this.swap('filter', id, undefined);
        if (restore.length === 0) return restore;
        for (const [columnId, column] of this.stored.filterColumn) {
            if (column.filter === id) restore.push(...this.swap('filterColumn', columnId, undefined));
        }
        return inOrder(restore);
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

    // Every write lands here, which keeps the indexes of where the records lie in step.
    private replace<T extends Kind>(type: T, id: string, record: Records[T] | undefined): void {
        const old = this.stored[type].get(id);
        if (record === undefined) this.stored[type].delete(id);
        else {
            Object.freeze(record);
            this.stored[type].set(id, record);
        }
        const places: { readonly [K in Kind]?: RectIndex } = this.places;
        places[type]?.set(id, old && RECTS[type]?.(old), record && RECTS[type]?.(record));
    }
}

// The ops in the one order every reader lists them, whatever order its records were made in: the sheet's own fields
// first, then by type, a filter before its columns, then by id.
function inOrder(ops: RecordOp[]): RecordOp[] {
    const rank = (op: RecordOp) => (op.type === 'sheet' ? -1 : KINDS.indexOf(op.type));
    return ops.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Where a rule is read during a move: the top-left of its first range, or, when the block leaves its sheet with cells
// of the rule but not that range, the first cell it leaves behind. None when the block holds every range.
function moveHost(
    ranges: readonly Rect[],
    block: Rect,
    fromSheet: boolean,
    firstMoves: boolean,
): [number, number] | undefined {
    const [[firstTop, firstLeft]] = ranges;
    if (!fromSheet || firstMoves) return [firstTop, firstLeft];
    for (const [top, left, bottom, right] of ranges) {
        if (!covers(block, top, left)) return [top, left];
        if (right > block[3]) return [top, block[3] + 1];
        if (bottom > block[2]) return [block[2] + 1, left];
    }
    return undefined;
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
