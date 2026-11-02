import { describe, expect, test } from 'bun:test';
import { findSheetByName, sheetNameKey } from '../../engine/a1-notation';
import { copySheetName } from '../../engine/sheet-name';

describe('engine/sheet-name — copySheetName', () => {
    test('the first copy is "(Copy)", the next one numbered past the highest taken', () => {
        expect(copySheetName('Sheet1', ['Sheet1'])).toBe('Sheet1(Copy)');
        expect(copySheetName('Sheet1', ['Sheet1', 'Sheet1(Copy)'])).toBe('Sheet1(Copy2)');
        expect(copySheetName('Sheet1', ['Sheet1', 'Sheet1(Copy)', 'Sheet1(Copy4)'])).toBe('Sheet1(Copy5)');
    });

    test('a name taken in another case is taken, as Excel compares names', () => {
        expect(copySheetName('Sheet1', ['sheet1', 'SHEET1(copy)'])).toBe('Sheet1(Copy2)');
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

describe('engine/sheet-name — sheetNameKey', () => {
    test('a Greek name matches in any case, its final sigma too', () => {
        expect(sheetNameKey('ΟΔΟΣ')).toBe(sheetNameKey('οδοσ'));
        expect(sheetNameKey('ΟΔΟΣ')).toBe(sheetNameKey('οδος'));
    });

    test('ß matches no ss, as no character folds to two', () => {
        expect(sheetNameKey('Straße')).not.toBe(sheetNameKey('STRASSE'));
        expect(sheetNameKey('Straße')).toBe(sheetNameKey('STRAßE'));
    });
});

describe('engine/sheet-name — findSheetByName', () => {
    const sheets = [{ name: 'Data' }, { name: 'data' }];

    test('a name finds the sheet of exactly that name before one in another case', () => {
        expect(findSheetByName(sheets, 'data')).toBe(sheets[1]);
        expect(findSheetByName(sheets, 'Data')).toBe(sheets[0]);
        expect(findSheetByName(sheets, 'DATA')).toBe(sheets[0]);
        expect(findSheetByName(sheets, 'Other')).toBeUndefined();
    });
});
