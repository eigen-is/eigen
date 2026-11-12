import { describe, expect, test } from 'bun:test';
import { ENGINE, fn, REFERENCE } from '../../functions/registry';
import { CALC, DIV0, NA, NULL, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, stored, valueAt, valuesWith } from '../recalc/support';

// The fixture of Excel batch 9: A1:A5 = 1.5, -2.5, 0, 10, 1E+300, B1 blank, B2 the text 3, B3 TRUE, B4 =1/0, B5 the
// text abc, B6 ="", B7 =NA(), C1:C3 = 2, 4, 6, D1:D4 = k1 to k4, E1:E4 = 10 to 40.
const F9: Cells = {
    ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300 },
    ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""', B7: '=NA()', C1: 2, C2: 4, C3: 6 },
    ...{ D1: 'k1', D2: 'k2', D3: 'k3', D4: 'k4', E1: 10, E2: 20, E3: 30, E4: 40 },
};

// The answers of a formula that gives an array, row by row.
function elements(formula: string, rows: number, columns: number, cells: Cells = F9) {
    const found: unknown[] = [];
    for (let r = 1; r <= rows; r += 1) {
        for (let c = 1; c <= columns; c += 1) found.push(evaluate(`=INDEX(${formula.slice(1)},${r},${c})`, cells));
    }
    return found;
}

describe('whether a cell holds a formula, and its text: ISFORMULA, FORMULATEXT', () => {
    test.each([
        ['=ISFORMULA(B1)', false],
        ['=ISFORMULA(B2)', false],
        ['=ISFORMULA(B4)', true],
        ['=ISFORMULA(B6)', true],
        ['=ISFORMULA(B7)', true],
        ['=ISFORMULA((B4,A1))', true],
        ['=ISFORMULA(INDEX(B1:B7,4))', true],
        ['=ISFORMULA(OFFSET(B4,0,0))', true],
        ['=ISFORMULA(INDIRECT("B4"))', true],
        ['=ISFORMULA(IF(TRUE,B1))', false],
        ['=ISFORMULA(Sheet2!D3)', false],
        // Excel refuses these when the formula is entered: here they are the argument's own error, or #VALUE!.
        ['=ISFORMULA(1)', VALUE],
        ['=ISFORMULA(1/0)', DIV0],
        ['=FORMULATEXT(B1)', NA],
        ['=FORMULATEXT(B3)', NA],
        ['=FORMULATEXT(B4)', '=1/0'],
        ['=FORMULATEXT(B6)', '=""'],
        ['=FORMULATEXT(B7)', '=NA()'],
        ['=FORMULATEXT((B4,A1))', '=1/0'],
        ['=FORMULATEXT(INDIRECT("B4"))', '=1/0'],
        ['=FORMULATEXT(IF(TRUE,B4))', '=1/0'],
        ['=FORMULATEXT(B4:B5 B5:B6)', NA],
        ['=FORMULATEXT(N1)', '=FORMULATEXT(N1)'],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });

    test('a range is one answer per cell, and of a union the first area', () => {
        expect(elements('=ISFORMULA(B1:B7)', 7, 1)).toEqual([false, false, false, true, false, true, true]);
        expect(elements('=ISFORMULA(D1:E4)', 4, 2)).toEqual(Array.from({ length: 8 }, () => false));
        expect(elements('=ISFORMULA((A1:A2,B4))', 2, 1)).toEqual([false, false]);
        expect(elements('=FORMULATEXT(B4:B6)', 3, 1)).toEqual(['=1/0', NA, '=""']);
        expect(evaluate('=SUM(--ISFORMULA(B1:B7))', F9)).toBe(3);
        expect(evaluate('=COUNTA(ISFORMULA(A:A))', F9)).toBe(1048576);
    });

    // A range costs the cells it holds and not its extent: a stretch that holds nothing is asked once. The whole
    // grid is 17 thousand million cells, far past what one formula may make, and holds 21 here.
    test('a range of any extent is as many calls as its rows and columns that hold a cell', () => {
        expect(evaluate('=ROWS(ISFORMULA(A1:XFD1048576))', F9)).toBe(1048576);
        expect(evaluate('=COLUMNS(FORMULATEXT(A1:XFD1048576))', F9)).toBe(16384);
        expect(evaluate('=SUM(--ISFORMULA(A1:XFD1048576))', F9, 'A10')).toBe(4);
        expect(evaluate('=SUM(--ISFORMULA(1:1048576))', { ...F9, XFD1048576: '=1' }, 'A10')).toBe(5);
        expect(evaluate('=COUNTA(FORMULATEXT(A:M))-SUM(--ISNA(FORMULATEXT(A:M)))', F9)).toBe(3);
        const far = { ...F9, B1048576: '=B4', K7: '=K8' };
        expect(elements('=INDEX(FORMULATEXT(B:K),{1048575;1048576},{1,2,10})', 2, 3, far)).toEqual([
            NA,
            NA,
            NA,
            '=B4',
            NA,
            NA,
        ]);
        expect(evaluate('=INDEX(FORMULATEXT(B:K),7,10)', far)).toBe('=K8');
        expect(evaluate('=INDEX(ISFORMULA(B:K),7,9)', far)).toBe(false);
        expect(evaluate('=INDEX(ISFORMULA(B:K),8,10)', far)).toBe(false);
    });

    test('the text is the formula as it reads at its own cell, names of sheets and all', () => {
        const cells = { ...F9, G5: '=SUM(A1:A$3)+Sheet2!D3*$C2', G6: '=sum(a1,2)' };
        expect(evaluate('=FORMULATEXT(G5)', cells)).toBe('=SUM(A1:A$3)+Sheet2!D3*$C2');
        expect(evaluate('=FORMULATEXT(G6)', cells)).toBe('=SUM(A1,2)');
    });
});

