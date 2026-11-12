import { describe, expect, test } from 'bun:test';
import { EXCEL_2007_FUNCTIONS } from '../../functions/excel-names';
import { FUNCTIONS } from '../../functions/library';
import { EXCEL_FUTURE_FUNCTIONS, isExcelFunction } from '../../names';

const EXCEL_NAMES = [...EXCEL_2007_FUNCTIONS, ...EXCEL_FUTURE_FUNCTIONS].sort();
const UNKNOWN_TO_EXCEL = [...FUNCTIONS.keys()].filter((name) => !isExcelFunction(name)).sort();
const LACKING = EXCEL_NAMES.filter((name) => !FUNCTIONS.has(name));

describe('functions/excel-names', () => {
    test('a function Excel added after 2007 is an Excel function, and one it had before is not a future one', () => {
        for (const name of EXCEL_FUTURE_FUNCTIONS) expect(isExcelFunction(name)).toBe(true);
        expect(EXCEL_FUTURE_FUNCTIONS.has('XLOOKUP')).toBe(true);
        expect(EXCEL_FUTURE_FUNCTIONS.has('SUM')).toBe(false);
        expect(EXCEL_FUTURE_FUNCTIONS.has('INDIRECT')).toBe(false);
    });

    test("Excel's classics, in any case and with a file's prefixes", () => {
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

describe(`the engine computes ${FUNCTIONS.size} of Excel's ${EXCEL_NAMES.length} functions and lacks ${LACKING.length}`, () => {
    test('every function the engine computes is one Excel knows, so a typo in a family file shows here', () => {
        expect(UNKNOWN_TO_EXCEL).toEqual([]);
    });

    test('the inventory splits into what the engine computes and what it lacks', () => {
        expect(FUNCTIONS.size + LACKING.length).toBe(EXCEL_NAMES.length);
    });
});
