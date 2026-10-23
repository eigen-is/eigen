import { describe, expect, test } from 'bun:test';
import { SHEET_DEFAULT_DIGIT_WIDTH } from '@workspace/lib/sheets';
import { DOTTED_FUNCTIONS } from '@workspace/sheet/engine';
import {
    columnWidthToPx,
    maxDigitWidth,
    pxToColumnWidth,
    withFuturePrefixes,
    withoutFuturePrefixes,
} from '../../lib/document/spreadsheetml';

describe("Excel's future functions", () => {
    test('lose their prefixes on the way in, a worksheet function both, in any case', () => {
        expect(withoutFuturePrefixes('_xlfn.IFNA(A1,0)+_xlfn._xlws.FILTER(A:A,B:B)+_XLFN.concat(1,2)')).toBe(
            'IFNA(A1,0)+FILTER(A:A,B:B)+concat(1,2)',
        );
    });

    test('gain them on the way out, and only functions Excel added after 2007', () => {
        expect(withFuturePrefixes('IFNA(SUM(A1:A2),XLOOKUP(1,B:B,C:C))+SORT(D1:D3)+stdev.s(A1:A2)')).toBe(
            '_xlfn.IFNA(SUM(A1:A2),_xlfn.XLOOKUP(1,B:B,C:C))+_xlfn._xlws.SORT(D1:D3)+_xlfn.stdev.s(A1:A2)',
        );
        expect(withFuturePrefixes('XMATCH(1,B:B)')).toBe('_xlfn.XMATCH(1,B:B)');
    });

    test("the engine's dotted functions are Excel's, each but two added after 2007", () => {
        // ERROR.TYPE predates 2007, and ISO.CEILING is in ECMA-376 itself.
        const unprefixed = new Set(['ERROR.TYPE', 'ISO.CEILING']);
        for (const name of DOTTED_FUNCTIONS) {
            expect(withFuturePrefixes(`${name}(1)`)).toBe(unprefixed.has(name) ? `${name}(1)` : `_xlfn.${name}(1)`);
        }
    });

    test('a string, a quoted sheet name, a structured reference or a name without ( is no call', () => {
        const formula = `"_xlfn.IFNA(""x"")"&'IFNA(1)'!A1&Table1[IFNA(]&IFNA&_xlfn.IFNA`;
        expect(withoutFuturePrefixes(formula)).toBe(formula);
        const bare = `"IFNA(1)"&'IFNA(1)'!A1&Table1[IFNA(]&IFNA`;
        expect(withFuturePrefixes(bare)).toBe(bare);
    });

    test('an escaped bracket inside a structured reference closes nothing and opens nothing', () => {
        expect(withFuturePrefixes("SUM(Table1[a'[b])+IFNA(A1,0)")).toBe("SUM(Table1[a'[b])+_xlfn.IFNA(A1,0)");
        expect(withFuturePrefixes("Table1[[#This Row],[a']b]]&IFNA(A1,0)")).toBe(
            "Table1[[#This Row],[a']b]]&_xlfn.IFNA(A1,0)",
        );
    });

    test('round trip', () => {
        const formula = 'IFS(A1>1,CONCAT("a","b"),TRUE,_xlpm.x)';
        expect(withoutFuturePrefixes(withFuturePrefixes(formula))).toBe(formula);
    });
});

describe('column widths', () => {
    test("Excel's digit for the Office defaults, at their size, and 7 px for a font it doesn't list", () => {
        expect(maxDigitWidth('Calibri', 11)).toBe(7);
        expect(maxDigitWidth('Calibri', 12)).toBe(8);
        expect(maxDigitWidth('Aptos Narrow', 11)).toBe(7);
        expect(maxDigitWidth('Arial', 10)).toBe(7);
        expect(maxDigitWidth('arial', 11)).toBe(8);
        expect(maxDigitWidth('Arial', 12)).toBe(9);
        expect(maxDigitWidth('Cambria', 11)).toBe(8);
        expect(maxDigitWidth('Times New Roman', 11)).toBe(7);
        expect(maxDigitWidth('Times New Roman', 12)).toBe(8);
        expect(maxDigitWidth('Carlito', 11)).toBe(7);
        expect(maxDigitWidth('Liberation Sans', 11)).toBe(8);
        expect(maxDigitWidth('Liberation Serif', 12)).toBe(8);
        expect(maxDigitWidth('Caladea', 11)).toBe(8);
        expect(maxDigitWidth('Wingdings', 11)).toBe(7);
        expect(maxDigitWidth(undefined, Number.NaN)).toBe(7);
        expect(maxDigitWidth('Inter', 10)).toBe(SHEET_DEFAULT_DIGIT_WIDTH);
    });

    // ECMA-376 Part 1 § 18.3.1.13: a width counts digits plus 5 px of padding, in 1/256ths.
    test("a width reads as Excel draws it: Calibri 11's default 9.140625 at 64 px, a 20-character column at 145", () => {
        expect(columnWidthToPx(9.140625, 7)).toBe(64);
        expect(columnWidthToPx(20.7109375, 7)).toBe(145);
        // A writer that names the characters without the padding gets 5 px less, as Excel shows 8.43 as 7.71.
        expect(columnWidthToPx(8.43, 7)).toBe(59);
        expect(columnWidthToPx(20, 7)).toBe(140);
        expect(pxToColumnWidth(64, 7)).toBe(9.140625);
        expect(pxToColumnWidth(145, 7)).toBe(20.7109375);
    });

    test('every pixel width survives the round trip at any digit', () => {
        for (let digit = 5; digit <= 16; digit++)
            for (let px = 0; px <= 2000; px++) expect(columnWidthToPx(pxToColumnWidth(px, digit), digit)).toBe(px);
    });
});
