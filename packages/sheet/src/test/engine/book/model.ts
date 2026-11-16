// The model the workbook's appliers are held to: a workbook as plain data, a cell at a time, with no engine, no bands
// and no runs. Content is a map of cells, looks are a plain grid, line keys a map of lines and records a map per type.
// `modelAfter` applies a batch of ops of every kind the slow, obvious way, and `expectReads` holds a real workbook to
// it. Formula texts are the engine's own spelling, as the batches of these tests write them, bound where they enter as
// the engine binds them. A computed value is not modelled, only a given one: the model says what a cell holds, the
// engine what it computes.

import { expect } from 'bun:test';
import type { FormulaNode, LineEdit, Move } from '@workspace/formula/text';
import {
    bindSheet,
    ERROR_LITERALS,
    findSheetByName,
    GRID_COLUMNS,
    GRID_ROWS,
    NodeKind,
    parseStored,
    SheetKind,
    sheetNameKey,
    storedKey,
    transformLines,
    transformMove,
} from '@workspace/formula/text';
import { exceedsChartSpecBytes } from '@workspace/lib/charts';
import { compareRules } from '@workspace/lib/sheets';
import type {
    Batch,
    CellAttrs,
    CellContent,
    CellRecord,
    FieldsOf,
    FormatOp,
    InputOp,
    LineAttrs,
    LinesOp,
    MoveOp,
    Op,
    Placed,
    RecordOp,
    Records,
    RecordType,
    Rect,
    Run,
    SheetContent,
    SheetFields,
    SheetOp,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { MAX_SHEET_NAME_LENGTH } from '@workspace/lib/sheets/sheet-name';
import type { Workbook } from '../../../engine/book/workbook';
import { mapChartRefs } from '../../../engine/chart-data';
import type { Book } from './book-fixtures';
import { LooksGrid } from './looks-grid';

type Kind = Exclude<RecordType, 'sheet'>;
type ChangedKind = Exclude<Kind, 'conditionalFormat'>;
type RecordMaps = { readonly [T in Kind]: Map<string, Records[T]> };
type Named = { readonly id: string; readonly name: string };

export type ModelSheet = {
    readonly id: string;
    fields: SheetFields;
    // By `row,column`. A cell's content is replaced, never changed in place. A formula holds `f`, and a value only
    // when it is one this build cannot evaluate and its value was given.
    cells: Map<string, CellContent>;
    // Ids of `Model.looks`.
    looks: LooksGrid;
    rows: Map<number, LineAttrs>;
    columns: Map<number, LineAttrs>;
    records: RecordMaps;
};

// `looks[0]` is the plain look, and equal looks share an id.
export type Model = { g: number; now: number; seed: number; looks: CellAttrs[]; sheets: Map<string, ModelSheet> };

const RUN_KEYS = ['bl', 'it', 'ff', 'fs', 'fc', 'cl', 'un'] as const;
const REF_VALUE = ERROR_LITERALS.indexOf('#REF!') + 1;
const LAST_ROW = GRID_ROWS - 1;
const LAST_COLUMN = GRID_COLUMNS - 1;

export function modelOf(content: Book): Model {
    const model: Model = { g: content.g, now: content.now, seed: content.seed, looks: [{}], sheets: new Map() };
    const sheets = content.sheets.map(({ id, fields }) => ({ id, name: fields.name }));
    for (const sheet of content.sheets) model.sheets.set(sheet.id, sheetOf(model, sheet, sheets));
    return model;
}

// The model after a batch, or the key of the refusal that leaves the model as it is. A too long stored key and a
// chart past its size bound are foreseen; the weigh of the limits, such as too many records or sheets, is not.
export function modelAfter(model: Model, batch: Pick<Batch, 'now' | 'seed' | 'ops'>): Model | RefusalKey {
    const next: Model = { ...model, looks: [...model.looks], sheets: new Map() };
    for (const [id, sheet] of model.sheets) {
        next.sheets.set(id, {
            ...sheet,
            cells: new Map(sheet.cells),
            looks: sheet.looks.clone(),
            rows: new Map(sheet.rows),
            columns: new Map(sheet.columns),
            records: mapsOf(listed(sheet.records)),
        });
    }
    for (const op of batch.ops) {
        const refusal = applyOne(next, op);
        if (refusal) return refusal;
    }
    next.now = batch.now;
    next.seed = batch.seed;
    return next;
}

// The model as a snapshot holds it, in the one form a workbook walks back to: computed when it holds no formula,
// as the model computes none.
export function contentOfModel(model: Model): Book {
    const sheets = [...model.sheets.values()].sort((a, b) => compareRules(a.fields.order, a.id, b.fields.order, b.id));
    return {
        g: model.g,
        now: model.now,
        seed: model.seed,
        computed: !sheets.some(({ cells }) => [...cells.values()].some((cell) => cell.f !== undefined)),
        sheets: sheets.map((sheet) => {
            const cells = [...sheet.cells].map(([place, cell]): Placed<CellRecord> => [...placeOf(place), cell]);
            cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
            sheet.looks.tidy();
            const flat = sheet.looks.flat(true);
            const looks: CellAttrs[] = [];
            const indexes = new Map([[0, 0]]);
            const bands: number[] = [];
            for (let at = 0; at < flat.length; at += 2 + 2 * flat[at + 1]) {
                bands.push(flat[at], flat[at + 1]);
                for (let i = at + 2; i < at + 2 + 2 * flat[at + 1]; i += 2) {
                    if (!indexes.has(flat[i + 1])) indexes.set(flat[i + 1], looks.push(model.looks[flat[i + 1]]));
                    bands.push(flat[i], indexes.get(flat[i + 1]) ?? 0);
                }
            }
            return {
                id: sheet.id,
                fields: sheet.fields,
                cells,
                looks,
                bands,
                rows: lineRuns(sheet.rows),
                columns: lineRuns(sheet.columns),
                records: listed(sheet.records),
            };
        }),
    };
}

// Every place of the workbook reads as the model does: content, look, line keys, records, fields, tab order and the
// clock. A formula's value is the engine's, so it is left out on the workbook's side, but for a given one, which
// reads as given once every formula is computed.
export function expectReads(book: Workbook, model: Model): void {
    while (book.engine.recalc(Number.MAX_SAFE_INTEGER).stopped);
    const content = book.content();
    const read = {
        ...content,
        sheets: content.sheets.map((sheet) => ({
            ...sheet,
            cells: sheet.cells.map(([row, column, cell]): Placed<CellRecord> => [row, column, held(cell)]),
        })),
    };
    const expected = contentOfModel(model);
    expect(read).toEqual({ ...expected, computed: true });
    // The engine reads a sheet by its place among the tabs, which the content does not show.
    expect(expected.sheets.map((_, place) => book.engine.sheetAt(place))).toEqual(expected.sheets.map(({ id }) => id));
}

// A sheet as it enters, its formulas bound to `sheets`.
function sheetOf(model: Model, content: SheetContent, sheets: readonly Named[]): ModelSheet {
    const sheet: ModelSheet = {
        id: content.id,
        fields: content.fields,
        cells: new Map(),
        looks: new LooksGrid(),
        rows: new Map(),
        columns: new Map(),
        records: mapsOf(content.records),
    };
    for (const [row, column, { spill: _, ...cell }] of content.cells) {
        sheet.cells.set(key(row, column), entering(cell, sheets));
    }
    const named = [0, ...content.looks.map((look) => lookId(model, look))];
    const { bands } = content;
    for (let at = 0; at < bands.length; at += 2 + 2 * bands[at + 1]) {
        // A band runs to the grid's last column and a run to its last row: the next one writes over the rest.
        sheet.looks.format([0, bands[at], LAST_ROW, LAST_COLUMN], () => 0);
        for (let i = at + 2; i < at + 2 + 2 * bands[at + 1]; i += 2) {
            sheet.looks.format([bands[i], bands[at], LAST_ROW, LAST_COLUMN], () => named[bands[i + 1]]);
        }
    }
    for (const [lines, runs] of [
        [sheet.rows, content.rows],
        [sheet.columns, content.columns],
    ] as const) {
        for (const [[first, last], attrs] of runs) {
            for (let line = first; line <= last; line += 1) setLine(lines, line, attrs);
        }
    }
    return sheet;
}

function mapsOf(records: SheetContent['records']): RecordMaps {
    return {
        merge: new Map(Object.entries(records.merge ?? {})),
        filter: new Map(Object.entries(records.filter ?? {})),
        filterColumn: new Map(Object.entries(records.filterColumn ?? {})),
        comment: new Map(Object.entries(records.comment ?? {})),
        conditionalFormat: new Map(Object.entries(records.conditionalFormat ?? {})),
        validation: new Map(Object.entries(records.validation ?? {})),
        image: new Map(Object.entries(records.image ?? {})),
        chart: new Map(Object.entries(records.chart ?? {})),
    };
}

// The records by type and by id in order, a type with no record left undefined.
function listed(maps: RecordMaps): SheetContent['records'] {
    const byId = <R>(records: ReadonlyMap<string, R>) =>
        records.size === 0 ? undefined : Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
        merge: byId(maps.merge),
        filter: byId(maps.filter),
        filterColumn: byId(maps.filterColumn),
        comment: byId(maps.comment),
        conditionalFormat: byId(maps.conditionalFormat),
        validation: byId(maps.validation),
        image: byId(maps.image),
        chart: byId(maps.chart),
    };
}