describe('a reference read from a text: INDIRECT', () => {
    test.each([
        ['=INDIRECT("A1")', 1.5],
        ['=INDIRECT("A1",TRUE)', 1.5],
        ['=INDIRECT("A1",12.5)', 1.5],
        ['=INDIRECT("A1","TRUE")', 1.5],
        ['=INDIRECT("a1")', 1.5],
        ['=INDIRECT("$A$1")', 1.5],
        ['=INDIRECT("A$1")', 1.5],
        ['=INDIRECT("A1 ")', 1.5],
        ['=INDIRECT("C1")', 2],
        ['=INDIRECT("Sheet2!D3")', 300],
        ['=INDIRECT("\'Sheet2\'!D3")', 300],
        ['=SUM(INDIRECT("C1:C3"))', 12],
        ['=SUM(INDIRECT("C3:A1"))', 11],
        ['=SUM(INDIRECT("A1"):INDIRECT("C3"))', 11],
        ['=SUM(INDIRECT({"A1","C1"}))', 3.5],
        ['=COUNT(INDIRECT("A:A"))', 5],
        ['=COUNT(INDIRECT("A:C"))', 8],
        ['=ISREF(INDIRECT("A1"))', true],
        ['=ROW(INDIRECT("A1048576"))', 1048576],
        ['=COLUMN(INDIRECT("XFD1"))', 16384],
        // A text that is no reference is #REF!, whatever it is.
        ['=INDIRECT("3")', REF],
        ['=INDIRECT("abc")', REF],
        ['=INDIRECT(TRUE)', REF],
        ['=INDIRECT(B1)', REF],
        ['=INDIRECT(12.5)', REF],
        ['=INDIRECT("")', REF],
        ['=INDIRECT(" ")', REF],
        ['=INDIRECT(" A1")', REF],
        ['=INDIRECT("A 1")', REF],
        ['=INDIRECT("A1048577")', REF],
        ['=INDIRECT("XFE1")', REF],
        ['=INDIRECT("A0")', REF],
        ['=INDIRECT("A1:")', REF],
        ['=INDIRECT("A1:A2:A3")', REF],
        ['=INDIRECT("A1:A2 A2:A3")', REF],
        ['=INDIRECT("A1,C1")', REF],
        ['=INDIRECT("(A1,C1)")', REF],
        ['=INDIRECT("#REF!")', REF],
        ['=INDIRECT("A1+1")', REF],
        ['=INDIRECT("SUM(A1)")', REF],
        ['=INDIRECT("{1,2}")', REF],
        ['=INDIRECT("Sheet2!")', REF],
        ['=INDIRECT("Sheet2!zzz")', REF],
        ['=INDIRECT("foo")', REF],
        ['=INDIRECT("R2C3")', REF],
        ['=INDIRECT(INDIRECT("A1"))', REF],
        ['=INDIRECT(B4)', DIV0],
        ['=INDIRECT(B7)', NA],
        ['=INDIRECT(B4,NA())', DIV0],
        ['=INDIRECT(NA(),B4)', NA],
        ['=INDIRECT("A1","abc")', VALUE],
        ['=INDIRECT("A1",B4)', DIV0],
        // The second argument FALSE, a blank or left empty reads the text as R1C1.
        ['=INDIRECT("A1",FALSE)', REF],
        ['=INDIRECT("A1",0)', REF],
        ['=INDIRECT("A1",)', REF],
        ['=INDIRECT("A1",B1)', REF],
        ['=INDIRECT("R1C1",TRUE)', REF],
        ['=INDIRECT("R1C1",FALSE)', 1.5],
        ['=INDIRECT("r2c3",FALSE)', 4],
        ['=INDIRECT("R1C1:R1C1",FALSE)', 1.5],
        ['=INDIRECT("Sheet2!R3C4",FALSE)', 300],
        ['=INDIRECT("\'Sheet2\'!R3C4",FALSE)', 300],
        ['=SUM(INDIRECT("R2C3:R4C4",FALSE))', 10],
        ['=SUM(INDIRECT("C3:C4",FALSE))', 12],
        ['=ROW(INDIRECT("R1048576C16384",FALSE))', 1048576],
        ['=INDIRECT("R1048577C1",FALSE)', REF],
        ['=INDIRECT("R1C16385",FALSE)', REF],
        ['=INDIRECT("R0C0",FALSE)', REF],
        ['=INDIRECT("nosuch!R1C1",FALSE)', REF],
        // Read from the formula's own cell, which is N1: one row down, one column back is M2.
        ['=ROW(INDIRECT("R[1]C[-1]",FALSE))+0', 2],
        ['=COLUMN(INDIRECT("R[1]C[-1]",FALSE))+0', 13],
        ['=COLUMN(INDIRECT("RC",FALSE))+0', 14],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });

    test('an array of texts is one reference per text', () => {
        expect(elements('=ROW(INDIRECT({"A1","B2"}))', 1, 2)).toEqual([1, 2]);
        expect(elements('=INDIRECT({"A1","zzz"})', 1, 2)).toEqual([1.5, REF]);
    });
});

