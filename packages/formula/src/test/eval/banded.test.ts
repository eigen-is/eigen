import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { CALC, DIV0, Engine, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { at, engineOf, evaluate, stored, valueAt } from '../recalc/support';

const ALL = Number.POSITIVE_INFINITY;

// One number added to a sum over and over, one addition at a time.
function added(sum: number, value: number, times: number): number {
    let total = sum;
    for (let i = 0; i < times; i += 1) total += value;
    return total;
}

describe('an array costs the cells that exist, wherever they lie', () => {
    test('two cells at the far ends of the sheet: no throw, right values, and the engine goes on', () => {
        const engine = engineOf({
            s1: { B2: 1, XFD1048576: 1, A1: '=B1:XFD1048576+1', A3: '=1+1', A6: '=A3+1' },
            s2: {
                A1: '=INDEX(Sheet1!B1:XFD1048576+1,2,1)',
                A2: '=INDEX(Sheet1!B1:XFD1048576+1,1048576,16383)',
                A3: '=INDEX(Sheet1!B1:XFD1048576+1,1048575,16383)',
                A4: '=SUM(Sheet1!B1:XFD1048576+1)',
            },
        });
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(engine, 'A1')).toBe(1);
        expect(valueAt(engine, 'A6')).toBe(3);
        expect(valueAt(engine, 'A1', 's2')).toBe(2);
        expect(valueAt(engine, 'A2', 's2')).toBe(2);
        expect(valueAt(engine, 'A3', 's2')).toBe(1);
        expect(valueAt(engine, 'A4', 's2')).toBe(1048576 * 16383 + 2);
        engine.clear('s1', 0, 0);
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        engine.setValue('s1', 2, 0, 5);
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(engine, 'A6')).toBe(6);
    });

    test('a wide reference with one cell at each end is computed at once', () => {
        const started = performance.now();
        const engine = engineOf({ s1: { A1: 1, KN1048576: 2, KP1: '=A:KN+1', KP2: '=SUM(A:KN+1)' } });
        engine.recalc(ALL);
        expect(valueAt(engine, 'KP1')).toBe(2);
        expect(valueAt(engine, 'KP2')).toBe(1048576 * 300 + 3);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test('a range is walked over the cells that exist: one at the last row and one at the last column', () => {
        const engine = engineOf({
            s1: { A1: '=SUM(Sheet2!A1:XFD1048576)', A2: '=COUNTA(Sheet2!A1:XFD1048576)' },
            s2: { A1048576: 3, XFD1: 4 },
        });
        const started = performance.now();
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(7);
        expect(valueAt(engine, 'A2')).toBe(2);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test('columns of different lengths are walked row by row, each as far as it goes', () => {
        const lengths = [5, 0, 9, 2, 9, 1, 7, 3];
        const cells: Record<string, Literal> = {};
        const rows: number[][] = [];
        for (let row = 0; row < 9; row += 1) {
            rows.push([]);
            for (let c = 0; c < lengths.length; c += 1) {
                if (row >= lengths[c]) continue;
                cells[label(row, c + 1)] = 0.1 * (row * 8 + c + 1);
                rows[row].push(0.1 * (row * 8 + c + 1));
            }
        }
        const sum = (from: number) => rows.slice(from).reduce((all, row) => row.reduce((a, b) => a + b, all), 0);
        const count = (from: number) => rows.slice(from).reduce((all, row) => all + row.length, 0);
        expect(evaluate('=SUM(B1:I9,0)', cells)).toBe(sum(0));
        expect(evaluate('=SUM(B3:I1048576,0)', cells)).toBe(sum(2));
        expect(evaluate('=SUM(B8:XFD9,0)', cells)).toBe(sum(7));
        expect(evaluate('=COUNT(B1:I9)', cells)).toBe(count(0));
        expect(evaluate('=COUNT(A6:I9)', cells)).toBe(count(5));
        expect(evaluate('=MAX(C1:E9)', cells)).toBe(0.1 * (8 * 8 + 3));
        expect(evaluate('=SUBTOTAL(9,B1:I9)+0', cells)).toBe(sum(0));
        expect(evaluate('=SUM(B10:I20)', cells)).toBe(0);
        // A wide array first, then a range as wide: the walk of the one leaves room for the other.
        expect(evaluate('=SUM(A1:T2*2,A1:T2)', { A1: 1, T1: 2, K2: 4 }, 'Z1')).toBe(21);
    });

    test('the whole sheet as an array, with nothing on it', () => {
        expect(evaluate('=SUM(--(Sheet2!A1:XFD1048576=""))')).toBe(2 ** 34 - 1);
        expect(evaluate('=SUM(0.5,--(Sheet2!A1:XFD1048576=""))')).toBe(2 ** 34 - 0.5);
    });
});

// Excel's answers, batch 3 `b3_big`: A1:C3 = 1..9, D1:F3 = 10..18.
describe('a shorter array is #N/A past its end, whatever the sheet holds', () => {
    const block: Cells = { A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6, A3: 7, B3: 8, C3: 9 };
    const beside: Cells = { D1: 10, E1: 11, F1: 12, D2: 13, E2: 14, F2: 15, D3: 16, E3: 17, F3: 18 };

    test.each([
        ['=A1:C3+D:F', 11],
        ['=INDEX(A1:C3+D:F,3,3)', 27],
        ['=INDEX(A1:C3+D:F,4,1)', NA],
        ['=INDEX(A1:C3+D:F,1048576,3)', NA],
        ['=SUMPRODUCT(--ISNUMBER(A1:C3+D:F))', 9],
        ['=SUMPRODUCT(--ISERROR(A1:C3+D:F))', 3145719],
        ['=SUM(A1:C3+D:F)', NA],
        ['=SUM(IFERROR(A1:C3+D:F,0))', 171],
        ['=INDEX(D1:F1000000+D:F,1,1)', 20],
        ['=INDEX(D1:F1000000+D:F,1000001,1)', NA],
        ['=SUM(D1:F1000000+D1:F1000000)', 252],
    ])('%s is %p with and without a value in F1048576', (formula, expected) => {
        expect(evaluate(formula, { ...block, ...beside })).toBe(expected);
        expect(evaluate(formula, { ...block, ...beside, F1048576: 5 })).toBe(expected);
    });

    test('an empty cell a host reports at load changes nothing', () => {
        const formula = stored('=A1:C3+D:F', 'H1');
        const load = (reported: boolean) =>
            new Engine([
                {
                    id: 's1',
                    name: 'Sheet1',
                    cells: (cell) => {
                        cell(0, 0, 1, null);
                        cell(0, 3, 10, null);
                        if (reported) cell(1048575, 5, null, null);
                        cell(0, 7, null, formula);
                    },
                },
            ]);
        for (const reported of [false, true]) {
            const engine = load(reported);
            engine.recalc(ALL);
            expect(engine.valueOf('s1', 0, 7)).toBe(11);
        }
    });

    test('a union is no array', () => {
        expect(evaluate('=(A1,B1)+1', block)).toBe(VALUE);
    });
});

describe('a sum over an array is the sum of its written elements, one by one', () => {
    const three: Cells = { B1: 2, B2: 5, B3: 8 };

    test('Excel: 1,048,573 additions of 0.1', () => {
        const sum = evaluate('=SUM((B:B="")*0.1)', three);
        expect(sum).toBe(added(0, 0.1, 1048573));
        expect(sum).toBe(104857.30000161561);
        expect(evaluate('=SUM((B:B="")*0.1)-104857.6', three)).toBeCloseTo(-0.299998384391074, 14);
        expect(evaluate('=AVERAGE((B:B="")*0.1)', three)).toBe(added(0, 0.1, 1048573) / 1048576);
        expect(evaluate('=SUM(-104857.6,(B:B="")*0.1)')).toBe(added(-104857.6, 0.1, 1048576));
        expect(evaluate('=SUM(--(B:B=""))', three)).toBe(1048573);
    });

    // Excel's answers, batch 4, on an empty sheet.
    test.each([
        ['=SUM((Sheet2!A:P="")*0.1)', 1677721.6004136028],
        ['=SUM((Sheet2!A:Q="")*0.1)', 1782579.200511259],
        ['=SUM(0.5,--(Sheet2!A:Q=""))', 17825792.5],
        ['=SUM(--(Sheet2!A:Q=""),0.5)', 17825792.5],
    ])('Excel: %s is %p', (formula, expected) => {
        const engine = engineOf({ s1: { A1: formula }, s2: {} });
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(expected);
    });

    test('a row of different numbers that stands for many rows is added row after row', () => {
        const cells: Cells = { A1: 0.1, B1: 0.7, C1: -0.3 };
        let sum = 0.1 + 0.7 + -0.3;
        for (let row = 1; row < 1000; row += 1) sum = sum + 0.1 + 0.7 + -0.3;
        expect(evaluate('=SUM((F1:F1000="")*A1:C1)', cells)).toBe(sum);
        expect(evaluate('=SUM((Sheet2!F1:F1000="")*IF(Sheet2!A1:XFD1="",0.7,0.1))')).toBe(added(0, 0.7, 16384000));
        let wide = 0;
        for (let row = 0; row < 1000; row += 1) wide = added(wide + 0.1, 0.7, 16383);
        expect(evaluate('=SUM((F2:F1001="")*IF(1:1="",0.7,A1))', { A1: 0.1 }, 'N2')).toBe(wide);
    });

    // Excel's answers, batches 2 to 4: C1:C3 = 0.1, 0.2, -0.3, C4 blank, C5 = 0.
    test.each([
        ['=SUM(C1:C3)', 0],
        ['=SUM(C1:C4)', 0],
        ['=SUM(C1:C5)', 5.551115123125783e-17],
        ['=SUM(C1:C3,)', 5.551115123125783e-17],
        ['=SUM(C1:C3*1)', 0],
        ['=SUM(C1:C4*1)', 5.551115123125783e-17],
        ['=SUM(C:C*1)', 5.551115123125783e-17],
        ['=SUM(IF({1;1;1;1},C1:C4))', 5.551115123125783e-17],
        ['=SUM(IF({1;1;1},C1:C3))', 0],
        ['=SUM(IF(C1:C4="","x",C1:C4))', 0],
        ['=SUMPRODUCT(C1:C3)', 5.551115123125783e-17],
        ['=SUMPRODUCT(C1:C3,{1;1;1})', 5.551115123125783e-17],
    ])('the last addition snaps: %s is %p', (formula, expected) => {
        expect(evaluate(formula, { C1: 0.1, C2: 0.2, C3: -0.3, C5: 0 })).toBe(expected);
    });
});

// Excel's answers, batches 2 and 3.
describe('SUMPRODUCT', () => {
    const cells: Cells = {
        A1: 10,
        A2: 20,
        A3: 30,
        B1: NA,
        B2: 2,
        B3: 3,
        C1: 10,
        C2: 20,
        C3: 30,
        E1: 1,
        E2: DIV0,
        E3: 3,
    };
    const order: Cells = { H1: 1e16, I1: 1, H2: -1e16, I2: 1, H11: 1e16, H12: 1, I11: -1e16, I12: 1 };

    test.each([
        ['=SUMPRODUCT(A1:A3,#N/A)', NA],
        ['=SUMPRODUCT("2",3)', 0],
        ['=SUMPRODUCT(2,3)', 6],
        ['=SUMPRODUCT(A1:A3,"2")', VALUE],
        ['=SUMPRODUCT(E1:E3,B1:B3)', DIV0],
        ['=SUMPRODUCT(B1:B3,E1:E3)', NA],
        ['=SUMPRODUCT(E1:E3,A1:A3)', DIV0],
        ['=SUMPRODUCT(B1:B3,C1:C2)', NA],
        ['=SUMPRODUCT(C1:C3,B1:B2)', NA],
        ['=SUMPRODUCT(C1:C3,B2:B3)', VALUE],
        ['=SUMPRODUCT(C1:C3,2)', VALUE],
        ['=SUMPRODUCT(B1:B3,2)', NA],
        ['=SUMPRODUCT((A1:A3,C1:C3))', VALUE],
        ['=SUMPRODUCT(A1:A3,C1:C3)', 1400],
        ['=SUMPRODUCT(A1:A3,C1:C3,{1;0;2})', 1900],
        ['=SUMPRODUCT(A1:C1,A2:C2)', NA],
        ['=SUMPRODUCT(A2:C2,A3:C3)', 600 + 6 + 600],
        ['=SUMPRODUCT(H1:I2)', 1],
        ['=SUMPRODUCT(H11:I12)', 2],
        ['=SUMPRODUCT(H1:I2,{1,1;1,1})', 1],
        ['=SUMPRODUCT(H11:I12,{1,1;1,1})', 2],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, { ...cells, ...order })).toBe(expected);
    });
});

describe('a search in an array meets a run of equal values once', () => {
    const cells: Cells = { B1: 2, B2: 5, B3: 8, B500000: 7 };

    test.each([
        ['=MATCH(1,--(B:B=""),0)', 4],
        ['=MATCH(0,--(B:B=""),0)', 1],
        ['=XMATCH(0,--(B:B=""),0,-1)', 500000],
        ['=XMATCH(1,--(B:B=""),0,-1)', 1048576],
        ['=XMATCH(1,--(B:B=""),0,1)', 4],
        ['=XMATCH(7,B:B*1,0,-1)', 500000],
        ['=XMATCH(3,B:B*1,-1,-1)', 1],
        ['=XMATCH(6,B:B*1,1,-1)', 500000],
        ['=XMATCH(0,B:B*1,-1,-1)', 1048576],
        ['=XMATCH(0,B:B*1,-1,1)', 4],
        ['=MATCH(2,(B:B="")+1)', 1048576],
        ['=MATCH(2,(B1:B499999="")+1)', 499999],
        ['=MATCH(1,(B1:B500000="")+1)', 3],
        ['=XMATCH(,B:B)', 4],
        ['=XMATCH(,B:B,0,-1)', 1048576],
        ['=XMATCH(,IF(B:B="",,1))', 4],
        ['=XMATCH(,IF(B1:B500000="",,1),0,-1)', 499999],
        ['=XMATCH("",IF(B:B="","",1),0,-1)', 1048576],
        ['=XMATCH("",IF(B1:B500000="","",1),0,-1)', 499999],
        ['=VLOOKUP(7,B:B*{1,2},2,FALSE)', 14],
        ['=XLOOKUP(7,B:B*1,B:B*3)', 21],
        ['=INDEX(XLOOKUP(7,B:B*1,B:B*{3,4}),1,2)', 28],
        ['=SUM(INDEX(B:B*{3,4,4,4},500000,0))', 105],
        ['=SUM(INDEX((B:B="")*{1,2},0,2))', 2 * 1048572],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test.each([
        ['=HLOOKUP(1,--(1:1=""),1,FALSE)', 1],
        ['=XMATCH(1,--(1:1=""),0,-1)', 16384],
        ['=XMATCH(0,--(1:1=""),0,-1)', 2],
        ['=XMATCH(1,--(1:1=""),0,1)', 1],
    ])('along a row: %s is %p', (formula, expected) => {
        expect(evaluate(formula, cells, 'N2')).toBe(expected);
    });
});

// A diagonal of cells with a gap before each: every cell adds two stored rows and two stored columns.
function diagonal(count: number): Cells {
    const cells: Record<string, Literal> = {};
    for (let i = 0; i < count; i += 1) cells[label(2 * i + 1, 2 * i + 1)] = 1;
    return cells;
}

function label(row: number, column: number): string {
    let letters = '';
    for (let c = column + 1; c > 0; c = Math.floor((c - 1) / 26))
        letters = String.fromCharCode(65 + ((c - 1) % 26)) + letters;
    return `${letters}${row + 1}`;
}

describe('the bound on what one array stores', () => {
    const blanks = '=SUM(--(Sheet2!A1:XFD1048576=""))';

    test('more than 2^24 stored elements is #CALC!, on a load and after any edits', () => {
        const loaded = engineOf({ s1: { A1: blanks, A2: '=1+1' }, s2: diagonal(2048) });
        expect(loaded.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(loaded, 'A1')).toBe(CALC);
        expect(valueAt(loaded, 'A2')).toBe(2);

        const edited = engineOf({ s1: { A1: blanks }, s2: diagonal(40) });
        edited.recalc(ALL);
        expect(valueAt(edited, 'A1')).toBe(2 ** 34 - 40);
        for (let i = 40; i < 2060; i += 1) edited.setValue('s2', 2 * i + 1, 2 * i + 1, 1);
        for (let i = 2048; i < 2060; i += 1) edited.clear('s2', 2 * i + 1, 2 * i + 1);
        edited.recalc(ALL);
        expect(valueAt(edited, 'A1')).toBe(CALC);
        for (let i = 40; i < 2048; i += 1) edited.clear('s2', 2 * i + 1, 2 * i + 1);
        edited.recalc(ALL);
        expect(valueAt(edited, 'A1')).toBe(2 ** 34 - 40);
    });

    test('an operation of two arrays stores 2^24 elements, and one row more is #CALC!', () => {
        const cells: Record<string, Literal> = {};
        for (let i = 0; i < 4097; i += 1) {
            cells[label(i, 0)] = 1;
            cells[label(0, i + 1)] = 1;
        }
        const row = `Sheet2!B1:${label(0, 4096)}`;
        const engine = engineOf({
            s1: { A1: `=SUM(Sheet2!A1:A4097+${row})`, A2: `=SUM(Sheet2!A1:A4096+${row})` },
            s2: cells,
        });
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(CALC);
        expect(valueAt(engine, 'A2')).toBe(2 * 4096 * 4096);
    });

    test('a row of different numbers is added for more cells than an array stores, up to the work of a formula', () => {
        const row: Record<string, Literal> = {};
        for (let i = 0; i < 129; i += 1) row[label(0, i + 1)] = i + 1;
        const engine = engineOf({
            s1: {
                A1: `=SUM((Sheet2!A:A<>"x")*Sheet2!B1:${label(0, 129)})`,
                A2: '=SUM((Sheet2!A:A<>"x")*Sheet2!B1:R1)',
                A3: '=A2+A1',
            },
            s2: row,
        });
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(engine, 'A1')).toBe(CALC);
        expect(valueAt(engine, 'A3')).toBe(CALC);
        expect(valueAt(engine, 'A2')).toBe(160432128);
    });

    // A million stored elements, three million additions for cells that no array stores, and 63 million characters.
    const series = 'SUM(ROW(A1:A1048576))';
    const added = 'SUM({1,2,3}*(B1:B1048576=""))';
    const texts = 'SUM(LEN(Sheet2!A1:A2048&""))';
    const of = (count: number, part: string) => Array.from({ length: count }, () => part).join('+');

    test('arrays that each fit do not add up to the bound on one array', () => {
        expect(evaluate(`=${of(17, series)}`)).toBe((17 * (1048576 * 1048577)) / 2);
    });

    test('the bound on work is on all that one formula does, and what another formula did does not count', () => {
        const long: Record<string, Literal> = {};
        for (let i = 0; i < 2048; i += 1) long[label(i, 0)] = 'a'.repeat(31000);
        const engine = engineOf({
            s1: {
                A1: `=${of(3, texts)}`,
                A2: `=${of(2, texts)}`,
                A3: `=${of(2, texts)}`,
                A4: `=${of(2, texts)}+${of(3, added)}`,
                A5: `=${of(2, texts)}+${added}`,
            },
            s2: long,
        });
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(engine, 'A1')).toBe(CALC);
        expect(valueAt(engine, 'A2')).toBe(2 * 2048 * 31000);
        expect(valueAt(engine, 'A3')).toBe(2 * 2048 * 31000);
        expect(valueAt(engine, 'A4')).toBe(CALC);
        expect(valueAt(engine, 'A5')).toBe(2 * 2048 * 31000 + 6 * 1048576);
    });

    test('the work of one formula is 2^27, and one character more is #CALC!', () => {
        // Three arrays of 4,096 elements and 4,096 texts of 32,765 characters are 2^27.
        const cells: Record<string, Literal> = {};
        for (let i = 0; i < 4096; i += 1) cells[label(i, 0)] = 'a'.repeat(32765);
        const engine = engineOf({ s1: { A1: '=SUM(LEN(Sheet2!A1:A4096&""))' }, s2: cells });
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(4096 * 32765);
        engine.setValue('s2', 7, 0, 'a'.repeat(32766));
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(CALC);
    });

    test('a text that a call made for an element counts by its characters', () => {
        const engine = engineOf({
            s1: {
                A1: 'a'.repeat(20000),
                A2: '=SUM(LEN(ROW(B1:B7000)&A1))',
                A3: '=SUM(LEN(ROW(B1:B700)&A1))',
                A4: '=SUM(LEN(UPPER(IF(ROW(B1:B7000),A1))))',
                A5: '=SUM(LEN(IF(ROW(B1:B7000),A1)))',
                A6: '=SUM(LEN(VLOOKUP(ROW(B1:B7000)*0+1,C1:D1,2,FALSE)))',
                C1: 1,
                D1: 'b'.repeat(20000),
            },
        });
        expect(engine.recalc(ALL)).toEqual({ loops: [], stopped: false });
        expect(valueAt(engine, 'A2')).toBe(CALC);
        expect(valueAt(engine, 'A3')).toBe(700 * 20000 + 9 + 90 * 2 + 601 * 3);
        expect(valueAt(engine, 'A4')).toBe(CALC);
        // One text that every element picked is stored once, and so is one that a lookup found for every element.
        expect(valueAt(engine, 'A5')).toBe(7000 * 20000);
        expect(valueAt(engine, 'A6')).toBe(7000 * 20000);
    });

    test('five criteria down a million filled rows, multiplied', () => {
        const formula =
            '=SUMPRODUCT((Sheet2!A:A=1)*(Sheet2!B:B=1)*(Sheet2!C:C=1)*(Sheet2!D:D=1)*(Sheet2!E:E=1)*Sheet2!F:F)';
        const engine = new Engine([
            { id: 's1', name: 'Sheet1', cells: (cell) => cell(0, 0, null, stored(formula, 'A1')) },
            {
                id: 's2',
                name: 'Sheet2',
                cells: (cell) => {
                    for (let c = 0; c < 6; c += 1) for (let r = 0; r < 1048576; r += 1) cell(r, c, 1, null);
                },
            },
        ]);
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(1048576);
    });

    test('100,000 texts of 175 characters are made upper case', () => {
        const cells: Record<string, Literal> = {};
        for (let i = 0; i < 100000; i += 1) cells[label(i, 0)] = 'a'.repeat(175);
        const engine = engineOf({
            s1: {
                A1: '=SUMPRODUCT(--(UPPER(Sheet2!A1:A100000)="X"))',
                A2: '=SUM(LEN(UPPER(Sheet2!A1:A100000)))',
            },
            s2: cells,
        });
        engine.recalc(ALL);
        expect(valueAt(engine, 'A1')).toBe(0);
        expect(valueAt(engine, 'A2')).toBe(17500000);
    });
});

describe('a value is the same on a fresh load as after any history', () => {
    const FORMULAS = [
        '=SUM(--(Sheet2!A1:XFD1048576=""))',
        '=SUM((Sheet2!A:C="")*0.1)',
        '=SUM(Sheet2!A1:C3+Sheet2!D:F)',
        '=SUM(IFERROR(Sheet2!A1:C3+Sheet2!D:F,0))',
        '=Sheet2!A1:C3+Sheet2!D:F',
        '=SUMPRODUCT(Sheet2!A:A,Sheet2!B:B)',
        '=SUMPRODUCT(--(Sheet2!A:B<>""),Sheet2!C:D+1)',
        '=COUNT(Sheet2!1:1*1)',
        '=COUNTA(Sheet2!A:XFD&"")',
        '=XMATCH(3,Sheet2!C:C*1,0,-1)',
        '=MATCH(1,--(Sheet2!A:A=""),0)',
        '=AVERAGE(Sheet2!B:D*0.3)',
        '=SUM(INDEX(Sheet2!A:F*0.1,1048576,0))',
        '=MAX(Sheet2!XFA:XFD*2)',
    ];
    const ROWS = [0, 1, 2, 3, 500, 1048574, 1048575];
    const COLUMNS = [0, 1, 2, 3, 4, 5, 16382, 16383];

    function random(seed: number): () => number {
        let state = seed;
        return () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 2 ** 32;
        };
    }

    function answers(engine: Engine): unknown[] {
        engine.recalc(ALL);
        return FORMULAS.map((_, i) => engine.valueOf('s1', i, 0));
    }

    test('random sparse sheets with cells in the last row and the last column', () => {
        const formulas = Object.fromEntries(FORMULAS.map((formula, i) => [`A${i + 1}`, formula]));
        for (let seed = 1; seed <= 8; seed += 1) {
            const next = random(seed);
            const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
            const final = new Map<string, Literal>();
            const edited = engineOf({ s1: formulas, s2: {} });
            const reported: [number, number][] = [];
            for (let step = 0; step < 40; step += 1) {
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                if (next() < 0.3) {
                    edited.clear('s2', row, column);
                    final.delete(label(row, column));
                    reported.push([row, column]);
                } else {
                    const value = pick<Literal>([1, 2, 3, 0.1, -0.3, 'x', '', true, NA]);
                    edited.setValue('s2', row, column, value);
                    final.set(label(row, column), value);
                }
                if (next() < 0.08) edited.recalc(next() < 0.5 ? 3 : ALL);
            }
            const fresh = engineOf({ s1: formulas, s2: Object.fromEntries(final) });
            const withBlanks = new Engine([
                {
                    id: 's1',
                    name: 'Sheet1',
                    cells: (cell) => {
                        FORMULAS.forEach((f, i) => {
                            cell(i, 0, null, stored(f, `A${i + 1}`));
                        });
                    },
                },
                {
                    id: 's2',
                    name: 'Sheet2',
                    cells: (cell) => {
                        for (const [row, column] of reported)
                            if (!final.has(label(row, column))) cell(row, column, null, null);
                        for (const [name, value] of final) cell(...at(name), value, null);
                    },
                },
            ]);
            const expected = answers(fresh);
            expect(answers(edited)).toEqual(expected);
            expect(answers(withBlanks)).toEqual(expected);
        }
    }, 60000);
});
