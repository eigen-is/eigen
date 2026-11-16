import { describe, expect, test } from 'bun:test';
import type { CellSink, SheetSource } from '../../index';
import { Engine } from '../../index';

const NO_CAP = Number.POSITIVE_INFINITY;

function sheet(id: string, cells: (cell: CellSink) => void): SheetSource {
    return { id, name: id, cells };
}

function read(engine: Engine, id: string): unknown[] {
    return [0, 1, 2].map((row) => [engine.formulaOf(id, row, 0), engine.valueOf(id, row, 0)]);
}

describe('a source of cells that calls the engine while it is read', () => {
    test('a write and a recalc from inside leave the new sheet the formulas it reported', () => {
        const engine = new Engine([sheet('a', (cell) => cell(0, 0, 1, null))], 0, 0, false);
        engine.recalc(NO_CAP);
        engine.addSheet(
            sheet('b', (cell) => {
                cell(0, 0, null, '=[a]!R1C1+1');
                engine.setFormula('a', 1, 0, '=R[-1]C*10');
                engine.recalc(NO_CAP);
                cell(1, 0, null, '=[a]!R1C1+2');
                engine.setFormula('a', 2, 0, '=R[-1]C*10');
                engine.recalc(NO_CAP);
                cell(2, 0, null, '=[a]!R1C1+3');
                // A formula written last, which no recalc has seen when the source ends.
                engine.setFormula('a', 3, 0, '=R[-3]C+5');
            }),
            1,
        );
        engine.recalc(NO_CAP);
        expect(read(engine, 'b')).toEqual([
            ['=[a]!R1C1+1', 2],
            ['=[a]!R1C1+2', 3],
            ['=[a]!R1C1+3', 4],
        ]);
        expect(read(engine, 'a')).toEqual([
            [null, 1],
            ['=R[-1]C*10', 10],
            ['=R[-1]C*10', 100],
        ]);
        expect(engine.valueOf('a', 3, 0)).toBe(6);
    });

    test('a pass from inside that sweeps the texts leaves the new sheet the texts it reported', () => {
        const spare = ['c', 'd', 'e'];
        const engine = new Engine(
            [sheet('a', (cell) => cell(0, 0, 'Kept', null)), ...spare.map((id) => sheet(id, () => {}))],
            0,
            0,
            false,
        );
        engine.recalc(NO_CAP);
        engine.addSheet(
            sheet('b', (cell) => {
                cell(0, 0, 'Alpha', null);
                // A removed sheet makes the next pass sweep the string table, each time the source is read.
                const gone = spare.pop();
                if (gone !== undefined) engine.removeSheet(gone);
                engine.recalc(NO_CAP);
                cell(1, 0, 'Beta', null);
                engine.setValue('a', 1, 0, 'Gamma');
                engine.recalc(NO_CAP);
                cell(2, 0, null, '=R[-2]C&R[-1]C');
            }),
            0,
        );
        engine.recalc(NO_CAP);
        expect(read(engine, 'b')).toEqual([
            [null, 'Alpha'],
            [null, 'Beta'],
            ['=R[-2]C&R[-1]C', 'AlphaBeta'],
        ]);
        expect([engine.valueOf('a', 0, 0), engine.valueOf('a', 1, 0)]).toEqual(['Kept', 'Gamma']);
    });

    test('a sheet of the same id added from inside is the one that stays, and the outer one is refused', () => {
        const engine = new Engine([sheet('a', (cell) => cell(0, 0, 1, null))], 0, 0, false);
        let added = false;
        const outer = sheet('b', (cell) => {
            if (!added) {
                added = true;
                engine.addSheet(
                    sheet('b', (inner) => inner(0, 0, 'inner', null)),
                    0,
                );
            }
            cell(0, 0, 'outer', null);
        });
        expect(() => engine.addSheet(outer, 0)).toThrow('Sheet b exists');
        expect([engine.sheetAt(0), engine.sheetAt(1), engine.valueOf('b', 0, 0)]).toEqual(['b', 'a', 'inner']);
        expect(() => engine.sheetAt(2)).toThrow();
    });
});