// What a cell holds: a value beside a formula is the engine's to compute, but for a formula this build cannot
// evaluate, which keeps the value it was given. Given none, or #REF!, it reads #REF! either way.
function held(cell: CellContent): CellContent {
    if (cell.f === undefined) return cell;
    const { v, e, ...rest } = cell;
    return v !== undefined && !(e && v === '#REF!') && isKept(cell.f) ? cell : rest;
}

function isKept(text: string): boolean {
    const tree = parseStored(text);
    const crosses = (node: FormulaNode): boolean =>
        node.sheetKind === SheetKind.External || node.sheetKind === SheetKind.Span || node.children.some(crosses);
    return !('reason' in tree) && crosses(tree);
}

// A cell as the engine holds it once it enters: a formula typed with the name of a held sheet is bound to it, or
// holds #REF! in its place where the bound text is too long to store.
function entering(cell: CellContent, sheets: readonly Named[]): CellContent {
    if (cell.f === undefined) return cell;
    const tree = parseStored(cell.f);
    if ('reason' in tree) return held(cell);
    const bound = sheets.reduce((at, { id, name }) => bindSheet(at, name, id), tree);
    if (bound === tree) return held(cell);
    const key = storedKey(bound);
    const text = typeof key === 'string' ? key : storedKey(withoutNames(tree, sheets));
    return held({ ...cell, f: typeof text === 'string' ? text : cell.f });
}

