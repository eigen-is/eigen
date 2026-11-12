import { describe, expect, test } from 'bun:test';
import type { Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS } from '../../text';
import { engineOf } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;
const INDEX = 1;

function workbook(): Engine {
    const engine = engineOf({
        s1: { A1: 5, A2: '=C1*2', C1: 7, C3: 2, B3: '=SUM(A:A)', D4: '=A1+C3', E1: '=SUM(1:1)', F6: '=$A$1+F5' },
        s2: { A1: '=Sheet1!C1+Sheet1!A1', B2: '=SUM(Sheet1!B:D)', C3: '=SUM(Sheet1!2:4)' },
    });
    engine.recalc(NO_CAP);
    return engine;
}

function show(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text);
    return `${typeof value}:${String(value)}`;
}

// Per cell of the first rows and columns of both sheets its text, its value and whether it waits.
function read(engine: Engine): string[] {
    const cells: string[] = [];
    for (const sheet of ['s1', 's2']) {
        for (let row = 0; row < 8; row += 1) {
            for (let column = 0; column < 8; column += 1) {
                const text = engine.formulaOf(sheet, row, column);
                const waits = engine.isPending(sheet, row, column);
                cells.push(`${sheet} ${row},${column} ${text} ${show(engine.valueOf(sheet, row, column))} ${waits}`);
            }
        }
    }
    return cells;
}

const COUNTS = [
    1,
    2,
    GRID_COLUMNS - INDEX,
    GRID_COLUMNS,
    100_000,
    GRID_ROWS - INDEX,
    GRID_ROWS,
    2 ** 31,
    2 ** 32,
    Number.MAX_SAFE_INTEGER,
    2 ** 53,
    2 ** 60,
    1e300,
];
const EDITS = [true, false].flatMap((rows) =>
    [true, false].flatMap((insert) =>
        COUNTS.map((count): [string, string, number, boolean, boolean] => [
            insert ? 'inserted' : 'deleted',
            rows ? 'rows' : 'columns',
            count,
            insert,
            rows,
        ]),
    ),
);

describe('a count of lines past the end of the grid is the count that reaches its end', () => {
    test.each(EDITS)('%s %s, %d of them', (_, __, count, insert, rows) => {
        const fits = Math.min(count, (rows ? GRID_ROWS : GRID_COLUMNS) - INDEX);
        const engine = workbook();
        const twin = workbook();
        const edited = engine.editLines({ insert, index: INDEX, count, sheet: 's1', rows });
        expect(edited).toEqual(twin.editLines({ insert, index: INDEX, count: fits, sheet: 's1', rows }));
        expect(read(engine)).toEqual(read(twin));
        engine.recalc(NO_CAP);
        twin.recalc(NO_CAP);
        expect(read(engine)).toEqual(read(twin));
        // What the edit left takes writes and edits as any workbook does.
        for (const each of [engine, twin]) {
            each.setValue('s1', 0, 0, 6);
            each.editLines({ insert: true, index: 0, count: 1, sheet: 's1', rows });
            each.recalc(NO_CAP);
        }
        expect(read(engine)).toEqual(read(twin));
    });
});
