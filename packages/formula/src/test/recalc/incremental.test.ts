import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { Engine, REF } from '../../index';
import type { Cells } from './support';
import { at, engineOf, stored, valueAt } from './support';

const NO_CAP = Number.POSITIVE_INFINITY;
const KEPT = 'kept';
const NAMES: Readonly<Record<string, string>> = { s1: 'Sheet1', s2: 'Sheet2' };

function label(row: number, column: number): string {
    return `${String.fromCharCode(65 + column)}${row + 1}`;
}

// A workbook opened from cached values: every formula holds the text 'kept', so a formula that shows anything else
// was computed again. A key such as D1:E10 fills that block with the formula as it is typed at its first cell, and
// a formula with a [ in it is stored text already.
function opened(sheets: Readonly<Record<string, Cells>>) {
    const formulas: [sheet: string, row: number, column: number][] = [];
    const engine = new Engine(
        Object.entries(sheets).map(([id, cells]) => ({
            id,
            name: NAMES[id] ?? id,
            cells: (cell) => {
                for (const [key, input] of Object.entries(cells)) {
                    const [first, last = first] = key.split(':');
                    const [top, left] = at(first);
                    const [bottom, right] = at(last);
                    const formula = typeof input === 'string' && input.startsWith('=');
                    const text = formula && input.includes('[') ? input : stored(String(input), first);
                    for (let row = top; row <= bottom; row += 1) {
                        for (let column = left; column <= right; column += 1) {
                            if (formula) cell(row, column, KEPT, text);
                            else cell(row, column, input, null);
                        }
                    }
                }
            },
        })),
    );
    for (const [id, cells] of Object.entries(sheets)) {
        for (const [key, input] of Object.entries(cells)) {
            if (typeof input !== 'string' || !input.startsWith('=')) continue;
            const [first, last = first] = key.split(':');
            const [top, left] = at(first);
            const [bottom, right] = at(last);
            for (let column = left; column <= right; column += 1) {
                for (let row = top; row <= bottom; row += 1) formulas.push([id, row, column]);
            }
        }
    }
    // The formulas a recalc computed again, in the order they were given, column by column.
    const computed = (cap = NO_CAP): string[] => {
        expect(engine.recalc(cap).stopped).toBe(false);
        return formulas
            .filter(([id, row, column]) => engine.valueOf(id, row, column) !== KEPT)
            .map(([id, row, column]) => (id === 's1' ? label(row, column) : `${id}!${label(row, column)}`));
    };
    const write = (cell: string, value: Literal, sheet = 's1') => engine.setValue(sheet, ...at(cell), value);
    return { engine, computed, write };
}

function labels(column: string, from: number, to: number): string[] {
    return Array.from({ length: to - from + 1 }, (_, i) => `${column}${from + i}`);
}

