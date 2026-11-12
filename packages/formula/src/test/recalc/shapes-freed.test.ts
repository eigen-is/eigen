import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import type { Engine, Literal } from '../../index';
import { Engine as Loaded } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { ChangeKind, Workbook } from '../../store/workbook';
import { engineOf, stored } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

function show(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text);
    return `${typeof value}:${String(value)}`;
}

// Every value of the first rows and columns of the one sheet, and the same of an engine that loads what the
// engine holds, texts and typed values, and computes every formula from nothing.
function values(engine: Engine): { held: string[]; fresh: string[] } {
    const cells: [number, number, Literal | null, string | null][] = [];
    const held: string[] = [];
    for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 10; column += 1) {
            const formula = engine.formulaOf('s1', row, column);
            const value = engine.valueOf('s1', row, column);
            held.push(`${row},${column} ${show(value)}`);
            if (formula !== null) cells.push([row, column, null, formula]);
            else if (value !== null) cells.push([row, column, value, null]);
        }
    }
    const loaded = new Loaded([
        { id: 's1', name: 'Sheet1', cells: (cell) => cells.forEach((held) => void cell(...held)) },
    ]);
    loaded.recalc(NO_CAP);
    const fresh: string[] = [];
    for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 10; column += 1) {
            fresh.push(`${row},${column} ${show(loaded.valueOf('s1', row, column))}`);
        }
    }
    return { held, fresh };
}

// One formula per fact a shape can have, typed at E3, and two that have none.
const FORMULAS: [string, string][] = [
    ['reads a cell', '=A1+1'],
    ['reads another cell', '=B2*2'],
    ['reads where it is', '=ROW()+A1'],
    ['counts the empty cells of a range', '=COUNTBLANK(A1:A10)'],
    ['passes over the empty cells of a range', '=SUM(A1:A10)'],
    ['looks a cell up in a whole column', '=MATCH(7,A:A,0)'],
    ['reads cells it does not name', '=SUM(OFFSET(A1,1,0,3,1))'],
    ['picks its row, as an outer one passes over', '=SUBTOTAL(9,A1:A3)'],
    ['draws from the clock', '=NOW()+A2'],
    ['is kept as it came', "='[1]Sheet1'!R1C1+1"],
    ['does not parse', '=SUM('],
    ['nests deep', `=${'ABS('.repeat(40)}A3${')'.repeat(40)}`],
];
const PAIRS = FORMULAS.flatMap((first) =>
    FORMULAS.filter((second) => second !== first).map((second): [string, string, string, string] => [
        first[0],
        second[0],
        first[1],
        second[1],
    ]),
);
const typed = (formula: string, host: string) => (formula.startsWith("='[") ? formula : stored(formula, host));

describe('a shape no cell holds any more is forgotten, and the next new shape takes its id', () => {
    test.each(PAIRS)('one that %s, then one that %s, under one id', (_, __, first, second) => {
        const data = { A1: 1, A2: 2, A3: 3, A4: 4, A6: 6, A7: 7, A8: 8, A10: 10, B2: 5 };
        const readers = { G1: '=SUBTOTAL(9,E1:E4)', G2: '=E3+1', G3: '=SUM(E:E)' };
        const engine = engineOf({ s1: { ...data, ...readers, E2: first } });
        engine.recalc(NO_CAP);
        // The first formula goes, a recalc brings the index up to date, and the second is the next new shape.
        engine.setValue('s1', 1, 4, 100);
        engine.recalc(NO_CAP);
        engine.setFormula('s1', 2, 4, typed(second, 'E3'));
        const steps = [
            () => {},
            () => engine.setValue('s1', 1, 0, 50),
            () => engine.editLines({ insert: true, index: 5, count: 1, sheet: 's1', rows: true }),
            () => engine.editLines({ insert: true, index: 0, count: 2, sheet: 's1', rows: true }),
            () => engine.setValue('s1', 4, 0, 30),
            () => engine.editLines({ insert: false, index: 6, count: 1, sheet: 's1', rows: true }),
            () => engine.moveCells({ ...BLOCK, row: 4, toRow: 9 }),
            () => engine.editLines({ insert: false, index: 0, count: 1, sheet: 's1', rows: true }),
        ];
        for (const step of steps) {
            step();
            engine.recalc(NO_CAP);
            const { held, fresh } = values(engine);
            expect(held).toEqual(fresh);
        }
    });

    test('a hundred row inserts above ten thousand formulas of their own shape keep two shapes a formula', () => {
        const count = 10_000;
        const workbook = new Workbook([{ id: 'a', name: 'a', cells: (cell) => cell(0, 0, 1, null) }]);
        const recalc = new Recalc(workbook, FUNCTIONS);
        const [sheet] = workbook.sheets;
        for (let row = 1; row <= count; row += 1) recalc.fillFormula(sheet, row, 1, row, 1, `=R1C1+${row}`);
        recalc.pass(NO_CAP);
        expect(workbook.shapes.size).toBe(count);
        for (let i = 0; i < 100; i += 1) {
            const edit = { insert: true, index: 0, count: 1, sheet: 'a', rows: true };
            expect(recalc.edit({ kind: ChangeKind.Lines, edit }).rewrites).toHaveLength(count);
        }
        // The shapes in the cells and those the last edit left behind, which the next rebuild forgets.
        expect(workbook.shapes.size).toBeLessThanOrEqual(2 * count);
        recalc.pass(NO_CAP);
        expect(workbook.value(sheet.columns[1], count + 100)).toBe(1 + count);
        expect(sheet.columns[1].pending).toBe(0);
    }, 60_000);
});

const BLOCK = { fromSheet: 's1', row: 0, column: 0, rows: 2, columns: 1, toSheet: 's1', toRow: 0, toColumn: 0 };
