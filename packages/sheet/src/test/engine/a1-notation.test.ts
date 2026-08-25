import { describe, expect, test } from 'bun:test';
import {
    columnIndexToLabel,
    columnLabelToIndex,
    parseA1Range,
    rowIndexToLabel,
    rowLabelToIndex,
    toA1,
} from '../../engine/a1-notation';

describe('engine/a1-notation — columnLabelToIndex', () => {
    test('A → 0', () => expect(columnLabelToIndex('A')).toBe(0));
    test('Z → 25', () => expect(columnLabelToIndex('Z')).toBe(25));
    test('AA → 26', () => expect(columnLabelToIndex('AA')).toBe(26));
    test('AZ → 51', () => expect(columnLabelToIndex('AZ')).toBe(51));
    test('BA → 52', () => expect(columnLabelToIndex('BA')).toBe(52));
    test('case-insensitive: a → 0', () => expect(columnLabelToIndex('a')).toBe(0));
    test('case-insensitive: aa → 26', () => expect(columnLabelToIndex('aa')).toBe(26));
    test('empty string → -1', () => expect(columnLabelToIndex('')).toBe(-1));
});

describe('engine/a1-notation — columnIndexToLabel', () => {
    test('0 → A', () => expect(columnIndexToLabel(0)).toBe('A'));
    test('25 → Z', () => expect(columnIndexToLabel(25)).toBe('Z'));
    test('26 → AA', () => expect(columnIndexToLabel(26)).toBe('AA'));
    test('51 → AZ', () => expect(columnIndexToLabel(51)).toBe('AZ'));
    test('52 → BA', () => expect(columnIndexToLabel(52)).toBe('BA'));
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