// #REF! in place of every reference typed with the name of one of `sheets`.
function withoutNames(node: FormulaNode, sheets: readonly Named[]): FormulaNode {
    if (node.children.length > 0) {
        return { ...node, children: node.children.map((child) => withoutNames(child, sheets)) };
    }
    if (node.sheetKind !== SheetKind.Name || !findSheetByName(sheets, node.sheet)) return node;
    return {
        ...node,
        kind: NodeKind.Error,
        op: 0,
        value: REF_VALUE,
        text: '',
        sheetKind: SheetKind.Host,
        sheet: '',
        row: 0,
        column: 0,
        row2: 0,
        column2: 0,
        flags: 0,
    };
}

function namedOf(model: Model): Named[] {
    return [...model.sheets.values()].map(({ id, fields }) => ({ id, name: fields.name }));
}

function key(row: number, column: number): string {
    return `${row},${column}`;
}

function placeOf(place: string): [row: number, column: number] {
    const [row, column] = place.split(',').map(Number);
    return [row, column];
}

// A border side is one look whatever the order its keys come in, as a decoded snapshot sorts them.
function lookKey(look: CellAttrs): string {
    return JSON.stringify(
        LOOK_KEYS.map((name) => {
            const value = look[name];
            return typeof value === 'object' ? [value.style, value.color] : (value ?? null);
        }),
    );
}

function lookId(model: Model, look: CellAttrs): number {
    const wanted = lookKey(look);
    const found = model.looks.findIndex((other) => lookKey(other) === wanted);
    return found < 0 ? model.looks.push(look) - 1 : found;
}

function setLine(lines: Map<number, LineAttrs>, line: number, attrs: LineAttrs): void {
    if (attrs.size === undefined && attrs.custom === undefined && attrs.hidden === undefined) lines.delete(line);
    else lines.set(line, attrs);
}

function lineRuns(lines: ReadonlyMap<number, LineAttrs>): [Span, LineAttrs][] {
    const runs: [[number, number], LineAttrs][] = [];
    for (const [line, attrs] of [...lines].sort(([a], [b]) => a - b)) {
        const end = runs.at(-1);
        const same =
            end !== undefined &&
            end[0][1] + 1 === line &&
            end[1].size === attrs.size &&
            end[1].custom === attrs.custom &&
            end[1].hidden === attrs.hidden;
        if (same) end[0][1] = line;
        else runs.push([[line, line], attrs]);
    }
    return runs;
}

function withFields<R extends object>(record: R, set: FieldsOf<R>): R {
    const next = { ...record };
    for (const name in set) {
        const value = set[name];
        if (value === null) delete next[name];
        else if (value !== undefined) next[name] = value;
    }
    return next;
}