describe('what a recalc computes', () => {
    test('nothing, in a workbook opened from its cached values', () => {
        const { computed } = opened({ s1: { A1: 5, B1: '=A1*2', C1: '=B1+1' } });
        expect(computed()).toEqual([]);
    });

    test('a formula that was never computed, and the formulas that read it', () => {
        const engine = new Engine([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    cell(0, 0, 5, null);
                    cell(0, 1, null, '=RC[-1]*2');
                    cell(0, 2, KEPT, '=RC[-1]+1');
                    cell(0, 3, KEPT, '=RC[-3]+1');
                },
            },
        ]);
        engine.recalc(NO_CAP);
        expect(['B1', 'C1', 'D1'].map((cell) => valueAt(engine, cell))).toEqual([10, 11, KEPT]);
    });

    test('the formulas a written cell reaches, through other formulas and other sheets', () => {
        const { computed, write } = opened({
            s1: { A1: 1, A2: 2, B1: '=A1*2', B2: '=A2*2', C1: '=B1+Sheet2!A1', C2: '=B2+1', D1: '=SUM(C1:C2)' },
            s2: { A1: '=Sheet1!A2', B1: '=A1+Sheet1!C1', C1: '=5+5' },
        });
        write('A1', 10);
        expect(computed()).toEqual(['B1', 'C1', 'D1', 's2!B1']);
        write('A2', 20);
        expect(computed()).toEqual(['B1', 'B2', 'C1', 'C2', 'D1', 's2!A1', 's2!B1']);
    });

    test('a formula that is typed, and its readers', () => {
        const { engine, computed } = opened({ s1: { A1: 1, B1: '=A1*2', C1: '=B1+1', B2: '=A1*3', C2: '=A2+1' } });
        engine.setFormula('s1', 0, 1, '=RC[-1]*5');
        expect(computed()).toEqual(['B1', 'C1']);
        expect(valueAt(engine, 'B1')).toBe(5);
        engine.setFormula('s1', 1, 0, '=7*1');
        expect(computed()).toEqual(['B1', 'C1', 'C2']);
        expect(valueAt(engine, 'C2')).toBe(8);
    });

    test('the readers of a formula that is cleared or overwritten by a value', () => {
        const { engine, computed, write } = opened({
            s1: { A1: 1, B1: '=A1*2', C1: '=B1+1', B2: '=A1*3', C2: '=B2+1' },
        });
        engine.clear('s1', 0, 1);
        expect(computed()).toEqual(['B1', 'C1']);
        expect(valueAt(engine, 'C1')).toBe(1);
        write('B2', 4);
        expect(computed()).toEqual(['B1', 'C1', 'B2', 'C2']);
        expect(valueAt(engine, 'C2')).toBe(5);
        write('A1', 9);
        engine.recalc(NO_CAP);
        expect(['C1', 'C2'].map((cell) => valueAt(engine, cell))).toEqual([1, 5]);
    });

    test('a write to a cell past the end of its column reaches a whole-column reader', () => {
        const { engine, computed, write } = opened({ s1: { B1: '=SUM(A:A)', C1: '=SUM(D2:D3)', A1: 1 } });
        write('A500000', 3);
        expect(computed()).toEqual(['B1']);
        expect(valueAt(engine, 'B1')).toBe(4);
        engine.clear('s1', 7, 9);
        expect(computed()).toEqual(['B1']);
    });

    test('several cells written before one recalc', () => {
        const { computed, write } = opened({ s1: { 'D1:D10': '=B1*C1', E1: '=SUM(D1:D3)', E2: '=SUM(D8:D9)' } });
        for (const cell of ['B2', 'B3', 'B4', 'C7', 'A1', 'B10']) write(cell, 1);
        expect(computed()).toEqual(['D2', 'D3', 'D4', 'D7', 'D10', 'E1']);
    });
});

