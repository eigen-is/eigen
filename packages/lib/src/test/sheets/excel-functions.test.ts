import { describe, expect, test } from 'bun:test';
import { EXCEL_FUTURE_FUNCTIONS, isExcelFunction } from '../../sheets/excel-functions';

describe('sheets/excel-functions', () => {
    test('a function Excel added after 2007 is an Excel function, and one it had before is not a future one', () => {
        for (const name of EXCEL_FUTURE_FUNCTIONS) expect(isExcelFunction(name)).toBe(true);
        expect(EXCEL_FUTURE_FUNCTIONS.has('XLOOKUP')).toBe(true);
        expect(EXCEL_FUTURE_FUNCTIONS.has('SUM')).toBe(false);
        expect(EXCEL_FUTURE_FUNCTIONS.has('INDIRECT')).toBe(false);
    });

    test("Excel's classics, the ones the engine lacks too, in any case and with a file's prefixes", () => {
        for (const name of ['SUM', 'vlookup', 'INDIRECT', 'OFFSET', 'GETPIVOTDATA', 'ERROR.TYPE', '_xlfn.LET']) {
            expect(isExcelFunction(name)).toBe(true);
        }
        expect(isExcelFunction('_xlfn._xlws.FILTER')).toBe(true);
    });

    test("a typo, or a function only Google Sheets or formulajs registers, is not Excel's", () => {
        for (const name of ['FILTRE', 'NOSUCH', 'SPLIT', 'ADD', 'CEILINGMATH', '_xlfn.FILTRE']) {
            expect(isExcelFunction(name)).toBe(false);
        }
    });
});
