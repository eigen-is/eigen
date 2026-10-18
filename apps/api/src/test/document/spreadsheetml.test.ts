import { describe, expect, test } from 'bun:test';
import { withFuturePrefixes, withoutFuturePrefixes } from '../../lib/document/spreadsheetml';

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
