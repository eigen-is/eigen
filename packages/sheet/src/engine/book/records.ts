// The records of one sheet in the workbook model, such as its merges, its filter, its comments and the rules over its
// ranges, kept by type and id as frozen objects a change replaces, so an unchanged record keeps its reference. It
// works out where every record goes when rows or columns are inserted or deleted or a block of cells moves, with the
// record ops that undo puts after the inverse edit. The workbook's applier calls it: it checks and plans first and
// writes only once nothing can refuse.

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
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import { compareRules } from '@workspace/lib/sheets';
import type {
    ConditionalFormatRecord,
    FieldsOf,
    LinesOp,
    MoveOp,
    RecordOp,
    Records,
    RecordType,
    Rect,
    SheetContent,
    SheetFields,
    Span,
    ValidationRecord,
} from '@workspace/lib/sheets/ops';
import { covers, sameRect, within } from '@workspace/lib/sheets/rect';
import { mapChartRefs } from '../chart-data';
import { RectIndex } from './rect-index';

type Kind = Exclude<RecordType, 'sheet'>;
type ChangedKind = Exclude<Kind, 'conditionalFormat'>;
type RuleKind = 'conditionalFormat' | 'validation';
// How a span meets the grid's end under a line edit: a merge's end moves as a line does, a filter's end on the last
// line stays there, and a rule's or a chart's range over the whole axis, Excel's `A:A`, also stays whole.
type Reach = 'closed' | 'open' | 'whole';

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
        const span = (start: number, end: number, reach: Reach): Span | null => {
            const after = spanAfter(axis, start, end, reach);
            const back = after && spanAfter(inverse, after[0], after[1], reach);
            if (!back || back[0] !== start || back[1] !== end) kept = false;
            return after;
        };
        const line = (index: number): number => {
            const after = mapIndex(axis, index);
            if (after === GONE || mapIndex(inverse, after) !== index) kept = false;
            return after;
        };
        const rectAfter = (rect: Rect, reach: Reach): Rect | null => {
            const [top, left, bottom, right] = rect;
            const after = span(...lineSpan(rect, rows), reach);
            return after && (rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]]);
        };
        // The list itself when no range moves.
        const ranges = (list: Rect[]): Rect[] => {
            const next = list.flatMap((range) => {
                const after = rectAfter(range, 'whole');
                return after ? [sameRect(after, range) ? range : after] : [];
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
                const rect = rectAfter(merge.rect, 'closed');
                // A merge the edit cuts to one cell is a merge no more, as in Excel.
                const single = rect && rect[0] === rect[2] && rect[1] === rect[3] && (top !== bottom || left !== right);
                settle('merge', id, merge, !rect || single ? undefined : sameRect(rect, merge.rect) ? merge : { rect });
            }
            const removed = new Set<string>();
            for (const [id, filter] of this.stored.filter) {
                // The header row holds the filter's buttons, so a delete of it removes the filter.
                const header = rows && !edit.insert && mapIndex(axis, filter.rect[0]) === GONE;
                const rect = header ? null : rectAfter(filter.rect, 'open');
                if (!rect) removed.add(id);
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
                    const after = span(start, end, 'open');
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
            // The formula is read at the top-left of the first range the edit leaves, on its first line that stays.
            const first = here
                ? rule.ranges.findIndex((range) => spanAfter(axis, ...lineSpan(range, rows), 'whole'))
                : 0;
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
                const after = span(start, end, 'whole');
                if (!after) return null;
                if (after[0] === start && after[1] === end) return ref;
                return rows ? { ...ref, row: [...after] } : { ...ref, column: [...after] };
            });
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

    // A block moved on this sheet or to another, `source` being the sheet it leaves: its comments and the merges wholly
    // in it go along, on one sheet its rule ranges too. A merge or a comment it lands on goes, a merge it cuts anywhere
    // refuses, and so does a record it brings whose id the sheet it lands on keeps.
    public planMove(op: MoveOp, source: SheetRecords): Planned | 'merge-cut' | 'id-in-use' | 'key-too-long' {
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
            const removed = { merge: new Set<string>(), comment: new Set<string>() };
            for (const [id, rect] of this.places.merge.meeting(target)) {
                if (oneSheet && carried.has(id)) continue;
                if (!within(rect, target)) return 'merge-cut';
                removed.merge.add(id);
                restore.push(this.wholeOp('merge', id, { rect }));
                writes.push(() => this.replace('merge', id, undefined));
            }
            for (const [id, [row, column]] of this.places.comment.meeting(target)) {
                if (oneSheet && moving.has(id)) continue;
                removed.comment.add(id);
                restore.push(this.wholeOp('comment', id, { row, column }));
                writes.push(() => this.replace('comment', id, undefined));
            }
            // Ids are a sheet's own, so a block from another sheet may bring one this sheet keeps for another record:
            // it is refused, as a comment's id is its thread's outside the workbook.
            if (!oneSheet) {
                for (const id of carried.keys()) {
                    if (this.stored.merge.has(id) && !removed.merge.has(id)) return 'id-in-use';
                }
                for (const id of moving) {
                    if (this.stored.comment.has(id) && !removed.comment.has(id)) return 'id-in-use';
                }
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

        const carries = oneSheet && fromHere;
        // The list itself when no range moves.
        const moved = (list: Rect[]): Rect[] =>
            carries && list.some((range) => within(range, block))
                ? list.map((range) => (within(range, block) ? shifted(range) : range))
                : list;
        const returns = (list: readonly Rect[]) =>
            carries && list.some((range) => !within(range, block) && within(range, target));
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
            const backHost = moveHost(formula.ranges, target, toHere, carries && within(formula.ranges[0], target));
            const back = backHost
                ? withFormula(formula, (tree) => transformMove(tree, reverse, this.sheet, ...backHost))
                : formula;
            if (formula !== rule) writes.push(() => this.replace('conditionalFormat', id, formula));
            if (back === 'key-too-long' || formulaOf(back) !== formulaOf(rule) || returns(rule.ranges)) {
                restore.push(this.wholeOp('conditionalFormat', id, rule));
            }
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

// The lines `start` to `end` after the edit, or null when none is left.
function spanAfter(edit: Edit, start: number, end: number, reach: Reach): Span | null {
    const toEnd = reach !== 'closed' && end === edit.lines - 1;
    if (toEnd && reach === 'whole' && start === 0) return [start, end];
    const into = { start: 0, end: 0 };
    if (!mapSpan(edit, start, end, into)) return null;
    return [into.start, toEnd ? end : into.end];
}

// An insert before the last frozen line freezes the new lines too, up to the grid's end; a delete takes the frozen
// lines it deletes.
function frozenAfter({ insert, index, count, lines }: Edit, frozen: number): number {
    if (index >= frozen) return frozen;
    return insert ? Math.min(frozen + count, lines) : frozen - Math.min(count, frozen - index);
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

function lineSpan([top, left, bottom, right]: Rect, rows: boolean): Span {
    return rows ? [top, bottom] : [left, right];
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