describe('what a cell is: CELL, SHEET, SHEETS, INFO', () => {
    test.each([
        ['=CELL("address",B1)', '$B$1'],
        ['=CELL("address",B4)', '$B$4'],
        ['=CELL("ADDRESS",A1)', '$A$1'],
        ['=CELL("address",D1:E4)', '$D$1'],
        ['=CELL("address",C:C)', '$C$1'],
        ['=CELL("address",(A1:A2,C1:C2))', '$A$1, $C$1:$C$2'],
        ['=CELL("address",INDIRECT("C3"))', '$C$3'],
        ['=CELL("address",OFFSET(A1,2,2))', '$C$3'],
        ['=CELL("address",OFFSET(A1,-1,0))', REF],
        ['=CELL("address",INDEX(A1:C3,0,2))', '$B$1'],
        ['=CELL("col",D1)', 4],
        ['=CELL("col",C1:C3)', 3],
        ['=CELL("row",B6)', 6],
        ['=CELL("row",3:3)', 3],
        ['=CELL("row",(A1:A2,C1:C2))', 1],
        ['=CELL("contents",A1)', 1.5],
        ['=CELL("contents",D1)', 'k1'],
        ['=CELL("contents",B4)', DIV0],
        ['=CELL("contents",B6)', ''],
        ['=CELL("contents",B2)', '3'],
        ['=CELL("contents",B3)', true],
        ['=CELL("contents",A1:B2)', 1.5],
        ['=CELL("type",A1)', 'v'],
        ['=CELL("type",D1)', 'l'],
        ['=CELL("type",B1)', 'b'],
        ['=CELL("type",B4)', 'v'],
        ['=CELL("type",B6)', 'l'],
        ['=CELL("type",B3)', 'v'],
        ['=CELL("type",B1:B3)', 'b'],
        // What only a host knows, and what is no type at all: #VALUE!, as Excel on the web answers.
        ['=CELL("filename",A1)', VALUE],
        ['=CELL("format",A1)', VALUE],
        ['=CELL("width",A1)', VALUE],
        ['=CELL("prefix",A1)', VALUE],
        ['=CELL("protect",A1)', VALUE],
        ['=CELL("color",A1)', VALUE],
        ['=CELL("parentheses",A1)', VALUE],
        ['=CELL("foo",A1)', VALUE],
        ['=CELL(" address",A1)', VALUE],
        ['=CELL("",A1)', VALUE],
        ['=CELL(,A1)', VALUE],
        ['=CELL(1,A1)', VALUE],
        ['=CELL(B4,A1)', DIV0],
        ['=CELL(NA(),B4)', NA],
        ['=CELL("address",A1:A3 B2:C2)', NULL],
        ['=SHEET()', 1],
        ['=SHEET(B4)', 1],
        ['=SHEET(A:A)', 1],
        ['=SHEET((A1:A2,C1:C2))', 1],
        ['=SHEET(Sheet2!A1)', 2],
        ['=SHEET(INDIRECT("Sheet2!A1"))', 2],
        ['=SHEET(1/0)', DIV0],
        ['=SHEETS()', 2],
        ['=SHEETS(B4)', 1],
        ['=SHEETS((A1:A2,C1:C2))', 1],
        ['=SHEETS(Sheet2!A1)', 1],
        ['=SHEETS(1/0)', DIV0],
        // Excel's 24 rows: what is no reference is #N/A to these two, where it is #VALUE! to ROW.
        ['=SHEETS(1)', NA],
        ['=SHEETS("abc")', NA],
        ['=SHEETS(TRUE)', NA],
        ['=SHEETS({1,2})', NA],
        ['=SHEET("3")', NA],
        ['=SHEET(12.5)', NA],
        ['=SHEET({1,2})', NA],
        ['=SHEET(NA())', NA],
        ['=ROW(12.5)', VALUE],
        ['=INFO("system")', VALUE],
        ['=INFO("osversion")', VALUE],
        ['=INFO(1)', VALUE],
        ['=INFO(B4)', DIV0],
        ['=INFO(B7)', NA],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });

    test('a cell of another sheet has that sheet in its address, and an array of types is one answer each', () => {
        expect(evaluate('=CELL("address",Sheet2!B2:C3)', F9)).toBe('Sheet2!$B$2');
        expect(elements('=CELL({"row","col"},B4:C5)', 1, 2)).toEqual([4, 2]);
    });

    // Excel answers for the cell that was changed last, which only a host knows. Excel check.
    test('with no reference it is the cell the formula is in', () => {
        expect(evaluate('=CELL("address")', F9, 'Q7')).toBe('$Q$7');
        expect(evaluate('=CELL("row")', F9, 'Q7')).toBe(7);
    });
});

