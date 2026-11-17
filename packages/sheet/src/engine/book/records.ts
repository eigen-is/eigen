// The records of the workbook model, such as merges, filters, comments and the rules over ranges, and each sheet's
// fields. An id names one record of its type in the whole book, so one store keeps every record beside its sheet, and
// per sheet its records by type and where they lie. A record is a frozen object a change replaces. It works out where
// records go when lines are inserted or deleted or a block moves, with the record ops undo puts after the inverse
// edit; the workbook's appliers call it, and it checks and plans first and writes only once nothing can refuse.

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
import { moveOf } from './apply-move';
import {
    chartAfter,
    commentAfter,
    filterAfter,
    filterColumnAfter,
    LineMap,
    lineSpan,
    mergeAfter,
    ruleAfter,
    ruleFormula,
    sheetAfter,
    validationAfter,
    withFormula,
} from './record-lines';
import { RectIndex } from './rect-index';

type Kind = Exclude<RecordType, 'sheet'>;
type ChangedKind = Exclude<Kind, 'conditionalFormat'>;
type RuleKind = 'conditionalFormat' | 'validation';
// A line edit or a move worked out: the record ops that undo applies after the inverse edit, in an order that
// applies, and the writes, which cannot fail.
type Planned = { readonly restore: readonly RecordOp[]; readonly commit: () => void };

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

type Held = {
    readonly sheet: string;
    fields: SheetFields;
    readonly stored: { readonly [T in Kind]: Map<string, Records[T]> };
    readonly places: { merge: RectIndex; comment: RectIndex; conditionalFormat: RectIndex; validation: RectIndex };
};

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

export class BookRecords {
    private readonly sheets = new Map<string, Held>();
    // The sheet that holds each record, under its type and id: an id names one record of its type in the whole book.
    private readonly owner = new Map<string, Held>();

    public add(sheet: string, fields: SheetFields, records: SheetContent['records']): void {
        const held: Held = {
            sheet,
            fields: Object.freeze(fields),
            stored: {
                merge: new Map(),
                filter: new Map(),
                filterColumn: new Map(),
                comment: new Map(),
                conditionalFormat: new Map(),
                validation: new Map(),
                image: new Map(),
                chart: new Map(),
            },
            places: {
                merge: new RectIndex(),
                comment: new RectIndex(),
                conditionalFormat: new RectIndex(),
                validation: new RectIndex(),
            },
        };
        this.sheets.set(sheet, held);
        for (const type of KINDS) {
            for (const [id, record] of Object.entries(records[type] ?? {})) this.replace(type, held, id, record);
        }
    }

    public remove(sheet: string): void {
        const { stored } = this.held(sheet);
        for (const type of KINDS) for (const id of stored[type].keys()) this.owner.delete(ownerKey(type, id));
        this.sheets.delete(sheet);
    }

    public fields(sheet: string): SheetFields {
        return this.held(sheet).fields;
    }

    public records<T extends Kind>(sheet: string, type: T): ReadonlyMap<string, Records[T]> {
        return this.held(sheet).stored[type];
    }

    // Whether the book holds a record of one of the types of `records` under one of its ids.
    public inUse(records: SheetContent['records']): boolean {
        return KINDS.some((type) => Object.keys(records[type] ?? {}).some((id) => this.owner.has(ownerKey(type, id))));
    }