function meets(a: Rect, b: Rect): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function within(inner: Rect, outer: Rect): boolean {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function inside(row: number, column: number, rect: Rect): boolean {
    return within([row, column, row, column], rect);
}

function applyOne(model: Model, op: Op): RefusalKey | null {
    switch (op.kind) {
        case 'input':
            return applyInput(model, op);
        case 'format':
            return applyFormat(model, op);
        case 'record':
            return applyRecord(model, op);
        case 'lines':
            return applyLines(model, op);
        case 'move':
            return applyMove(model, op);
        case 'sheet':
            return applySheet(model, op);
    }
}

// An op on a sheet the workbook does not hold is skipped alone, whatever its kind.
function applyInput(model: Model, op: InputOp): null {
    const sheet = model.sheets.get(op.sheet);
    if (!sheet) return null;
    const named = namedOf(model);
    const put = (row: number, column: number, content: CellContent | null) => {
        if (content === null) sheet.cells.delete(key(row, column));
        else sheet.cells.set(key(row, column), content);
    };
    for (const [[top, left, bottom, right], content] of op.runs ?? []) {
        const cell = content && entering(content, named);
        for (let row = top; row <= bottom; row += 1) {
            for (let column = left; column <= right; column += 1) put(row, column, cell);
        }
    }
    for (const [row, column, content] of op.cells ?? []) {
        // The validators refuse an op that says a place twice, so a batch of these tests never holds one.
        if (op.runs?.some(([rect]) => inside(row, column, rect))) throw new Error('a listed cell inside a run');
        put(row, column, content && entering(content, named));
    }
    return null;
}

function applyFormat(model: Model, op: FormatOp): null {
    const sheet = model.sheets.get(op.sheet);
    if (!sheet) return null;
    if ('lines' in op) {
        const lines = op.lines === 'rows' ? sheet.rows : sheet.columns;
        for (const [first, last] of op.spans) {
            for (let line = first; line <= last; line += 1) {
                const attrs = { ...lines.get(line), ...op.set };
                for (const name of op.clear ?? []) delete attrs[name];
                setLine(lines, line, attrs);
            }
        }
        return null;
    }
    const { link, ...set } = op.set ?? {};
    const clear = op.clear ?? [];
    for (const rect of op.ranges) {
        sheet.looks.format(rect, (id) => {
            const look = { ...model.looks[id], ...set };
            for (const name of clear) if (name !== 'link') delete look[name];
            return lookId(model, look);
        });
    }
    // A run-style key is also set or cleared on every run of a rich cell.
    for (const [place, cell] of sheet.cells) {
        if (!cell.s || !op.ranges.some((rect) => inside(...placeOf(place), rect))) continue;
        const runs = cell.s.map((run): Run => {
            const next = { ...run };
            for (const name of RUN_KEYS) {
                if (name in set) Object.assign(next, { [name]: set[name] });
                else if (clear.includes(name)) delete next[name];
            }
            return next;
        });
        sheet.cells.set(place, { ...cell, s: runs });
    }
    if (link === undefined && !clear.includes('link')) return null;
    for (const [top, left, bottom, right] of op.ranges) {
        for (let row = top; row <= bottom; row += 1) {
            for (let column = left; column <= right; column += 1) {
                const { link: _, ...rest } = sheet.cells.get(key(row, column)) ?? {};
                const cell = link ? { ...rest, link } : rest;
                if (Object.keys(cell).length === 0) sheet.cells.delete(key(row, column));
                else sheet.cells.set(key(row, column), cell);
            }
        }
    }
    return null;
}

function applyRecord(model: Model, op: RecordOp): RefusalKey | null {
    const sheet = model.sheets.get(op.sheet);
    if (!sheet) return null;
    // A record's id is unique in the book among the records of its type, so a make under one another sheet holds is
    // refused, whatever else the make would meet.
    if (op.whole && [...model.sheets.values()].some((other) => other !== sheet && other.records[op.type].has(op.id))) {
        return 'id-in-use';
    }
    if (op.type === 'sheet') {
        const { name, hide } = op.set;
        const others = [...model.sheets.values()].filter((other) => other !== sheet);
        if (hide === 1 && !sheet.fields.hide && others.every((other) => other.fields.hide)) return 'last-sheet';
        if (name && name !== sheet.fields.name) {
            // A rename to a name another sheet has is skipped alone, with every other field the op sets.
            if (others.some((other) => sheetNameKey(other.fields.name) === sheetNameKey(name))) return null;
            const refusal = rewrite(model.sheets.values(), (tree) => bindSheet(tree, name, sheet.id));
            if (refusal) return refusal;
        }
        sheet.fields = withFields(sheet.fields, op.set);
        return null;
    }
    const overlaps = (rect: Rect) =>
        [...sheet.records.merge].some(([id, merge]) => id !== op.id && meets(merge.rect, rect));
    if (op.whole) {
        if (op.type === 'merge' && overlaps(op.set.rect)) return 'merge-overlap';
        if (op.type === 'filterColumn' && !sheet.records.filter.has(op.set.filter)) return null;
        // A new filter takes the place of the live one, whose columns go with it.
        if (op.type === 'filter') for (const id of [...sheet.records.filter.keys()]) removeFilter(sheet, id);
        return put(sheet, op.type, op.id, op.set);
    }
    if (!op.set) {
        if (op.type === 'filter') removeFilter(sheet, op.id);
        return put(sheet, op.type, op.id, undefined);
    }
    return change(sheet, op.type, op.id, op.set, overlaps);
}

function put<T extends Kind>(sheet: ModelSheet, type: T, id: string, record: Records[T] | undefined): null {
    if (record === undefined) sheet.records[type].delete(id);
    else sheet.records[type].set(id, record);
    return null;
}

// A change of a record that is gone is skipped alone, as is a filter column moved to a filter that is not there. A
// chart change is refused when the chart it makes is past its size bound.
function change<T extends ChangedKind>(
    sheet: ModelSheet,
    type: T,
    id: string,
    set: FieldsOf<Records[T]>,
    overlaps: (rect: Rect) => boolean,
): RefusalKey | null {
    const old = sheet.records[type].get(id);
    if (old === undefined) return null;
    const next = withFields(old, set);
    if ('rect' in next && type === 'merge' && overlaps(next.rect)) return 'merge-overlap';
    if ('filter' in next && !sheet.records.filter.has(next.filter)) return null;
    if (type === 'chart' && exceedsChartSpecBytes(next)) return 'key-too-long';
    return put(sheet, type, id, next);
}

function removeFilter(sheet: ModelSheet, id: string): void {
    if (!sheet.records.filter.delete(id)) return;
    for (const [columnId, column] of sheet.records.filterColumn) {
        if (column.filter === id) sheet.records.filterColumn.delete(columnId);
    }
}

// Every formula of the sheets through `through`, each at its own cell: the refusal when a text grows past what a
// cell stores, with the sheets left half written, which the caller throws away.
function rewrite(
    sheets: Iterable<ModelSheet>,
    through: (tree: FormulaNode, sheet: ModelSheet, row: number, column: number) => FormulaNode | null,
): RefusalKey | null {
    for (const sheet of sheets) {
        for (const [place, cell] of sheet.cells) {
            const tree = cell.f === undefined ? null : parseStored(cell.f);
            // Text that does not parse is kept as it is.
            if (!tree || 'reason' in tree) continue;
            const next = through(tree, sheet, ...placeOf(place));
            if (!next || next === tree) continue;
            const text = storedKey(next);
            if (typeof text !== 'string') return 'key-too-long';
            sheet.cells.set(place, { ...cell, f: text });
        }
    }
    return null;
}

// Where a line stands after the edit, or -1 for a deleted one.
function lineAfter({ insert, index, count }: LinesOp, line: number): number {
    if (line < index) return line;
    if (insert) return line + count;
    return line < index + count ? -1 : line - count;
}

// The lines `start` to `end` after the edit, or null when none is left, worked out line by line: the first and the
// last of them that the edit leaves, where they stand after it, so an insert between them grows the span. With `open`,
// an end on the axis's last line stays there: the lines that enter there join the span.
function spanAfter(op: LinesOp, start: number, end: number, open: boolean): [number, number] | null {
    const last = op.rows ? LAST_ROW : LAST_COLUMN;
    const first = lineAfter(op, start) < 0 ? op.index + op.count : start;
    const final = lineAfter(op, end) < 0 ? op.index - 1 : end;
    if (first > final) return null;
    return [lineAfter(op, first), open && end === last ? last : lineAfter(op, final)];
}

// A rule's or a chart's range over the whole axis, Excel's `A:A`, names the axis rather than lines, so it stays whole.
function rangeAfter(op: LinesOp, start: number, end: number): [number, number] | null {
    const whole = start === 0 && end === (op.rows ? LAST_ROW : LAST_COLUMN);
    return whole ? [start, end] : spanAfter(op, start, end, true);
}

function applyLines(model: Model, op: LinesOp): RefusalKey | null {
    const sheet = model.sheets.get(op.sheet);
    if (!sheet) return null;
    const { rows, insert, index, count } = op;
    const last = rows ? LAST_ROW : LAST_COLUMN;
    const lines = rows ? sheet.rows : sheet.columns;
    const along = ([top, left, bottom, right]: Rect): [number, number] => (rows ? [top, bottom] : [left, right]);
    if (insert) {
        // Every line the insert pushes off the grid's end must be empty: no content, no key, the look of the last
        // line that stays, no comment, no merge, and no range that starts or ends on it but an open one.
        const pushed = last + 1 - count;
        const offEnd = (start: number, end: number) => start >= pushed || (end >= pushed && end !== last);
        const rangeOff = (range: Rect) => offEnd(...along(range));
        const { merge, comment, filter, filterColumn, conditionalFormat, validation } = sheet.records;
        const blocked =
            [...sheet.cells.keys()].some((place) => placeOf(place)[rows ? 0 : 1] >= pushed) ||
            [...lines.keys()].some((line) => line >= pushed) ||
            sheet.looks.wouldPush(rows, count) ||
            [...merge.values()].some(({ rect }) => rect[rows ? 2 : 3] >= pushed) ||
            [...comment.values()].some(({ row, column }) => (rows ? row : column) >= pushed) ||
            [...filter.values()].some(({ rect }) => rangeOff(rect)) ||
            [...filterColumn.values()].some((column) =>
                rows ? column.rows.some(([start, end]) => offEnd(start, end)) : column.column >= pushed,
            ) ||
            [...conditionalFormat.values(), ...validation.values()].some(({ ranges }) => ranges.some(rangeOff));
        if (blocked) return 'grid-end';
    }
    const edit: LineEdit = { insert, index, count, sheet: op.sheet, rows };
    const refusal =
        rewrite(model.sheets.values(), (tree, host, row, column) =>
            host === sheet && lineAfter(op, rows ? row : column) < 0
                ? null
                : transformLines(tree, edit, host.id, rows ? row : column).tree,
        ) ?? linesOfRules(model, op);
    if (refusal) return refusal;

    const cells = new Map<string, CellContent>();
    for (const [place, cell] of sheet.cells) {
        const [row, column] = placeOf(place);
        const after = lineAfter(op, rows ? row : column);
        if (after >= 0) cells.set(rows ? key(after, column) : key(row, after), cell);
    }
    sheet.cells = cells;
    if (insert) sheet.looks.insert(rows, index, count, op.like ?? -1);
    else sheet.looks.delete(rows, index, count);
    const keys = [...lines];
    lines.clear();
    for (const [line, attrs] of keys) if (lineAfter(op, line) >= 0) lines.set(lineAfter(op, line), attrs);

    // An insert before the last frozen line freezes the new lines too, up to the grid's end; a delete takes the frozen
    // lines it deletes.
    const field = rows ? 'frozenRows' : 'frozenColumns';
    const frozen = sheet.fields[field] ?? 0;
    if (index < frozen) {
        const after = insert ? Math.min(frozen + count, last + 1) : frozen - Math.min(count, frozen - index);
        sheet.fields = withFields(sheet.fields, { [field]: after || null });
    }

    const ranges = (list: readonly Rect[]): Rect[] =>
        list.flatMap((range): Rect[] => {
            const [top, left, bottom, right] = range;
            const after = rangeAfter(op, ...along(range));
            if (!after) return [];
            return [rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]]];
        });
    const { records } = sheet;
    for (const [id, { rect }] of records.merge) {
        const [top, left, bottom, right] = rect;
        const after = spanAfter(op, rows ? top : left, rows ? bottom : right, false);
        const next: Rect | null =
            after && (rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]]);
        // A merge the edit cuts to one cell is a merge no more.
        const single = next && next[0] === next[2] && next[1] === next[3] && (top !== bottom || left !== right);
        put(sheet, 'merge', id, next && !single ? { rect: next } : undefined);
    }
    for (const [id, { rect }] of records.filter) {
        // The filter covers the lines of its rectangle, its first one on rows the header that holds its buttons, so a
        // delete of the header removes it; one that reaches the grid's end takes in the lines that enter there.
        const [top, left, bottom, right] = rect;
        const header = rows && lineAfter(op, top) < 0;
        const after = header ? null : spanAfter(op, ...along(rect), true);
        if (after)
            records.filter.set(id, {
                rect: rows ? [after[0], left, after[1], right] : [top, after[0], bottom, after[1]],
            });
        else removeFilter(sheet, id);
    }
    for (const [id, column] of records.filterColumn) {
        if (rows) {
            const spans = column.rows.flatMap(([start, end]) => {
                const after = spanAfter(op, start, end, true);
                return after ? [after] : [];
            });
            records.filterColumn.set(id, { ...column, rows: spans });
        } else if (lineAfter(op, column.column) < 0) records.filterColumn.delete(id);
        else records.filterColumn.set(id, { ...column, column: lineAfter(op, column.column) });
    }
    for (const [id, comment] of records.comment) {
        const after = lineAfter(op, rows ? comment.row : comment.column);
        put(
            sheet,
            'comment',
            id,
            after < 0 ? undefined : rows ? { ...comment, row: after } : { ...comment, column: after },
        );
    }
    for (const [id, validation] of records.validation) {
        const next = ranges(validation.ranges);
        put(sheet, 'validation', id, next.length > 0 ? { ...validation, ranges: next } : undefined);
    }
    for (const [id, rule] of records.conditionalFormat) {
        const next = ranges(rule.ranges);
        put(sheet, 'conditionalFormat', id, next.length > 0 ? { ...rule, ranges: next } : undefined);
    }
    // A chart on any sheet follows the lines it names on this one, and the edit is refused when that takes it past
    // its size bound.
    for (const other of model.sheets.values()) {
        for (const [id, chart] of other.records.chart) {
            const next = mapChartRefs(chart, (ref) => {
                if (ref.sheetId !== op.sheet) return ref;
                const after = rangeAfter(op, ...(rows ? ref.row : ref.column));
                if (!after) return null;
                return rows ? { ...ref, row: after } : { ...ref, column: after };
            });
            if (exceedsChartSpecBytes(next)) return 'key-too-long';
            other.records.chart.set(id, next);
        }
    }
    return null;
}