describe('the hosts of a filled formula that read a written cell', () => {
    // The block that is filled, the formula at its first cell, and per written cell the formulas computed again.
    test.each<[string, string, string, Readonly<Record<string, string[]>>]>([
        ['both ends relative', 'D1:D10', '=B1*C1', { B5: ['D5'], C10: ['D10'], A5: [], B11: [] }],
        ['both ends absolute', 'D1:D10', '=$B$3+1', { B3: labels('D', 1, 10), B4: [], C3: [] }],
        ['a window that slides', 'D1:D10', '=SUM(B1:C3)', { C5: labels('D', 3, 5), B1: ['D1'], B12: ['D10'] }],
        ['a running total', 'D1:D10', '=SUM(B$1:B1)', { B4: labels('D', 4, 10), B1: labels('D', 1, 10), B11: [] }],
        ['a total of what is left', 'D1:D10', '=SUM(B1:B$10)', { B4: labels('D', 1, 4), B10: labels('D', 1, 10) }],
        [
            'corners that cross at some hosts',
            'D1:D10',
            '=SUM(B$5:B1)',
            { B3: labels('D', 1, 3), B7: labels('D', 7, 10), B5: labels('D', 1, 10), B11: [] },
        ],
        ['an absolute end typed second', 'D1:D10', '=SUM(B1:B$1)', { B4: labels('D', 4, 10), B1: labels('D', 1, 10) }],
        ['a whole column', 'D1:D10', '=SUM(B:C)', { C900: labels('D', 1, 10), E1: [], A1: [] }],
        ['whole rows that move with the host', 'D11:D14', '=SUM(3:3)', { Z4: ['D12'], A6: ['D14'], Z7: [] }],
        [
            'a whole row and a relative one',
            'D11:D14',
            '=SUM($5:6)',
            { Z5: labels('D', 11, 14), A7: labels('D', 12, 14) },
        ],
        [
            'a row filled right, one column fixed',
            'D1:F1',
            '=SUM($A2:A2)',
            { A2: ['D1', 'E1', 'F1'], B2: ['E1', 'F1'], C2: ['F1'] },
        ],
        [
            'a block, each reference fixed on one axis',
            'D1:E10',
            '=$A1+B$2',
            { A5: ['D5', 'E5'], B2: labels('D', 1, 10), C2: labels('E', 1, 10), B3: [] },
        ],
        [
            'a block that reads a block',
            'D1:E4',
            '=SUM(A1:B2)',
            { B3: ['D2', 'D3', 'E2', 'E3'], C1: ['E1'], A5: ['D4'] },
        ],
        ['another sheet', 'D1:D10', '=Sheet2!A1*2', { 's2!A5': ['D5'], A5: [], 's2!A11': [] }],
        [
            'another sheet, fixed',
            'D1:D3',
            '=SUM(Sheet2!A$2:B2)',
            { 's2!B2': labels('D', 1, 3), 's2!A3': ['D2', 'D3'], B2: [] },
        ],
        ['offsets that leave the grid at the first hosts', 'D1:D10', '=R[-3]C[-1]', { C1: ['D4'], C2: ['D5'], C8: [] }],
        [
            'a range that leaves the grid at the first hosts',
            'D1:D10',
            '=SUM(R[-3]C[-3]:RC[-1])',
            { A1: ['D4'], C2: ['D4', 'D5'] },
        ],
        ['a sheet that does not exist', 'D1:D10', '=Nope!A1+1', { A1: [], B5: [] }],
        ['a sheet id that does not exist', 'D1:D10', '=[zz]!R1C1+1', { A1: [] }],
        ['a branch that is not taken', 'D1:D10', '=IF(TRUE,1,B1)', { B5: ['D5'] }],
    ])('%s', (_name, block, formula, edits) => {
        for (const [cell, expected] of Object.entries(edits)) {
            const { computed, write } = opened({ s1: { [block]: formula }, s2: { C9: 1 } });
            const [sheet, name] = cell.includes('!') ? cell.split('!') : ['s1', cell];
            write(name, 7, sheet);
            expect([cell, ...computed()]).toEqual([cell, ...expected]);
        }
    });

    test('a span of rows written at once', () => {
        const { computed, write } = opened({ s1: { 'D1:D10': '=SUM(B1:B2)', 'E1:E10': '=B$4', 'F1:F10': '=A1' } });
        for (const cell of ['B6', 'B7', 'B8']) write(cell, 1);
        expect(computed()).toEqual(labels('D', 5, 8));
    });

    test('a run that a value splits is two rectangles', () => {
        const { engine, computed, write } = opened({ s1: { 'D1:D10': '=B1*2', 'E1:E10': '=D1+1' } });
        write('D5', 100);
        expect(computed()).toEqual(['D5', 'E5']);
        write('B5', 1);
        expect(computed()).toEqual(['D5', 'E5']);
        write('B6', 1);
        expect(computed()).toEqual(['D5', 'D6', 'E5', 'E6']);
        engine.setFormula('s1', 4, 3, '=RC[-2]*2');
        expect(computed()).toEqual(['D5', 'D6', 'E5', 'E6']);
        write('B4', 1);
        expect(computed()).toEqual(['D4', 'D5', 'D6', 'E4', 'E5', 'E6']);
    });

    test('columns of one shape with different rows are separate rectangles', () => {
        const { computed, write } = opened({
            s1: { 'D1:D10': '=$A1', 'E3:E10': '=$A3', 'F3:F10': '=$A3', 'G3:G9': '=$A3' },
        });
        write('A2', 1);
        expect(computed()).toEqual(['D2']);
        write('A10', 1);
        expect(computed()).toEqual(['D2', 'D10', 'E10', 'F10']);
    });
});