// A book belongs to the call that was handed it: what it is asked about is that call's cell, whatever other
// formula is computed while the body runs, and its formula's cell is the one that is running.
describe('a book answers about the cell of its own call', () => {
    // A row no function of this build is: it asks for the value first, which computes a formula that asks a book.
    const VF = fn('VF', [REFERENCE, ENGINE], (_at, book) => `${String(book.value())}|${book.formula()}`);

    test('after a value was computed whose formula asks a book too', () => {
        const cells = { A1: '=VF(N1)', N1: '=ISFORMULA(B1)', B1: 7, A2: '=VF(N2)', N2: '=CELL("address",B1)' };
        expect(valuesWith([VF], cells, ['A1', 'A2'])).toEqual(['false|=ISFORMULA(B1)', '$B$1|=CELL("address",B1)']);
    });

    test('two formulas in different cells each read a text from their own cell', () => {
        const cells = { A2: 1, C4: 2, A3: '=INDIRECT("R[-1]C",FALSE)', C5: '=INDIRECT("R[-1]C",FALSE)' };
        const engine = engineOf({ s1: { ...cells, E1: '=CELL("address")', F2: '=CELL("address")' } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(['A3', 'C5', 'E1', 'F2'].map((host) => valueAt(engine, host))).toEqual([1, 2, '$E$1', '$F$2']);
    });

    test('another sheet is another than the sheet of the formula, not than the first sheet', () => {
        const s2 = { A1: '=CELL("address",B2)', A2: '=CELL("address",Sheet1!B2)', A3: '=CELL("address",Sheet2!B2)' };
        const engine = engineOf({ s1: { A1: '=CELL("address",Sheet2!B2)' }, s2 });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(['A1', 'A2', 'A3'].map((host) => valueAt(engine, host, 's2'))).toEqual(['$B$2', 'Sheet1!$B$2', '$B$2']);
        expect(valueAt(engine, 'A1')).toBe('Sheet2!$B$2');
    });
});

// Excel's rows of INDIRECT and OFFSET: an array of references is no value a cell can hold.
describe('an array of references that reaches the cell is #CALC!', () => {
    test.each([
        ['=INDIRECT({"A1","B2"})', CALC],
        ['=INDIRECT({"A1";"A2"})', CALC],
        ['=INDIRECT({"A1","zzz"})', CALC],
        ['=INDIRECT("A1",{TRUE,FALSE})', CALC],
        ['=OFFSET(A1,{0,1,2},0)', CALC],
        ['=OFFSET(A1,0,0,{1,2},1)', CALC],
        // What takes the references still does.
        ['=SUM(INDIRECT({"A1","C1"}))', 3.5],
        ['=SUM(OFFSET(A1,{0;1;2},0))', -1],
        ['=INDEX(ROW(OFFSET(A1,{0;1;2},0)),3,1)', 3],
        ['=INDIRECT({"A1"})', 1.5],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F9)).toBe(expected);
    });
});

