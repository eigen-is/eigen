import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import type { SheetSource } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { ChangeKind, SWEEP_FLOOR, Workbook } from '../../store/workbook';
import { engineOf, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;

// A text of its own that weighs as much as a cell's text can, in mixed case so that its comparison key is another.
const long = (label: string) => `${label} ${'x'.repeat(30_000)}`;

function texts(id: string, count: number, text: (row: number) => string): SheetSource {
    return {
        id,
        name: id,
        cells: (cell) => {
            for (let row = 0; row < count; row += 1) cell(row, 0, text(row), null);
        },
    };
}

describe('the string table weighs what the cells hold now, within the factor a sweep allows', () => {
    test('a hundred thousand text formulas fed by one cell, written twelve times', () => {
        const count = 100_000;
        const workbook = new Workbook([
            {
                id: 'a',
                name: 'a',
                cells: (cell) => {
                    cell(0, 1, 'Item 0/', null);
                    for (let row = 1; row <= count; row += 1) cell(row, 0, row, null);
                },
            },
        ]);
        const recalc = new Recalc(workbook, FUNCTIONS);
        const [sheet] = workbook.sheets;
        recalc.fillFormula(sheet, 1, 2, count, 2, stored('=$B$1&A2', 'C2'));
        recalc.pass(NO_CAP);
        // Every text is held by a cell here, and each write makes as many again of the same lengths.
        const { weight, size } = workbook.strings;
        expect(weight).toBeGreaterThan(SWEEP_FLOOR);
        for (let i = 1; i <= 12; i += 1) {
            recalc.setValue(sheet, 0, 1, `Item ${i % 10}/`);
            recalc.pass(NO_CAP);
            // Twice what the cells held at the last sweep, and what this pass made.
            expect(workbook.strings.weight).toBeLessThanOrEqual(3 * weight);
            expect(workbook.strings.size).toBeLessThanOrEqual(3 * size);
        }
        expect(workbook.value(sheet.columns[2], count)).toBe(`Item 2/${count}`);
    }, 60_000);

    test('one joined text of thirty thousand characters, rewritten four hundred times', () => {
        const workbook = new Workbook([texts('a', 3000, (row) => `name ${row}`)]);
        const recalc = new Recalc(workbook, FUNCTIONS);
        const [sheet] = workbook.sheets;
        recalc.fillFormula(sheet, 0, 2, 0, 2, stored('=TEXTJOIN(", ",TRUE,A1:A3000)', 'C1'));
        for (let i = 0; i < 400; i += 1) {
            recalc.setValue(sheet, i, 0, `edit ${i}`);
            recalc.pass(NO_CAP);
            // The table is far below the floor at its sweeps, so it is the floor and what one pass made.
            expect(workbook.strings.weight).toBeLessThanOrEqual(1.1 * SWEEP_FLOOR);
        }
        expect(String(workbook.value(sheet.columns[2], 0))).toStartWith('edit 0, edit 1, edit 2, ');
    }, 60_000);

    test('a removed sheet of a hundred thousand texts leaves what a load of the other sheet weighs', () => {
        const names = texts('a', 1000, (row) => `name ${row}`);
        const workbook = new Workbook([names, texts('b', 100_000, (row) => `Row ${row} ${'x'.repeat(88)}`)]);
        const recalc = new Recalc(workbook, FUNCTIONS);
        recalc.pass(NO_CAP);
        expect(workbook.strings.weight).toBeGreaterThan(SWEEP_FLOOR);
        recalc.edit({ kind: ChangeKind.RemoveSheet, sheet: 'b' });
        recalc.pass(NO_CAP);
        expect(workbook.strings.weight).toBe(new Workbook([names]).strings.weight);
    }, 60_000);
});

describe('a text no cell holds any more is forgotten, and the next new text takes its id', () => {
    // Eighty texts that weigh more than the floor together, written and cleared: the next recalc forgets them.
    function churn(engine: ReturnType<typeof engineOf>): void {
        for (let row = 0; row < 80; row += 1) engine.setValue('s1', row, 6, long(`Gone ${row}`));
        for (let row = 0; row < 80; row += 1) engine.clear('s1', row, 6);
        engine.recalc(NO_CAP);
    }

    test('the texts the cells hold and their comparison keys stay, whatever takes the freed ids', () => {
        const engine = engineOf({
            s1: {
                A1: 'Yes',
                A2: 'pear',
                A3: 'yes',
                A4: 'Straße',
                B1: '=COUNTIF(A:A,"YES")',
                B2: '=MATCH("PEAR",A:A,0)+MATCH("strasse",A:A,0)',
                B3: '=A1&"/"&A4',
                B4: '=COUNTIF(B3:B3,"yes/strasse")',
            },
        });
        engine.recalc(NO_CAP);
        churn(engine);
        for (let row = 0; row < 200; row += 1) engine.setValue('s1', row, 7, `Fresh ${row}`);
        engine.setValue('s1', 4, 0, 'YES');
        engine.recalc(NO_CAP);
        expect(['A1', 'A2', 'A3', 'A4', 'B3'].map((cell) => valueAt(engine, cell))).toEqual([
            'Yes',
            'pear',
            'yes',
            'Straße',
            'Yes/Straße',
        ]);
        expect(['B1', 'B2', 'B4'].map((cell) => valueAt(engine, cell))).toEqual([3, 6, 1]);
        expect(valueAt(engine, 'H200')).toBe('Fresh 199');
    });

    test('a text that takes the id of one that read as a number does not read as that number', () => {
        const engine = engineOf({ s1: { A1: '7', B1: '=COUNTIF(A:A,7)' } });
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'B1')).toBe(1);
        engine.clear('s1', 0, 0);
        churn(engine);
        for (let row = 0; row < 200; row += 1) engine.setValue('s1', row, 0, `seven ${row}`);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'B1')).toBe(0);
    });

    test('a pass that stopped goes on after a sweep with the texts its cells hold', () => {
        const engine = engineOf({ s1: { A1: 'Item' } });
        engine.fillFormula('s1', 0, 1, 99, 1, stored('=$A$1&" "&ROW()&REPT("x",30000)', 'B1'));
        for (let i = 0; i < 6; i += 1) {
            engine.setValue('s1', 0, 0, `Item ${i}`);
            // Each stops half way: the next begins with the texts of the first half held and those before them not.
            expect(engine.recalc(50).stopped).toBe(true);
        }
        expect(engine.recalc(NO_CAP).stopped).toBe(false);
        for (const row of [0, 49, 50, 99]) {
            expect(engine.valueOf('s1', row, 1)).toBe(`Item 5 ${row + 1}${'x'.repeat(30_000)}`);
        }
    });
});