describe('a formula that reads cells its references do not name', () => {
    test('is computed by every recalc after a write, with its readers', () => {
        const { engine, computed, write } = opened({
            s1: { A1: 1, B2: 2, C3: 3, E1: '=SUM(A1:INDEX(C1:C3,3))', F1: '=E1+1', G1: '=A1+1' },
        });
        write('B2', 20);
        expect(computed()).toEqual(['E1', 'F1']);
        expect(valueAt(engine, 'F1')).toBe(25);
        write('B3', 100);
        engine.recalc(NO_CAP);
        expect(valueAt(engine, 'F1')).toBe(125);
    });

    test('a function that reads past the range it names is one', () => {
        const { engine, computed, write } = opened({
            s1: { B1: 1, B2: 1, B3: 1, C1: 1, C2: 2, C3: 3, A1: '=SUMIF(B1:B3,">0",C1)', A2: '=A1+1', A3: '=C1' },
        });
        write('C3', 10);
        expect(computed()).toEqual(['A1', 'A2']);
        expect(valueAt(engine, 'A1')).toBe(13);
    });

    test('SUMIF and AVERAGEIF are, only when the range they add up is not as large as the one they test', () => {
        const { engine, computed, write } = opened({
            s1: {
                B1: 1,
                B2: 1,
                B3: 1,
                C1: 1,
                C2: 2,
                C3: 3,
                E1: '=SUMIF(B1:B3,">0",C1:C3)',
                E2: '=AVERAGEIF($B$1:$B$3,">0",$C$1:$C$3)',
                E3: '=SUMIF(B:B,">0",C:C)',
                E4: '=SUMIF(B1:B3,">0")',
                F1: '=SUMIF(B1:B3,">0",C1:C2)',
                F2: '=AVERAGEIF(B1:B3,">0",C1)',
                F3: '=SUMIF(B1:B3,">0",C$1:C3)',
                F4: '=SUMIF(B1:B3,">0",(C1:C3))',
                F5: '=SUMIF(B1:B3,">0",C1:D3)',
            },
        });
        write('Z9', 1);
        expect(computed()).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
        write('C3', 10);
        expect(computed()).toEqual(['E1', 'E2', 'E3', 'F1', 'F2', 'F3', 'F4', 'F5']);
        expect(valueAt(engine, 'E1')).toBe(13);
        expect(valueAt(engine, 'F2')).toBe(13 / 3);
    });

    test('whatever cell was written, and not when none was', () => {
        const { computed, write } = opened({
            s1: { A1: 1, 'E1:F2': '=SUM($A$1:INDEX($C$1:$C$3,3))', G1: '=F2+1', H1: '=A1' },
            s2: { A1: 1 },
        });
        expect(computed()).toEqual([]);
        write('Z9', 1, 's2');
        expect(computed()).toEqual(['E1', 'E2', 'F1', 'F2', 'G1']);
    });
});

describe('circular references between recalcs', () => {
    test('a loop that a write makes is reported, and its readers are computed', () => {
        const { engine } = opened({ s1: { A1: 1, B1: '=A1+1', C1: '=B1+1', D1: '=IFERROR(C1,"loop")' } });
        engine.setFormula('s1', 0, 0, '=RC[2]');
        const { loops } = engine.recalc(NO_CAP);
        expect(loops.map(({ column }) => column).sort()).toEqual([0, 1, 2]);
        expect(['A1', 'B1', 'C1', 'D1'].map((cell) => valueAt(engine, cell))).toEqual([REF, REF, REF, 'loop']);
        engine.setValue('s1', 0, 0, 1);
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        expect(['B1', 'C1', 'D1'].map((cell) => valueAt(engine, cell))).toEqual([2, 3, 3]);
    });

    test('a loop that no write reaches is still reported, and not computed again', () => {
        const { engine, computed, write } = opened({ s1: { A1: '=B1', B1: '=A1', C1: 1, D1: '=C1+1', E1: '=A1' } });
        engine.setFormula('s1', 0, 0, '=RC[1]');
        expect(engine.recalc(NO_CAP).loops).toEqual([
            { sheet: 's1', row: 0, column: 0 },
            { sheet: 's1', row: 0, column: 1 },
        ]);
        write('C1', 5);
        expect(engine.recalc(NO_CAP).loops.length).toBe(2);
        expect(computed()).toEqual(['A1', 'B1', 'D1', 'E1']);
        write('B1', 3);
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
        engine.setFormula('s1', 0, 1, '=RC[-1]');
        expect(engine.recalc(NO_CAP).loops.length).toBe(2);
        engine.clear('s1', 0, 0);
        expect(engine.recalc(NO_CAP).loops).toEqual([]);
    });
});