// A formula cannot read its own cell, so with no reference there is nothing to read: Excel answers for the cell
// that was changed last, which only a host knows.
describe('CELL with no reference reads no cell', () => {
    test('the contents are a blank and the type is b, and the cell is on no loop', () => {
        const engine = engineOf({ s1: { A1: '=CELL("contents")', A2: '=CELL("type")', A3: '=CELL("contents",A3)' } });
        const { loops } = engine.recalc(Number.POSITIVE_INFINITY);
        expect(['A1', 'A2', 'A3'].map((host) => valueAt(engine, host))).toEqual([0, 'b', REF]);
        expect(loops).toEqual([{ sheet: 's1', row: 2, column: 0 }]);
    });
});

// A name before the ! is read by one rule in both notations: what the grammar reads as one bare word, or quoted.
describe('INDIRECT reads the name of a sheet the same way in A1 and in R1C1', () => {
    test.each([
        ['=INDIRECT("My Sheet!A1")', REF],
        ['=INDIRECT("My Sheet!R1C1",FALSE)', REF],
        [`=INDIRECT("'My Sheet'!A1")`, 7],
        [`=INDIRECT("'My Sheet'!R1C1",FALSE)`, 7],
        ['=INDIRECT("Sheet1!R1C1",FALSE)', 1],
        [`=INDIRECT("'Sheet1'!R1C1",FALSE)`, 1],
    ])('%s', (formula, expected) => {
        const engine = engineOf({ s1: { A1: 1, N1: formula }, 'My Sheet': { A1: 7 } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'N1')).toBe(expected);
    });
});