// The formula of every rule through the lines edit, before the ranges move. A rule's formula is read at the top left
// of its first range: when the edit deletes that line, at the first line it leaves of the first range it leaves.
function linesOfRules(model: Model, op: LinesOp): RefusalKey | null {
    const edit: LineEdit = { insert: op.insert, index: op.index, count: op.count, sheet: op.sheet, rows: op.rows };
    for (const sheet of model.sheets.values()) {
        const here = sheet.id === op.sheet;
        for (const [id, rule] of sheet.records.conditionalFormat) {
            const starts = rule.ranges.map(([top, left, bottom, right]) => (op.rows ? [top, bottom] : [left, right]));
            const first = here ? starts.find(([start, end]) => rangeAfter(op, start, end)) : starts[0];
            if (!first) continue;
            const host = here && lineAfter(op, first[0]) < 0 ? op.index + op.count : first[0];
            const next = ruleThrough(rule, (tree) => transformLines(tree, edit, sheet.id, host).tree);
            if (next === 'key-too-long') return next;
            sheet.records.conditionalFormat.set(id, next);
        }
    }
    return null;
}

function ruleThrough(
    rule: Records['conditionalFormat'],
    through: (tree: FormulaNode) => FormulaNode,
): Records['conditionalFormat'] | 'key-too-long' {
    if (rule.type !== 'default' || rule.conditionName !== 'formula') return rule;
    const [text] = rule.conditionValue;
    const tree = typeof text === 'string' ? parseStored(text) : null;
    if (!tree || 'reason' in tree) return rule;
    const next = storedKey(through(tree));
    return typeof next === 'string' ? { ...rule, conditionValue: rule.conditionValue.with(0, next) } : 'key-too-long';
}

