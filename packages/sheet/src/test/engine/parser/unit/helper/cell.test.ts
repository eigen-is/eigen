import { describe, expect, test } from 'bun:test';
import { extractLabel, rowIndexToLabel, rowLabelToIndex, toLabel } from '../../../../../engine/parser/helper/cell';

describe('sheet/formula-parser/helper/cell', () => {
    describe('.extractLabel()', () => {
        test('should correctly extract coordinates', () => {
            const result = extractLabel('A1');
            expect(result).not.toBeNull();
            expect(Array.isArray(result)).toBe(true);
            expect(result!.length).toBeGreaterThan(0);
        });
    });

    describe('.toLabel()', () => {
        test('should correctly create cell labels', () => {
            expect(
                toLabel({ index: 0, label: '1', isAbsolute: false }, { index: 0, label: 'A', isAbsolute: false }),
            ).toBe('A1');
            expect(
                toLabel({ index: 9, label: '10', isAbsolute: false }, { index: 1, label: 'B', isAbsolute: false }),
            ).toBe('B10');
            expect(
                toLabel({ index: 0, label: '1', isAbsolute: true }, { index: 0, label: 'A', isAbsolute: true }),
            ).toBe('$A$1');
        });
    });

    describe('.rowIndexToLabel()', () => {
        test('should convert row index to label', () => {
            expect(rowIndexToLabel(0)).toBe('1');
            expect(rowIndexToLabel(9)).toBe('10');
            expect(rowIndexToLabel(99)).toBe('100');
        });
    });

    describe('.rowLabelToIndex()', () => {
        test('should convert row label to index', () => {
            expect(rowLabelToIndex('1')).toBe(0);
            expect(rowLabelToIndex('10')).toBe(9);
            expect(rowLabelToIndex('100')).toBe(99);
        });
    });
});