    // A sheet's records as a snapshot holds them: by type and by id in order, a type with no record left out.
    public content(sheet: string): SheetContent['records'] {
        const listed = <R>(records: ReadonlyMap<string, R>) =>
            Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : 1)));
        const { stored } = this.held(sheet);
        const { merge, filter, filterColumn, comment, conditionalFormat, validation, image, chart } = stored;
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
        for (const type of KINDS) if (stored[type].size === 0) delete content[type];
        return content;
    }

    // What the limit on records counts: the most records of one type on one sheet.
    public weight(): number {
        const sizes = [...this.sheets.values()].flatMap(({ stored }) => KINDS.map((type) => stored[type].size));
        return Math.max(0, ...sizes);
    }

    public merge(sheet: string, row: number, column: number): Rect | undefined {
        return this.held(sheet).places.merge.meeting([row, column, row, column])[0]?.[1];
    }

    public touchesMerge(sheet: string, rect: Rect): boolean {
        return this.held(sheet).places.merge.meeting(rect).length > 0;
    }

    public mergesIn(sheet: string, rect: Rect): readonly Rect[] {
        const merges = this.held(sheet)
            .places.merge.meeting(rect)
            .map(([, merge]) => merge);
        return merges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }

    // Where two rules cover a cell, the last in order has it.
    public validation(sheet: string, row: number, column: number): ValidationRecord | undefined {
        const { stored, places } = this.held(sheet);
        let last: [string, ValidationRecord] | undefined;
        for (const [id] of places.validation.meeting([row, column, row, column])) {
            const rule = stored.validation.get(id);
            if (rule && (!last || compareRules(rule.order, id, last[1].order, last[0]) > 0)) last = [id, rule];
        }
        return last?.[1];
    }

    // The rules with a range in the rectangle, in rule order, each with those ranges: what a paint of a screen reads.
    public rulesIn<T extends RuleKind>(
        sheet: string,
        type: T,
        rect: Rect,
    ): { id: string; rule: Records[T]; ranges: Rect[] }[] {
        const { stored, places } = this.held(sheet);
        const found = [...Map.groupBy(places[type].meeting(rect), ([id]) => id)].flatMap(([id, pairs]) => {
            const rule = stored[type].get(id);
            return rule ? [{ id, rule, ranges: pairs.map(([, range]) => range) }] : [];
        });
        return found.sort((a, b) => compareRules(a.rule.order, a.id, b.rule.order, b.id));
    }

    public comments(sheet: string, row: number, column: number): readonly string[] {
        const found = this.held(sheet).places.comment.meeting([row, column, row, column]);
        return found.map(([id]) => id).sort();
    }

    // Whole makes or replaces a record, a `set` alone changes the fields it names, null clearing one, and no `set`
    // deletes. A write that is skipped, such as a change of a record that is gone, returns no inverse.
    public write(op: RecordOp): RecordOp[] | 'id-in-use' | 'merge-overlap' | 'key-too-long' {
        const held = this.held(op.sheet);
        if (op.type === 'sheet') {
            const before = fieldsBefore(held.fields, op.set);
            held.fields = Object.freeze(withFields(held.fields, op.set));
            return Object.keys(before).length > 0
                ? [{ kind: 'record', sheet: op.sheet, type: 'sheet', id: op.id, set: before }]
                : [];
        }
        // A record another sheet holds is not this sheet's to change or delete, nor its id this sheet's to make.
        const at = this.owner.get(ownerKey(op.type, op.id));
        if (at && at !== held) return op.whole ? 'id-in-use' : [];
        const { stored } = held;
        if (op.whole) {
            switch (op.type) {
                case 'merge':
                    if (overlaps(held, op.id, op.set.rect)) return 'merge-overlap';
                    return this.swap(held, 'merge', op.id, op.set);
                case 'filter': {
                    const restore = [...stored.filter.keys()].flatMap((id) => this.removeFilter(held, id));
                    this.replace('filter', held, op.id, op.set);
                    return restore.length > 0 ? restore : [MADE_OP.filter({ sheet: op.sheet, id: op.id })];
                }
                case 'filterColumn':
                    if (!stored.filter.has(op.set.filter)) return [];
                    return this.swap(held, 'filterColumn', op.id, op.set);
                default:
                    return this.swap(held, op.type, op.id, op.set);
            }
        }
        if (!op.set) return op.type === 'filter' ? this.removeFilter(held, op.id) : this.swap(held, op.type, op.id);
        if (op.type === 'merge') {
            const old = stored.merge.get(op.id);
            if (old && overlaps(held, op.id, op.set.rect ?? old.rect)) return 'merge-overlap';
        }
        if (op.type === 'filterColumn') {
            const old = stored.filterColumn.get(op.id);
            if (old && !stored.filter.has(op.set.filter ?? old.filter)) return [];
        }
        if (op.type === 'chart') {
            const old = stored.chart.get(op.id);
            if (old && exceedsChartSpecBytes(withFields(old, op.set))) return 'key-too-long';
        }
        return this.change(held, op.type, op.id, op.set);
    }

    // Whether the insert would push a record off the grid's end: a comment or a merge on a pushed line, or a record
    // range that starts or ends on one. A range that reaches the last line is open and passes.
    public wouldPush({ sheet, rows, count }: LinesOp): boolean {
        const { stored } = this.held(sheet);
        const last = (rows ? GRID_ROWS : GRID_COLUMNS) - 1;
        const pushed = last + 1 - count;
        const spanPushed = (start: number, end: number) => start >= pushed || (end >= pushed && end !== last);
        const rectPushed = (rect: Rect) => spanPushed(...lineSpan(rect, rows));
        for (const { rect } of stored.merge.values()) if (rect[rows ? 2 : 3] >= pushed) return true;
        for (const { row, column } of stored.comment.values()) if ((rows ? row : column) >= pushed) return true;
        for (const { rect } of stored.filter.values()) if (rectPushed(rect)) return true;
        for (const { column, rows: spans } of stored.filterColumn.values()) {
            if (rows ? spans.some(([start, end]) => spanPushed(start, end)) : column >= pushed) return true;
        }
        for (const { ranges } of [...stored.conditionalFormat.values(), ...stored.validation.values()]) {
            if (ranges.some(rectPushed)) return true;
        }
        return false;
    }

    // Lines inserted or deleted on one sheet: there every range, place and the frozen panes move; on every sheet, a
    // rule's formula and a chart's refs follow the lines they name.
    public planLines(edit: LinesOp): Planned | 'key-too-long' {
        const held = this.held(edit.sheet);
        const map = new LineMap(edit);
        const writes: (() => void)[] = [];
        const restore: RecordOp[] = [];
        // Undo puts back a record the inverse edit does not give back as it was.
        const settle = <T extends ChangedKind>(
            type: T,
            on: Held,
            id: string,
            old: Records[T],
            next: Records[T] | undefined,
            kept: boolean,
        ) => {
            if (next !== old) writes.push(() => this.replace(type, on, id, next));
            if (!kept || next === undefined) restore.push(restoreOp(type, on.sheet, id, old, next === undefined));
        };

        const [fields, kept] = map.through(() => sheetAfter(held.fields, map));
        if (fields !== held.fields) {
            writes.push(() => {
                held.fields = Object.freeze(withFields(held.fields, fields));
            });
        }
        if (!kept) {
            const { frozenRows, frozenColumns } = held.fields;
            const set = map.rows ? { frozenRows } : { frozenColumns };
            restore.push({ kind: 'record', sheet: edit.sheet, type: 'sheet', id: edit.sheet, set });
        }
        const { stored } = held;
        for (const [id, merge] of stored.merge) {
            settle('merge', held, id, merge, ...map.through(() => mergeAfter(merge, map)));
        }
        const removed = new Set<string>();
        for (const [id, filter] of stored.filter) {
            const [next, kept] = map.through(() => filterAfter(filter, map));
            if (!next) removed.add(id);
            settle('filter', held, id, filter, next, kept);
        }
        for (const [id, column] of stored.filterColumn) {
            if (removed.has(column.filter)) settle('filterColumn', held, id, column, undefined, true);
            else settle('filterColumn', held, id, column, ...map.through(() => filterColumnAfter(column, map)));
        }
        for (const [id, comment] of stored.comment) {
            settle('comment', held, id, comment, ...map.through(() => commentAfter(comment, map)));
        }
        for (const [id, validation] of stored.validation) {
            settle('validation', held, id, validation, ...map.through(() => validationAfter(validation, map)));
        }
        for (const on of this.sheets.values()) {
            for (const [id, rule] of on.stored.conditionalFormat) {
                const [next, kept] = map.through(() => ruleAfter(rule, map, on.sheet));
                if (next === 'key-too-long') return next;
                if (next !== rule) writes.push(() => this.replace('conditionalFormat', on, id, next));
                // A rule changes only whole, so it comes back whole.
                if (!kept || next === undefined) restore.push(wholeOp('conditionalFormat', on.sheet, id, rule));
            }
            for (const [id, chart] of on.stored.chart) {
                const [next, kept] = map.through(() => chartAfter(chart, map));
                if (next !== chart && exceedsChartSpecBytes(next)) return 'key-too-long';
                settle('chart', on, id, chart, next, kept);
            }
        }
        return planned(restore, writes);
    }

    // A block moved on one sheet or to another: its comments, the merges and the chart refs wholly in it go along,
    // on one sheet its rule ranges too. A merge or a comment it lands on goes, and a merge it cuts anywhere refuses.
    public planMove(op: MoveOp): Planned | 'merge-cut' | 'key-too-long' {
        const from = this.held(op.sheet);
        const to = this.held(op.toSheet);
        const block = op.from;
        const [top, left] = block;
        const rowShift = op.toRow - top;
        const columnShift = op.toColumn - left;
        const shifted = ([t, l, b, r]: Rect): Rect => [t + rowShift, l + columnShift, b + rowShift, r + columnShift];
        const target = shifted(block);
        const oneSheet = from === to;
        const move = moveOf(op);
        const home = { sheet: op.toSheet, toSheet: op.sheet, toRow: top, toColumn: left };
        const reverse = moveOf({ ...op, ...home, from: target });
        const writes: (() => void)[] = [];
        const restore: RecordOp[] = [];

        const carried = new Map(from.places.merge.meeting(block));
        if ([...carried.values()].some((rect) => !within(rect, block))) return 'merge-cut';
        const comments = from.places.comment.meeting(block);
        const moving = new Set(comments.map(([id]) => id));
        // A range wholly in the block goes along; one the block lands on stays, and as the move back would take it,
        // undo puts it back. A rule's ranges keep to its sheet, while a chart's refs follow the block to another.
        const along = (sheet: string, range: Rect) => sheet === op.sheet && within(range, block);
        const landedOn = (sheet: string, range: Rect) =>
            sheet === op.toSheet && !along(sheet, range) && within(range, target);
        // On one sheet a rule's ranges wholly in the block go along: the list itself when none does.
        const moved = (list: Rect[]): Rect[] =>
            list.some((range) => within(range, block))
                ? list.map((range) => (within(range, block) ? shifted(range) : range))
                : list;
        const returns = (list: readonly Rect[]) => list.some((range) => !within(range, block) && within(range, target));
        if (oneSheet) {
            for (const [id, validation] of from.stored.validation) {
                const ranges = moved(validation.ranges);
                if (ranges !== validation.ranges)
                    writes.push(() => this.replace('validation', from, id, { ...validation, ranges }));
                if (returns(validation.ranges)) restore.push(restoreOp('validation', op.sheet, id, validation, false));
            }
        }
        // The sheet the block leaves plans first and the one it lands on next: a refusal's key is the first found.
        for (const on of new Set([from, to, ...this.sheets.values()])) {
            if (on === to) {
                // What lies under where the block lands goes, merges and comments alike, but for what the block brings.
                for (const [id, rect] of to.places.merge.meeting(target)) {
                    if (carried.has(id)) continue;
                    if (!within(rect, target)) return 'merge-cut';
                    restore.push(wholeOp('merge', op.toSheet, id, { rect }));
                    writes.push(() => this.replace('merge', to, id, undefined));
                }
                for (const [id, [row, column]] of to.places.comment.meeting(target)) {
                    if (moving.has(id)) continue;
                    restore.push(wholeOp('comment', op.toSheet, id, { row, column }));
                    writes.push(() => this.replace('comment', to, id, undefined));
                }
                for (const [id, rect] of carried)
                    writes.push(() => this.replace('merge', to, id, { rect: shifted(rect) }));
                for (const [id, [row, column]] of comments) {
                    writes.push(() =>
                        this.replace('comment', to, id, { row: row + rowShift, column: column + columnShift }),
                    );
                }
            }
            const carries = oneSheet && on === from;
            for (const [id, rule] of on.stored.conditionalFormat) {
                const ranges = carries ? moved(rule.ranges) : rule.ranges;
                const ruled = ranges === rule.ranges ? rule : { ...rule, ranges };
                const host = moveHost(rule.ranges, block, on === from, ranges[0] !== rule.ranges[0]);
                const formula = host
                    ? withFormula(ruled, (tree) => transformMove(tree, move, on.sheet, ...host).tree)
                    : ruled;
                if (formula === 'key-too-long') return formula;
                const lands = carries && within(formula.ranges[0], target);
                const backHost = moveHost(formula.ranges, target, on === to, lands);
                const back = backHost
                    ? withFormula(formula, (tree) => transformMove(tree, reverse, on.sheet, ...backHost).tree)
                    : formula;
                if (formula !== rule) writes.push(() => this.replace('conditionalFormat', on, id, formula));
                const returned = carries && returns(rule.ranges);
                if (back === 'key-too-long' || ruleFormula(back) !== ruleFormula(rule) || returned) {
                    restore.push(wholeOp('conditionalFormat', on.sheet, id, rule));
                }
            }
            for (const [id, chart] of on.stored.chart) {
                let landed = false;
                const next = mapChartRefs(chart, (ref) => {
                    const range: Rect = [ref.row[0], ref.column[0], ref.row[1], ref.column[1]];
                    landed ||= landedOn(ref.sheetId, range);
                    if (!along(ref.sheetId, range)) return ref;
                    const [t, l, b, r] = shifted(range);
                    return { ...ref, sheetId: op.toSheet, row: [t, b], column: [l, r] };
                });
                if (next !== chart && exceedsChartSpecBytes(next)) return 'key-too-long';
                if (next !== chart) writes.push(() => this.replace('chart', on, id, next));
                if (landed) restore.push(restoreOp('chart', on.sheet, id, chart, false));
            }
        }
        return planned(restore, writes);
    }

    private held(sheet: string): Held {
        const held = this.sheets.get(sheet);
        if (!held) throw new Error(`No sheet ${sheet}`);
        return held;
    }

    // The filter of this id and its columns go, and come back in that order.
    private removeFilter(held: Held, id: string): RecordOp[] {
        const restore = this.swap(held, 'filter', id);
        if (restore.length === 0) return restore;
        for (const [columnId, column] of held.stored.filterColumn) {
            if (column.filter === id) restore.push(...this.swap(held, 'filterColumn', columnId));
        }
        return inOrder(restore);
    }

    // Puts a record in place of the one under its id, none deleting it, and returns the op that puts the old one back.
    private swap<T extends Kind>(held: Held, type: T, id: string, record?: Records[T]): RecordOp[] {
        const old = held.stored[type].get(id);
        if (old === undefined && record === undefined) return [];
        this.replace(type, held, id, record);
        return [old === undefined ? MADE_OP[type]({ sheet: held.sheet, id }) : wholeOp(type, held.sheet, id, old)];
    }

    private change<T extends ChangedKind>(held: Held, type: T, id: string, set: FieldsOf<Records[T]>): RecordOp[] {
        const old = held.stored[type].get(id);
        if (old === undefined) return [];
        const before = fieldsBefore(old, set);
        this.replace(type, held, id, withFields(old, set));
        return Object.keys(before).length > 0 ? [CHANGE_OP[type]({ sheet: held.sheet, id, set: before })] : [];
    }

    // Every write lands here, which keeps the sheet of each record and the indexes of where they lie in step. A
    // record written to another sheet than the one that holds it, as a move carries it, leaves that one.
    private replace<T extends Kind>(type: T, held: Held, id: string, record: Records[T] | undefined): void {
        const key = ownerKey(type, id);
        const was = this.owner.get(key);
        if (was && was !== held) this.replace(type, was, id, undefined);
        const old = held.stored[type].get(id);
        if (record === undefined) {
            held.stored[type].delete(id);
            this.owner.delete(key);
        } else {
            Object.freeze(record);
            held.stored[type].set(id, record);
            this.owner.set(key, held);
        }
        const places: { readonly [K in Kind]?: RectIndex } = held.places;
        places[type]?.set(id, old && RECTS[type]?.(old), record && RECTS[type]?.(record));
    }
}

function ownerKey(type: Kind, id: string): string {
    return `${type} ${id}`;
}

function planned(restore: RecordOp[], writes: readonly (() => void)[]): Planned {
    return {
        restore: inOrder(restore),
        commit: () => {
            for (const write of writes) write();
        },
    };
}

function overlaps(held: Held, id: string, rect: Rect): boolean {
    return held.places.merge.meeting(rect).some(([other]) => other !== id);
}

function wholeOp<T extends Kind>(type: T, sheet: string, id: string, record: Records[T]): RecordOp {
    return MADE_OP[type]({ sheet, id, set: record, whole: 1 });
}

// A record that is gone comes back whole; one that is there has every field set back, since a whole make of a
// filter would take its columns.
function restoreOp<T extends ChangedKind>(
    type: T,
    sheet: string,
    id: string,
    old: Records[T],
    gone: boolean,
): RecordOp {
    return gone ? wholeOp(type, sheet, id, old) : CHANGE_OP[type]({ sheet, id, set: old });
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