function applyMove(model: Model, op: MoveOp): RefusalKey | null {
    const from = model.sheets.get(op.sheet);
    const to = model.sheets.get(op.toSheet);
    if (!from || !to) return null;
    const block = op.from;
    const [top, left, bottom, right] = block;
    const down = op.toRow - top;
    const across = op.toColumn - left;
    // A block moved onto itself changes nothing, whatever it cuts.
    if (from === to && down === 0 && across === 0) return null;
    const shifted = ([t, l, b, r]: Rect): Rect => [t + down, l + across, b + down, r + across];
    const target = shifted(block);
    const carried = [...from.records.merge].filter(([, { rect }]) => meets(rect, block));
    if (carried.some(([, { rect }]) => !within(rect, block))) return 'merge-cut';
    const covered = [...to.records.merge].filter(
        ([id, { rect }]) => meets(rect, target) && !(from === to && carried.some(([other]) => other === id)),
    );
    // The comments the block lands on go too, but for those it brings.
    const brought = [...from.records.comment].filter(([, { row, column }]) => inside(row, column, block));
    const landed = [...to.records.comment].filter(
        ([id, { row, column }]) =>
            inside(row, column, target) && !(from === to && brought.some(([other]) => other === id)),
    );
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
    // The sheets refuse one by one, the one the block leaves first and the one it lands on next, as every reader asks
    // them; the engine moves the cells after. Where the block lands a cut refuses first, then a rule.
    for (const sheet of new Set([from, to, ...model.sheets.values()])) {
        if (sheet === to && covered.some(([, { rect }]) => !within(rect, target))) return 'merge-cut';
        const refusal = moveOfRules(sheet, op, move);
        if (refusal) return refusal;
    }
    // A formula the block lands on is gone, so it is not asked.
    const refusal = rewrite(model.sheets.values(), (tree, host, row, column) =>
        host === to && inside(row, column, target) && !(host === from && inside(row, column, block))
            ? null
            : transformMove(tree, move, host.id, row, column).tree,
    );
    if (refusal) return refusal;

    const taken: [string, CellContent][] = [];
    for (const [place, cell] of from.cells) {
        const [row, column] = placeOf(place);
        if (!inside(row, column, block)) continue;
        from.cells.delete(place);
        taken.push([key(row + down, column + across), cell]);
    }
    for (const place of [...to.cells.keys()]) if (inside(...placeOf(place), target)) to.cells.delete(place);
    for (const [place, cell] of taken) to.cells.set(place, cell);
    const looks = from.looks.clone();
    from.looks.format(block, () => 0);
    to.looks.paste(looks, block, op.toRow, op.toColumn);

    // The merges wholly in the block and the comments in it go along; a merge or a comment the block lands on goes.
    for (const [id] of covered) to.records.merge.delete(id);
    for (const [id] of landed) to.records.comment.delete(id);
    for (const [id, { rect }] of carried) {
        from.records.merge.delete(id);
        to.records.merge.set(id, { rect: shifted(rect) });
    }
    for (const [id, comment] of [...from.records.comment]) {
        if (!inside(comment.row, comment.column, block)) continue;
        from.records.comment.delete(id);
        to.records.comment.set(id, { row: comment.row + down, column: comment.column + across });
    }
    // A chart on any sheet reads its cells by sheet and place: those wholly in the block it reads where they landed.
    for (const sheet of model.sheets.values()) {
        for (const [id, chart] of sheet.records.chart) {
            const next = mapChartRefs(chart, (ref) => {
                const { sheetId, row, column } = ref;
                if (sheetId !== op.sheet || !inside(row[0], column[0], block) || !inside(row[1], column[1], block)) {
                    return ref;
                }
                return {
                    sheetId: op.toSheet,
                    row: [row[0] + down, row[1] + down],
                    column: [column[0] + across, column[1] + across],
                };
            });
            if (exceedsChartSpecBytes(next)) return 'key-too-long';
            sheet.records.chart.set(id, next);
        }
    }
    // On one sheet the rule ranges wholly in the block go along too.
    if (from !== to) return null;
    const moved = (ranges: readonly Rect[]): Rect[] =>
        ranges.map((range) => (within(range, block) ? shifted(range) : range));
    for (const [id, validation] of from.records.validation) {
        from.records.validation.set(id, { ...validation, ranges: moved(validation.ranges) });
    }
    for (const [id, rule] of from.records.conditionalFormat) {
        from.records.conditionalFormat.set(id, { ...rule, ranges: moved(rule.ranges) });
    }
    return null;
}