describe('the cap of an edit', () => {
    const ROWS = 10000;
    const filled = () =>
        new Engine([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    for (let row = 0; row < ROWS; row += 1) {
                        cell(row, 1, row, null);
                        cell(row, 2, 2, null);
                        cell(row, 3, row * 2, '=RC[-2]*RC[-1]');
                    }
                },
            },
        ]);

    test('an edit computes the formulas of its cone, not of the workbook', () => {
        const engine = filled();
        engine.setValue('s1', 499, 1, 7);
        expect(engine.recalc(1)).toMatchObject({ loops: [], stopped: false });
        expect(engine.valueOf('s1', 499, 3)).toBe(14);
    });

    test('an edit that is stopped keeps what it computed, and the next recalcs finish it', () => {
        const engine = filled();
        engine.setValue('s1', 499, 1, 7);
        engine.setFormula('s1', 0, 4, '=R[499]C[-1]+R[500]C[-1]');
        engine.setValue('s1', 500, 1, 1);
        expect(engine.recalc(1).stopped).toBe(true);
        expect([499, 500].map((row) => engine.valueOf('s1', row, 3))).toEqual([14, 1000]);
        expect(engine.recalc(1).stopped).toBe(true);
        expect([engine.valueOf('s1', 500, 3), engine.valueOf('s1', 0, 4)]).toEqual([2, null]);
        expect(engine.recalc(1)).toMatchObject({ loops: [], stopped: false });
        expect(engine.valueOf('s1', 0, 4)).toBe(16);
        expect(engine.recalc(0).stopped).toBe(false);
    });

    test('a formula that costs more than the cap alone is stored by one pass, so stopped passes come to an end', () => {
        const cells: Record<string, Literal> = {
            N1: '=SUM(A1:A50*2)',
            N2: '=N1+SUMPRODUCT(A1:B50,A1:B50)',
            P1: '=P2+SUM(A1:A50*1)',
            P2: '=P1',
            Q1: '=N2+1',
        };
        for (let row = 1; row <= 50; row += 1) cells[`A${row}`] = row;
        for (let cap = 0; cap <= 8; cap += 1) {
            const engine = engineOf({ s1: cells });
            let result = engine.recalc(cap);
            expect(valueAt(engine, 'N1')).toBe(2550);
            for (let pass = 0; result.stopped && pass < 20; pass += 1) result = engine.recalc(cap);
            expect(result.stopped).toBe(false);
            expect(result.loops).toHaveLength(2);
            expect(valueAt(engine, 'Q1')).toBe(2550 + 42925 + 1);
            expect(valueAt(engine, 'P2')).toBe(REF);
        }
    });

    test('with a cap of 0 every pass still stores one formula, or one whole loop', () => {
        const engine = engineOf({ s1: { A1: '=1+1', A2: '=A3', A3: '=A2', A4: '=A1+1' } });
        expect(engine.recalc(0).stopped).toBe(true);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A4')]).toEqual([2, null]);
        expect(engine.recalc(0).stopped).toBe(true);
        expect([valueAt(engine, 'A2'), valueAt(engine, 'A3'), valueAt(engine, 'A4')]).toEqual([REF, REF, null]);
        expect(engine.recalc(0)).toMatchObject({ stopped: false });
        expect(valueAt(engine, 'A4')).toBe(3);
    });

    test('the elements of a formula that runs again after the nesting got too deep count once', () => {
        // Each formula makes an array of two elements twice and then reads the one below it, so the first one asked
        // nests through all of them: 599 formulas of 1 and 4, and the one that asks.
        const cells: Record<string, Literal> = { A600: 1, Y1: 1 };
        for (let row = 1; row < 600; row += 1) cells[`A${row}`] = `=SUM((Y1:Z1)*1)+A${row + 1}`;
        const cost = 599 * 5 + 1;
        const exact = engineOf({ s1: { ...cells, C1: '=A1' } });
        expect(exact.recalc(cost).stopped).toBe(false);
        expect(valueAt(exact, 'C1')).toBe(600);
        expect(engineOf({ s1: { ...cells, C1: '=A1' } }).recalc(cost - 1).stopped).toBe(true);
    });

    test.each([[0], [1], [2], [3], [4], [5], [6]])(
        'stopped passes come to an end on arrays, loops and deep chains: cap %i',
        (cap) => {
            const cells: Record<string, Literal> = { A200: 1, C1: '=SUM(A1:A200*2)', D1: '=D2+SUM(A:A)', D2: '=D1' };
            for (let row = 1; row < 200; row += 1) cells[`A${row}`] = `=SUM((A${row + 1}:B${row + 1})*1)+1`;
            const engine = engineOf({ s1: cells });
            let result = engine.recalc(cap);
            for (let pass = 0; result.stopped && pass < 1000; pass += 1) result = engine.recalc(cap);
            expect(result.stopped).toBe(false);
            expect(result.loops).toHaveLength(2);
            expect(valueAt(engine, 'C1')).toBe(200 * 201);
        },
    );
});
