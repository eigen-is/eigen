import { describe, expect, test } from 'bun:test';
import type { Column } from '../../store/column';
import { CellKind, KIND_MASK, LOOP, SETTLED } from '../../store/column';
import { ColumnIndex } from '../../store/column-index';
import type { Sheet } from '../../store/sheet';
import { ChangeKind, Workbook } from '../../store/workbook';
import type { Move } from '../../text';
import { DIV0 } from '../../values/errors';
import { random } from '../edit/support';

type Held = { kind: number; num: number; ref: number; shape: number };

const source = (id: string) => ({ id, name: id, cells: () => {} });

function cellsOf(sheet: Sheet): Map<string, Held> {
    const cells = new Map<string, Held>();
    sheet.columns.forEach((column, c) => {
        for (let row = 0; row < column.length; row += 1) {
            const held = {
                kind: column.kind[row],
                num: column.num[row],
                ref: column.ref[row],
                shape: column.shape[row],
            };
            if (held.kind !== 0 || held.shape !== 0) cells.set(`${row},${c}`, held);
        }
    });
    return cells;
}

// What a column must say about itself, from its cells alone.
function audit(column: Column): string {
    let errors = 0;
    let pending = 0;
    let loops = 0;
    let last = -1;
    for (let row = 0; row < column.kind.length; row += 1) {
        const kind = column.kind[row];
        if (kind !== 0 || column.shape[row] !== 0 || column.num[row] !== 0 || column.ref[row] !== 0) last = row;
        if ((kind & KIND_MASK) === CellKind.Error) errors += 1;
        if (kind > SETTLED) pending += 1;
        if (kind & LOOP) loops += 1;
    }
    return `length ${last + 1} errors ${errors} pending ${pending} loops ${loops}`;
}

describe('a block moved in the store', () => {
    test('equals the cells moved one by one, on columns of any length and where there is none', () => {
        const pick = random(11);
        let zeroed = 0;
        for (let run = 0; run < 3000; run += 1) {
            const workbook = new Workbook([source('a'), source('b')]);
            for (const sheet of workbook.sheets) {
                for (let i = pick(14); i > 0; i -= 1) {
                    const row = pick(9);
                    const c = pick(7);
                    const what = pick(5);
                    if (what === 0) workbook.fillFormula(sheet, row, c, row, c, `=R1C1+${pick(3)}`);
                    else workbook.setValue(sheet, row, c, what === 1 ? DIV0 : what === 2 ? 'text' : pick(50));
                    const column = sheet.column(c);
                    if (what === 0 && pick(2) === 0) column.computed(row);
                    if (what === 0 && pick(3) === 0) column.setLoop(row, true);
                }
            }
            const from = workbook.sheets[pick(2)];
            const to = workbook.sheets[pick(2)];
            const move: Move = {
                fromSheet: from.id,
                row: pick(9),
                column: pick(9),
                rows: 1 + pick(4),
                columns: 1 + pick(3),
                toSheet: to.id,
                toRow: pick(9),
                toColumn: pick(9),
            };
            const expected = new Map(workbook.sheets.map((sheet) => [sheet.id, cellsOf(sheet)] as const));
            const carried: [string, Held][] = [];
            for (let row = 0; row < move.rows; row += 1) {
                for (let c = 0; c < move.columns; c += 1) {
                    const key = `${move.row + row},${move.column + c}`;
                    const held = expected.get(from.id)?.get(key);
                    if (held !== undefined) carried.push([`${move.toRow + row},${move.toColumn + c}`, held]);
                    else if (expected.get(to.id)?.has(`${move.toRow + row},${move.toColumn + c}`)) zeroed += 1;
                    expected.get(from.id)?.delete(key);
                }
            }
            for (let row = 0; row < move.rows; row += 1) {
                for (let c = 0; c < move.columns; c += 1)
                    expected.get(to.id)?.delete(`${move.toRow + row},${move.toColumn + c}`);
            }
            for (const [key, held] of carried) expected.get(to.id)?.set(key, held);
            const versions = workbook.sheets.map((sheet) => sheet.columns.map((column) => column.version));
            workbook.apply({ kind: ChangeKind.Move, move }, []);
            workbook.sheets.forEach((sheet, s) => {
                expect([run, sheet.id, [...cellsOf(sheet)].sort()]).toEqual([
                    run,
                    sheet.id,
                    [...(expected.get(sheet.id) ?? [])].sort(),
                ]);
                sheet.columns.forEach((column, c) => {
                    const { length, errors, pending, loops } = column;
                    expect([run, c, `length ${length} errors ${errors} pending ${pending} loops ${loops}`]).toEqual([
                        run,
                        c,
                        audit(column),
                    ]);
                    const inBlock =
                        (sheet === from && c >= move.column && c < move.column + move.columns) ||
                        (sheet === to && c >= move.toColumn && c < move.toColumn + move.columns);
                    // A column the block did not touch keeps what lookups know of it.
                    if (!inBlock) expect([run, c, column.version]).toEqual([run, c, versions[s][c] ?? 0]);
                });
            });
        }
        expect(zeroed).toBeGreaterThan(500);
    });
    test('shapes are written where the cells are before they move, so they travel with them', () => {
        const workbook = new Workbook([source('a')]);
        const [sheet] = workbook.sheets;
        workbook.fillFormula(sheet, 2, 1, 4, 2, '=R1C1');
        const other = workbook.shapes.intern('=R1C1+1');
        const dropped = workbook.apply(
            { kind: ChangeKind.Lines, edit: { insert: true, index: 3, count: 2, sheet: 'a', rows: true } },
            [0, 1, 2, 3, 4, other],
        );
        expect(dropped).toBe(0);
        expect([...sheet.columns[1].shape.slice(2, 7)]).toEqual([1, 0, 0, other, other]);
        expect([...sheet.columns[2].shape.slice(2, 7)]).toEqual([1, 0, 0, other, other]);
        expect(sheet.columns[1].pending).toBe(3);
    });
});