// The formula of every rule of a sheet through the move, before the ranges move. A rule's formula is read at the top left of its
// first range. When the block leaves the rule's sheet with cells of the rule but without its first range whole, the
// formula stays with the cells the block leaves, so it is read at the first of those; a rule the block holds whole on
// a sheet it leaves for another keeps its text.
function moveOfRules(sheet: ModelSheet, op: MoveOp, move: Move): RefusalKey | null {
    const block = op.from;
    const leaves = sheet.id === op.sheet;
    for (const [id, rule] of sheet.records.conditionalFormat) {
        const [first] = rule.ranges;
        const goesAlong = leaves && op.sheet === op.toSheet && within(first, block);
        let host: [number, number] | undefined = [first[0], first[1]];
        if (leaves && !goesAlong) {
            host = undefined;
            for (const [top, left, bottom, right] of rule.ranges) {
                if (!inside(top, left, block)) host = [top, left];
                else if (right > block[3]) host = [top, block[3] + 1];
                else if (bottom > block[2]) host = [block[2] + 1, left];
                if (host) break;
            }
        }
        if (!host) continue;
        const [row, column] = host;
        const next = ruleThrough(rule, (tree) => transformMove(tree, move, sheet.id, row, column).tree);
        if (next === 'key-too-long') return next;
        sheet.records.conditionalFormat.set(id, next);
    }
    return null;
}

