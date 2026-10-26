import { describe, expect, test } from 'bun:test';
import { columnIndexToLabel, columnLabelToIndex } from '../../sheets/labels';

describe('sheets/labels — columnLabelToIndex', () => {
    test('A → 0', () => expect(columnLabelToIndex('A')).toBe(0));
    test('Z → 25', () => expect(columnLabelToIndex('Z')).toBe(25));
    test('AA → 26', () => expect(columnLabelToIndex('AA')).toBe(26));
    test('AZ → 51', () => expect(columnLabelToIndex('AZ')).toBe(51));
    test('BA → 52', () => expect(columnLabelToIndex('BA')).toBe(52));
    test('case-insensitive: a → 0', () => expect(columnLabelToIndex('a')).toBe(0));
    test('case-insensitive: aa → 26', () => expect(columnLabelToIndex('aa')).toBe(26));
    test('empty string → -1', () => expect(columnLabelToIndex('')).toBe(-1));
});

describe('sheets/labels — columnIndexToLabel', () => {
    test('0 → A', () => expect(columnIndexToLabel(0)).toBe('A'));
    test('25 → Z', () => expect(columnIndexToLabel(25)).toBe('Z'));
    test('26 → AA', () => expect(columnIndexToLabel(26)).toBe('AA'));
    test('51 → AZ', () => expect(columnIndexToLabel(51)).toBe('AZ'));
    test('52 → BA', () => expect(columnIndexToLabel(52)).toBe('BA'));
});