// What these read is no value of a cell they name, so a write that changes it has to reach them some other way.
describe('a formula that asks the book answers anew when what it asked about changes', () => {
    const cells: Cells = {
        ...{ A1: 1, A2: '=A1+1', A5: 7, B1: '=FORMULATEXT(A2)', B2: '=ISFORMULA(A1)', B3: '=INDIRECT("A"&A1)' },
        ...{ B4: '=CELL("contents",A5)', B5: '=SHEETS()', B6: '=SHEET(Sheet2!A1)', B7: '=FORMULATEXT(A6)' },
        ...{ A6: '=A5*2', B8: '=CELL("address",A5)' },
    };
    const hosts = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
    // The values after the edits, and the values of a workbook loaded as the edited one now stands.
    function both(edit: (engine: ReturnType<typeof engineOf>) => void, loaded: Readonly<Record<string, Cells>>) {
        const engine = engineOf({ s1: cells, s2: { A1: 5 } });
        engine.recalc(Number.POSITIVE_INFINITY);
        edit(engine);
        engine.recalc(Number.POSITIVE_INFINITY);
        const fresh = engineOf(loaded);
        fresh.recalc(Number.POSITIVE_INFINITY);
        return [hosts.map((host) => valueAt(engine, host)), hosts.map((host) => valueAt(fresh, host))];
    }

    test('before any write', () => {
        const [values] = both(() => undefined, { s1: cells, s2: { A1: 5 } });
        expect(values).toEqual(['=A1+1', false, 1, 7, 2, 2, '=A5*2', '$A$5']);
    });

    test('a formula written over the one it reads the text of, and over a value', () => {
        const [edited, fresh] = both(
            (engine) => {
                engine.setFormula('s1', 1, 0, stored('=A1+1+0', 'A2'));
                engine.setFormula('s1', 0, 0, stored('=5-4', 'A1'));
            },
            { s1: { ...cells, A2: '=A1+1+0', A1: '=5-4' }, s2: { A1: 5 } },
        );
        expect(edited).toEqual(fresh);
        expect(edited.slice(0, 3)).toEqual(['=A1+1+0', true, 1]);
    });

    test('a value written where a text points, and a formula cleared', () => {
        const [edited, fresh] = both(
            (engine) => {
                engine.setValue('s1', 0, 0, 5);
                engine.clear('s1', 1, 0);
            },
            { s1: { ...cells, A1: 5, A2: 0 }, s2: { A1: 5 } },
        );
        expect(edited.slice(2)).toEqual(fresh.slice(2));
        expect(edited.slice(0, 3)).toEqual([NA, false, 7]);
    });

    test('a row inserted above what a formula names changes its text and no value', () => {
        const [edited] = both(
            (engine) => {
                engine.editLines({ sheet: 's1', rows: true, index: 3, insert: true, count: 1 });
            },
            { s1: cells, s2: { A1: 5 } },
        );
        // B7 moved to B8 and reads A7, whose formula now names A6.
        const engine = engineOf({ s1: cells, s2: { A1: 5 } });
        engine.recalc(Number.POSITIVE_INFINITY);
        engine.editLines({ sheet: 's1', rows: true, index: 3, insert: true, count: 1 });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'B8')).toBe('=A6*2');
        expect(valueAt(engine, 'B9')).toBe('$A$6');
        expect(edited[0]).toBe('=A1+1');
    });

    test('a sheet added, moved and removed', () => {
        const engine = engineOf({ s1: cells, s2: { A1: 5 } });
        engine.recalc(Number.POSITIVE_INFINITY);
        engine.addSheet({ id: 's3', name: 'Third', cells: () => undefined }, 0);
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'B5'), valueAt(engine, 'B6')]).toEqual([3, 3]);
        engine.moveSheet('s2', 0);
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'B5'), valueAt(engine, 'B6')]).toEqual([3, 1]);
        engine.removeSheet('s3');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'B5'), valueAt(engine, 'B6')]).toEqual([2, 1]);
    });
});