function applySheet(model: Model, op: SheetOp): RefusalKey | null {
    if ('delete' in op) {
        if (!model.sheets.has(op.delete)) return null;
        const others = [...model.sheets.values()].filter((sheet) => sheet.id !== op.delete);
        if (others.every((sheet) => sheet.fields.hide)) return 'last-sheet';
        model.sheets.delete(op.delete);
        return null;
    }
    // A sheet whose id the workbook holds is skipped alone.
    if (model.sheets.has(op.add.id)) return null;
    // One whose records bring an id the book holds for their type is refused.
    const ids = (records: SheetContent['records']) =>
        Object.entries(records).flatMap(([type, of]) => Object.keys(of ?? {}).map((id) => `${type} ${id}`));
    const held = new Set([...model.sheets.values()].flatMap((sheet) => ids(listed(sheet.records))));
    if (ids(op.add.records).some((id) => held.has(id))) return 'id-in-use';
    // A name in use takes the first free suffix, from ` (2)`, with the name cut to make room for it.
    const taken = new Set([...model.sheets.values()].map((sheet) => sheetNameKey(sheet.fields.name)));
    let name = op.add.fields.name;
    for (let n = 2; taken.has(sheetNameKey(name)); n += 1) {
        const suffix = ` (${n})`;
        name = `${op.add.fields.name.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    // The new sheet's formulas enter as a load's do. A formula of the workbook typed with the new sheet's name binds to
    // it, and is refused where that is too long a text.
    const sheet = sheetOf(model, { ...op.add, fields: { ...op.add.fields, name } }, [
        { id: op.add.id, name },
        ...namedOf(model),
    ]);
    const refusal = rewrite(model.sheets.values(), (tree) => bindSheet(tree, name, sheet.id));
    if (refusal) return refusal;
    model.sheets.set(sheet.id, sheet);
    return null;
}
