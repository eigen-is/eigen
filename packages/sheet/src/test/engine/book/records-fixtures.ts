// Builders for the record store's tests: a sheet's records from plain data, the line edits and moves as the applier
// runs them on every sheet, the store's records as plain data to compare whole, and the record ops of an undo applied
// through the store's own writers.

import { expect } from 'bun:test';
import type { LineEdit } from '@workspace/formula/text';
import { GRID_COLUMNS, GRID_ROWS, parseA1, parseStored, printA1, printStored } from '@workspace/formula/text';
import { newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type {
    ChartRecord,
    MoveOp,
    RecordOp,
    Records,
    RecordType,
    SheetContent,
    SheetFields,
} from '@workspace/lib/sheets/ops';
import type { CellRangeRef, ChartSpec, RangeChartData } from '@workspace/lib/types/chart';
import type { Planned, WholeRecord } from '../../../engine/book/records';
import { SheetRecords } from '../../../engine/book/records';

export const LAST_ROW = GRID_ROWS - 1;
export const LAST_COLUMN = GRID_COLUMNS - 1;

export function sheetOf(records: SheetContent['records'] = {}, fields: Partial<SheetFields> = {}, id = 'S') {
    return new SheetRecords(id, { name: id, order: id, ...fields }, records);
}

export function rowsAt(insert: boolean, index: number, count = 1, sheet = 'S'): LineEdit {
    return { insert, index, count, sheet, rows: true };
}

export function columnsAt(insert: boolean, index: number, count = 1, sheet = 'S'): LineEdit {
    return { insert, index, count, sheet, rows: false };
}

export function inverseOf(edit: LineEdit): LineEdit {
    return { ...edit, insert: !edit.insert };
}

export function planned(result: Planned | string): Planned {
    if (typeof result === 'string') throw new Error(`refused: ${result}`);
    return result;
}

// Plans the edit on every sheet before any writes, as the applier does, and returns the record ops of all sheets.
export function editLines(sheets: Iterable<SheetRecords>, edit: LineEdit): RecordOp[] {
    const plans = [...sheets].map((sheet) => planned(sheet.planLines(edit)));
    for (const plan of plans) plan.commit();
    return plans.flatMap((plan) => plan.restore);
}

export function moveBlock(sheets: ReadonlyMap<string, SheetRecords>, op: MoveOp): RecordOp[] {
    const source = sheetNamed(sheets, op.sheet);
    const plans = [...sheets.values()].map((sheet) => planned(sheet.planMove(op, source)));
    for (const plan of plans) plan.commit();
    return plans.flatMap((plan) => plan.restore);
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

// Applies the record ops of an undo through the store's writers. A whole make must carry the record the sheet held
// before, which is what the test hands to `put`.
export function applyRecordOps(
    sheets: ReadonlyMap<string, SheetRecords>,
    before: ReadonlyMap<string, SheetRecords>,
    ops: readonly RecordOp[],
) {
    for (const op of ops) {
        const sheet = sheetNamed(sheets, op.sheet);
        const written = op.whole ? sheet.put(wholeOf(sheetNamed(before, op.sheet), op)) : sheet.write(op);
        expect(written).not.toBe('merge-overlap');
    }
}

function wholeOf(before: SheetRecords, op: RecordOp): WholeRecord {
    const { id } = op;
    switch (op.type) {
        case 'sheet':
            throw new Error('a sheet record is never made whole');
        case 'merge':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'filter':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'filterColumn':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'comment':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'conditionalFormat':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'validation':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'image':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
        case 'chart':
            return { type: op.type, id, set: heldBefore(before.records(op.type), op) };
    }
}

function heldBefore<R>(records: ReadonlyMap<string, R>, op: RecordOp): R {
    const record = records.get(op.id);
    if (!record) throw new Error(`no ${op.type} ${op.id} before`);
    expect(op.set).toEqual(record);
    return record;
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
