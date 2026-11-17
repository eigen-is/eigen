// Builders for the record store's tests: a sheet's records from plain data, the line edits and moves as the applier
// runs them on every sheet, the store's records as plain data to compare whole, and the record ops of an undo applied
// through the store's own writer.

import { expect } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS, parseA1, parseStored, printA1, printStored } from '@workspace/formula/text';
import { newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type {
    ChartRecord,
    LinesOp,
    MoveOp,
    RecordOp,
    Records,
    RecordType,
    Rect,
    SheetContent,
    SheetFields,
} from '@workspace/lib/sheets/ops';
import type { CellRangeRef, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import { BookRecords } from '../../../engine/book/records';

export const LAST_ROW = GRID_ROWS - 1;
export const LAST_COLUMN = GRID_COLUMNS - 1;

type Kind = Exclude<RecordType, 'sheet'>;

// One sheet of a book's record store, read and written as the store's tests do.
export class SheetRecords {
    public constructor(
        public readonly store: BookRecords,
        public readonly id: string,
    ) {}

    public get fields() {
        return this.store.fields(this.id);
    }

    public records<T extends Kind>(type: T) {
        return this.store.records(this.id, type);
    }

    public content() {
        return this.store.content(this.id);
    }

    public weight() {
        return this.store.weight();
    }

    public write(op: RecordOp) {
        return this.store.write(op);
    }

    public wouldPush(op: LinesOp) {
        return this.store.wouldPush(op);
    }

    public planLines(op: LinesOp) {
        return this.store.planLines(op);
    }

    public planMove(op: MoveOp) {
        return this.store.planMove(op);
    }

    public merge(row: number, column: number) {
        return this.store.merge(this.id, row, column);
    }

    public touchesMerge(rect: Rect) {
        return this.store.touchesMerge(this.id, rect);
    }

    public mergesIn(rect: Rect) {
        return this.store.mergesIn(this.id, rect);
    }

    public validation(row: number, column: number) {
        return this.store.validation(this.id, row, column);
    }

    public rulesIn<T extends 'conditionalFormat' | 'validation'>(type: T, rect: Rect) {
        return this.store.rulesIn(this.id, type, rect);
    }

    public comments(row: number, column: number) {
        return this.store.comments(this.id, row, column);
    }
}

// A store of one sheet, S unless named.
export function sheetOf(records: SheetContent['records'] = {}, fields: Partial<SheetFields> = {}, id = 'S') {
    const store = new BookRecords();
    store.add(id, { name: id, order: id, ...fields }, records);
    return new SheetRecords(store, id);
}

// The sheets of one store, by id.
export function sheetsOf(
    sheets: readonly [string, SheetContent['records'], Partial<SheetFields>?][],
): Map<string, SheetRecords> {
    const store = new BookRecords();
    for (const [id, records, fields] of sheets) store.add(id, { name: id, order: id, ...fields }, records);
    return new Map(sheets.map(([id]) => [id, new SheetRecords(store, id)]));
}

export function rowsAt(insert: boolean, index: number, count = 1, sheet = 'S'): LinesOp {
    return { kind: 'lines', insert, index, count, sheet, rows: true };
}

export function columnsAt(insert: boolean, index: number, count = 1, sheet = 'S'): LinesOp {
    return { kind: 'lines', insert, index, count, sheet, rows: false };
}

export function inverseOf(edit: LinesOp): LinesOp {
    return { ...edit, insert: !edit.insert };
}

export function planned<P extends object>(result: P | string): P {
    if (typeof result === 'string') throw new Error(`refused: ${result}`);
    return result;
}

// Plans the edit on the sheet's store, as the applier does, and returns its record ops.
export function editLines(sheet: SheetRecords, edit: LinesOp): RecordOp[] {
    const plan = planned(sheet.planLines(edit));
    plan.commit();
    return [...plan.restore];
}

export function moveBlock(sheets: ReadonlyMap<string, SheetRecords>, op: MoveOp): RecordOp[] {
    const plan = planned(sheetNamed(sheets, op.sheet).planMove(op));
    plan.commit();
    return [...plan.restore];
}

// The move that takes a block back to where it came from.
export function reverseOf(op: MoveOp): MoveOp {
    const [top, left, bottom, right] = op.from;
    const to: MoveOp['from'] = [op.toRow, op.toColumn, op.toRow + bottom - top, op.toColumn + right - left];
    return { kind: 'move', sheet: op.toSheet, from: to, toSheet: op.sheet, toRow: top, toColumn: left };
}

export function sheetNamed(sheets: ReadonlyMap<string, SheetRecords>, id: string): SheetRecords {
    const sheet = sheets.get(id);
    if (!sheet) throw new Error(`no sheet ${id}`);
    return sheet;
}

// A sheet's fields and records as plain data, a type with no record left out.
export function contentOf(sheet: SheetRecords) {
    const of = <T extends Exclude<RecordType, 'sheet'>>(type: T) =>
        sheet.records(type).size > 0 ? Object.fromEntries(sheet.records(type)) : undefined;
    const records: SheetContent['records'] = {
        merge: of('merge'),
        filter: of('filter'),
        filterColumn: of('filterColumn'),
        comment: of('comment'),
        conditionalFormat: of('conditionalFormat'),
        validation: of('validation'),
        image: of('image'),
        chart: of('chart'),
    };
    return { fields: sheet.fields, records };
}

// Applies the record ops of an undo through the store's writer and returns the inverses it hands back. A whole make
// must carry the record the sheet held before.
export function applyRecordOps(
    sheets: ReadonlyMap<string, SheetRecords>,
    before: ReadonlyMap<string, SheetRecords>,
    ops: readonly RecordOp[],
): RecordOp[] {
    const inverses: RecordOp[] = [];
    for (const op of ops) {
        if (op.whole) expect(sheetNamed(before, op.sheet).records(op.type).get(op.id)).toEqual(op.set);
        const written = sheetNamed(sheets, op.sheet).write(op);
        if (typeof written === 'string') throw new Error(written);
        inverses.push(...written);
    }
    return inverses;
}

const findSheet = (name: string) => (name === 'S' || name === 'T' ? { id: name } : undefined);

// A formula as a person types it at a cell, as the stored key a rule holds.
export function keyOf(typed: string, row: number, column: number): string {
    const tree = parseA1(typed, row, column, findSheet);
    if ('reason' in tree) throw new Error(tree.reason);
    return printStored(tree);
}

// A stored key as it reads at a cell.
export function typedAt(key: string, row: number, column: number): string {
    const tree = parseStored(key);
    if ('reason' in tree) throw new Error(tree.reason);
    return printA1(tree, row, column, (id) => id);
}

export function formulaRule(ranges: Records['conditionalFormat']['ranges'], key: string): Records['conditionalFormat'] {
    return {
        type: 'default',
        conditionName: 'formula',
        ranges,
        order: 'a0',
        conditionValue: [key],
        format: { cellColor: '#ff0000' },
    };
}

export function keyOfRule(rule: Records['conditionalFormat'] | undefined): unknown {
    return rule?.type === 'default' ? rule.conditionValue[0] : undefined;
}

export function chartOf(data: Omit<RangeChartData, 'source'>): ChartRecord {
    const spec: ChartSpec = { ...sampleChartSpec('column'), data: { source: 'range', ...data } };
    return { index: 'a0', x: 10, y: 20, width: 400, height: 300, ...newChartSpecParts(spec) };
}

export function chartData(chart: ChartRecord | undefined) {
    const spec = chart && readChartSpec(chart).spec;
    return spec?.data.source === 'range' ? spec.data : null;
}

export function ref(sheetId: string, row: [number, number], column: [number, number]): CellRangeRef {
    return { sheetId, row, column };
}
