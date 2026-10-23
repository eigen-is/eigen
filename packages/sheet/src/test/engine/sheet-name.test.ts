import { describe, expect, test } from 'bun:test';
import { copySheetName } from '../../engine/sheet-name';

describe('engine/sheet-name — copySheetName', () => {
    test('the first copy is "(Copy)", the next one numbered past the highest taken', () => {
        expect(copySheetName('Sheet1', ['Sheet1'])).toBe('Sheet1(Copy)');
        expect(copySheetName('Sheet1', ['Sheet1', 'Sheet1(Copy)'])).toBe('Sheet1(Copy2)');
        expect(copySheetName('Sheet1', ['Sheet1', 'Sheet1(Copy)', 'Sheet1(Copy4)'])).toBe('Sheet1(Copy5)');
    });

    test('a copy of a copy counts from the name it copies', () => {
        expect(copySheetName('Sheet1(Copy)', ['Sheet1', 'Sheet1(Copy)'])).toBe('Sheet1(Copy2)');
    });

    test('a long name is cut so the copy keeps within 31 characters', () => {
        const copy = copySheetName('A name of exactly thirty-one ch', ['A name of exactly thirty-one ch']);
        expect(copy).toBe('A name of exactly thirty…(Copy)');
        expect(copy).toHaveLength(31);
    });
});
