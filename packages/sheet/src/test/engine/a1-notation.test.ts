import { describe, expect, test } from 'bun:test';
import {
    a1RangeRef,
    parseA1Range,
    rangeToA1,
    rowIndexToLabel,
    rowLabelToIndex,
    sheetRefName,
    toA1,
} from '../../engine/a1-notation';
import { renameSheetRefs } from '../../engine/formula-shift';

// Excel's own files quote every sheet named like a cell or starting with a digit: 93 and 961 refs in the xlsx corpus,
// none bare. The R1C1 forms and the booleans follow the same reading, and quotes are always legal.
describe('engine/a1-notation — sheetRefName', () => {
    test.each([
        'Q1',
        'q1',
        'AB12',
        'XFD1048576',
        'R1C1',
        'r1c1',
        'RC',
        'R',
        'C',
        'R2',
        'C3',
        'R2D2',
        'RC1',
        '2024',
        '1a',
    ])('%s reads as something else, so it is quoted', (name) => expect(sheetRefName(name)).toBe(`'${name}'`));
    test.each(['TRUE', 'false'])('%s reads as a boolean, so it is quoted', (name) => {
        expect(sheetRefName(name)).toBe(`'${name}'`);
    });
    test.each(['Sheet1', 'Data', 'Q1_2024', 'Übersicht', 'Rates', 'Costs', 'TRUE1X', '_1'])('%s stays bare', (name) => {
        expect(sheetRefName(name)).toBe(name);
    });
    test('a name with a space or a quote is quoted, its quotes doubled', () => {
        expect(sheetRefName('My Sheet')).toBe("'My Sheet'");
        expect(sheetRefName("It's")).toBe("'It''s'");
    });
    test('a rename to such a name reads back', () => {
        const findSheet = (name: string) => (name === 'One' ? { name } : undefined);
        for (const name of ['Q1', 'R1C1', '2024', 'TRUE']) {
            const renamed = renameSheetRefs('=One!A1+SUM(One!B1:B2)', findSheet, new Map([['One', name]]));
            expect(renamed).toBe(`='${name}'!A1+SUM('${name}'!B1:B2)`);
            expect(parseA1Range(`'${name}'!B2`)?.sheet).toBe(name);
        }
    });
});

describe('engine/a1-notation — rowLabelToIndex', () => {
    test('"1" → 0', () => expect(rowLabelToIndex('1')).toBe(0));
    test('"10" → 9', () => expect(rowLabelToIndex('10')).toBe(9));
    test('"100" → 99', () => expect(rowLabelToIndex('100')).toBe(99));
    test('invalid string → -1', () => expect(rowLabelToIndex('abc')).toBe(-1));
    test('empty string → -1', () => expect(rowLabelToIndex('')).toBe(-1));
});

describe('engine/a1-notation — rowIndexToLabel', () => {
    test('0 → "1"', () => expect(rowIndexToLabel(0)).toBe('1'));
    test('9 → "10"', () => expect(rowIndexToLabel(9)).toBe('10'));
    test('99 → "100"', () => expect(rowIndexToLabel(99)).toBe('100'));
    test('negative → ""', () => expect(rowIndexToLabel(-1)).toBe(''));
});

describe('engine/a1-notation — parseA1Range', () => {
    test('simple range A1:B3', () =>
        expect(parseA1Range('A1:B3')).toEqual({
            sheet: undefined,
            start: { col: 0, row: 0 },
            end: { col: 1, row: 2 },
        }));

    test('range with sheet name Sheet1!A1:B3', () =>
        expect(parseA1Range('Sheet1!A1:B3')).toEqual({
            sheet: 'Sheet1',
            start: { col: 0, row: 0 },
            end: { col: 1, row: 2 },
        }));

    test('single cell as range C5', () =>
        expect(parseA1Range('C5')).toEqual({
            sheet: undefined,
            start: { col: 2, row: 4 },
            end: { col: 2, row: 4 },
        }));

    test("quoted sheet name 'My Sheet'!A1:B2", () =>
        expect(parseA1Range("'My Sheet'!A1:B2")).toEqual({
            sheet: 'My Sheet',
            start: { col: 0, row: 0 },
            end: { col: 1, row: 1 },
        }));

    test('absolute refs in range $A$1:$B$3', () =>
        expect(parseA1Range('$A$1:$B$3')).toEqual({
            sheet: undefined,
            start: { col: 0, row: 0 },
            end: { col: 1, row: 2 },
        }));

    test('invalid range → null', () => expect(parseA1Range('notarange')).toBeNull());

    test('empty string → null', () => expect(parseA1Range('')).toBeNull());
});

describe('engine/a1-notation — toA1', () => {
    test('(0, 0) → A1', () => expect(toA1(0, 0)).toBe('A1'));
    test('(9, 26) → AA10', () => expect(toA1(9, 26)).toBe('AA10'));
    test('(2, 1) → B3', () => expect(toA1(2, 1)).toBe('B3'));
    test('(0, 25) → Z1', () => expect(toA1(0, 25)).toBe('Z1'));
});

describe('engine/a1-notation — rangeToA1', () => {
    test('a cell is its own ref, a rectangle its corners', () => {
        expect(rangeToA1({ row: [1, 1], column: [2, 2] })).toBe('C2');
        expect(rangeToA1({ row: [0, 9], column: [0, 27] })).toBe('A1:AB10');
    });
    test("absolute is Excel's $A$1 form", () => {
        expect(rangeToA1({ row: [1, 1], column: [2, 2] }, true)).toBe('$C$2');
        expect(rangeToA1({ row: [0, 1048575], column: [1, 1] }, true)).toBe('$B$1:$B$1048576');
    });
});

describe('engine/a1-notation — a1RangeRef', () => {
    const ref = (text: string) => {
        const range = parseA1Range(text);
        return range && a1RangeRef(range);
    };
    test('orders each pair, whichever corner comes first', () => {
        expect(ref('C5:A2')).toEqual({ row: [1, 4], column: [0, 2] });
        expect(ref('B3')).toEqual({ row: [2, 2], column: [1, 1] });
    });
    test("a range past Excel's grid is null", () => {
        expect(ref('A1:XFD1048576')).toEqual({ row: [0, 1048575], column: [0, 16383] });
        expect(ref('A1:A1048577')).toBeNull();
        expect(ref('A1:XFE1')).toBeNull();
    });
});
