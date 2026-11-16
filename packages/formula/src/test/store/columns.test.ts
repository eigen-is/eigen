import { heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import { Engine } from '../../index';
import { Sheet } from '../../store/sheet';
import { Workbook } from '../../store/workbook';
import { GRID_COLUMNS } from '../../text/a1';
import { source } from './support';

const LAST = GRID_COLUMNS - 1;
const SHEETS = 200;

// The typed arrays alive on the heap after a collection: every column that holds rows has four.
function typedArrays(): number {
    Bun.gc(true);
    const counts = heapStats().objectTypeCounts;
    return (counts.Uint8Array ?? 0) + (counts.Float64Array ?? 0) + (counts.Int32Array ?? 0);
}

describe('a column that holds nothing costs nothing', () => {
    test('a sheet added with one cell in the last column allocates for the cell, not for the columns before it', () => {
        const engine = new Engine([source('s', [])], 0, 0, false);
        const before = typedArrays();
        for (let at = 0; at < SHEETS; at += 1) engine.addSheet(source(`t${at}`, [[0, LAST, 1]]), at + 1);
        const made = typedArrays() - before;
        expect(engine.slots()).toBe(SHEETS);
        expect(engine.valueOf(`t${SHEETS - 1}`, 0, LAST)).toBe(1);
        expect(made).toBeLessThan(SHEETS * 16);
    });

    test('so does a load of such sheets, and a cell typed in the last column', () => {
        const before = typedArrays();
        const sheets = Array.from({ length: SHEETS }, (_, at) => source(`t${at}`, [[0, LAST, 1]]));
        const engine = new Engine(sheets, 0, 0, false);
        for (let at = 0; at < SHEETS; at += 1) engine.setValue(`t${at}`, 3, LAST - 1, 2);
        const made = typedArrays() - before;
        expect(engine.slots()).toBe(SHEETS * 5);
        expect(made).toBeLessThan(SHEETS * 32);
    });

    test('so do a cell typed past the last column of a sheet, a column insert and a move over empty columns', () => {
        const before = typedArrays();
        const engine = new Engine(
            Array.from({ length: SHEETS }, (_, at) => source(`t${at}`, [])),
            0,
            0,
            false,
        );
        for (let at = 0; at < SHEETS; at += 1) {
            const sheet = `t${at}`;
            engine.setValue(sheet, 0, 100, 1);
            engine.editLines({ sheet, insert: true, rows: false, index: 0, count: 10_000 });
            const block = { fromSheet: sheet, row: 1, column: 0, rows: 1, columns: 10_000 };
            engine.moveCells({ ...block, toSheet: sheet, toRow: 2, toColumn: 1 });
        }
        const made = typedArrays() - before;
        expect(engine.slots()).toBe(SHEETS);
        expect(engine.valueOf('t0', 0, 10_100)).toBe(1);
        expect(made).toBeLessThan(SHEETS * 16);
    });

    test('an empty column reads as empty, and a lookup on it finds nothing', () => {
        const engine = new Engine([source('s', [[0, 3, 'x']])], 0, 0, false);
        engine.setFormula('s', 0, 0, '=COUNTIF(C2:C2,"x")+IFERROR(MATCH("x",C3:C3,0),-1)');
        engine.setFormula('s', 1, 0, '=COUNTIF(C2:C2,"x")+IFERROR(MATCH("x",C3:C3,0),-1)');
        engine.recalc(Number.POSITIVE_INFINITY);
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(engine.valueOf('s', 0, 0)).toBe(-1);
        expect(engine.valueOf('s', 1, 0)).toBe(-1);
        expect(engine.columnLength('s', 1)).toBe(0);
    });
});

describe('the slot total is a count', () => {
    test('slots() reads no sheet and no column, however many there are', () => {
        const sheets = Array.from({ length: 60 }, (_, at) => source(`t${at}`, [[0, LAST, 1]]));
        const engine = new Engine(sheets, 0, 0, false);
        const read = { sheets: 0, columns: 0 };
        const sheetsOf = Object.getOwnPropertyDescriptor(Workbook.prototype, 'sheets');
        const columnsOf = Object.getOwnPropertyDescriptor(Sheet.prototype, 'columns');
        if (sheetsOf?.get === undefined || columnsOf?.get === undefined) throw new Error('no getters');
        const sheetsGet = sheetsOf.get;
        const columnsGet = columnsOf.get;
        Object.defineProperty(Workbook.prototype, 'sheets', {
            ...sheetsOf,
            get() {
                read.sheets += 1;
                return sheetsGet.call(this);
            },
        });
        Object.defineProperty(Sheet.prototype, 'columns', {
            ...columnsOf,
            get() {
                read.columns += 1;
                return columnsGet.call(this);
            },
        });
        try {
            for (let at = 0; at < 100; at += 1) expect(engine.slots()).toBe(60);
        } finally {
            Object.defineProperty(Workbook.prototype, 'sheets', sheetsOf);
            Object.defineProperty(Sheet.prototype, 'columns', columnsOf);
        }
        expect(read).toEqual({ sheets: 0, columns: 0 });
    });
});