describe('what lookups keep of a column across an edit', () => {
    test('columns that slide keep it, and a column whose rows moved or that a block left or landed on starts over', () => {
        const workbook = new Workbook([source('a')]);
        const [sheet] = workbook.sheets;
        for (let row = 0; row < 6; row += 1) workbook.setValue(sheet, row, 3, row % 3);
        workbook.setValue(sheet, 0, 5, 1);
        const column = sheet.columns[3];
        const ask = () => ColumnIndex.rows(column, workbook.strings, CellKind.Number, 2, 0);
        expect(ask()).toBeNull();
        expect(ask()).toEqual([2, 5]);
        workbook.apply(
            { kind: ChangeKind.Lines, edit: { insert: true, index: 1, count: 2, sheet: 'a', rows: false } },
            [],
        );
        workbook.apply(
            { kind: ChangeKind.Lines, edit: { insert: false, index: 0, count: 1, sheet: 'a', rows: false } },
            [],
        );
        expect(sheet.columns[4]).toBe(column);
        expect(ask()).toEqual([2, 5]);
        workbook.apply(
            { kind: ChangeKind.Lines, edit: { insert: true, index: 9, count: 1, sheet: 'a', rows: true } },
            [],
        );
        expect(ask()).toEqual([2, 5]);
        workbook.apply(
            { kind: ChangeKind.Lines, edit: { insert: true, index: 4, count: 1, sheet: 'a', rows: true } },
            [],
        );
        expect(ask()).toBeNull();
        expect(ask()).toEqual([2, 6]);
        workbook.apply(
            {
                kind: ChangeKind.Move,
                move: { fromSheet: 'a', row: 6, column: 4, rows: 1, columns: 1, toSheet: 'a', toRow: 9, toColumn: 4 },
            },
            [],
        );
        expect(ask()).toBeNull();
        expect(ask()).toEqual([2, 9]);
        workbook.setValue(sheet, 0, 8, 2);
        workbook.apply(
            {
                kind: ChangeKind.Move,
                move: { fromSheet: 'a', row: 0, column: 8, rows: 1, columns: 1, toSheet: 'a', toRow: 12, toColumn: 4 },
            },
            [],
        );
        expect(ask()).toBeNull();
        expect(ask()).toEqual([2, 9, 12]);
    });
});

describe('the sheets of a workbook', () => {
    test('come, go and change place, each knowing its place', () => {
        const workbook = new Workbook([source('a'), source('b'), source('c')]);
        const places = () => workbook.sheets.map((sheet) => `${sheet.id}${sheet.place}`).join(' ');
        workbook.apply({ kind: ChangeKind.MoveSheet, sheet: 'a', place: 2 }, []);
        expect(places()).toBe('b0 c1 a2');
        workbook.apply({ kind: ChangeKind.RemoveSheet, sheet: 'b' }, []);
        expect([places(), workbook.sheet('b')]).toEqual(['c0 a1', undefined]);
        workbook.apply({ kind: ChangeKind.AddSheet, source: source('d'), place: 1 }, []);
        workbook.apply({ kind: ChangeKind.RenameSheet, sheet: 'd', name: 'Dee' }, []);
        expect([places(), workbook.known('d').name]).toEqual(['c0 d1 a2', 'Dee']);
        expect(() => workbook.known('b')).toThrow('No sheet b');
    });
});
