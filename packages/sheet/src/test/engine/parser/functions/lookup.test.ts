import { describe, expect, test } from 'bun:test';
import { createArrayResolver } from '../../../../engine/cell-resolver';
import { FormulaEngine } from '../../../../engine/formula-engine';
import type { Cell } from '../../../../engine/types';

function cell(v: number | string | null): Cell | null {
    if (v == null) return null;
    return typeof v === 'number' ? { v, ct: { t: 'n', fa: 'General' } } : { v, ct: { t: 's', fa: 'General' } };
}

function rows(values: (number | string | null)[][]): (Cell | null)[][] {
    return values.map((row) => row.map(cell));
}

// A: ascending ids, B: names, C: price, D: quantity, E: descending, F: date serials, G: blank,
// H: ascending with duplicates, I: descending with duplicates.
const resolver = createArrayResolver([
    {
        id: 's1',
        name: 'Sheet1',
        data: rows([
            [10, 'Apple', 1.5, 3, 40, 46027, null, 1, 3],
            [20, 'banana', 0.5, 12, 30, 46028, null, 1, 3],
            [30, 'Cherry', 4, 7, 20, null, null, 2, 2],
            [40, 'apple', 2, 1, 10, null, null, 2, 2],
            [50, 'Xstar', 9, 9, null, null, null, 3, 1],
            [60, '*star', 6, 6, null, null, null, 3, 1],
        ]),
    },
    {
        id: 's2',
        name: 'Across',
        data: rows([
            [10, 20, 30, 40],
            ['a', 'b', 'c', 'd'],
            [1, 2, 3, 4],
        ]),
    },
    {
        // The arrays of Microsoft's XMATCH examples.
        id: 's3',
        name: 'Docs',
        data: rows([
            [5, 'Apple'],
            [4, 'Grape'],
            [3, 'Pear'],
            [2, 'Banana'],
            [1, 'Cherry'],
        ]),
    },
    {
        // A row of labels with a blank and a number between them, as a scenario picker holds.
        id: 's4',
        name: 'Labels',
        data: rows([[null, 'Real (Low)', 5, 'Real (Central)', 'Real (High)']]),
    },
    {
        // Excel for the web's blank-lookup case: A1 and A3 empty, and C1, the lookup value, empty too.
        id: 's5',
        name: 'Blanks',
        data: rows([
            [null, 'one', null],
            ['x', 'two', null],
            [null, 'three', null],
            [5, 'four', null],
        ]),
    },
]);

const engine = new FormulaEngine();
const value = (formula: string) => engine.evaluate(formula, 's1', resolver).value;

describe('XLOOKUP', () => {
    test('an exact match is the default, and text matches case-insensitively', () => {
        expect(value('=XLOOKUP(30,A1:A6,B1:B6)')).toBe('Cherry');
        expect(value('=XLOOKUP("APPLE",B1:B6,A1:A6)')).toBe(10);
        expect(value('=xlookup("cherry",B1:B6,C1:C6)')).toBe(4);
    });

    test('a value matches only its own kind: text "10" is not the number 10', () => {
        expect(value('=XLOOKUP("10",A1:A6,B1:B6)')).toBe('#N/A');
    });

    test('a miss is #N/A, or if_not_found when it is given', () => {
        expect(value('=XLOOKUP(25,A1:A6,B1:B6)')).toBe('#N/A');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none")')).toBe('none');
        expect(value('=IFERROR(XLOOKUP(25,A1:A6,B1:B6),"fallback")')).toBe('fallback');
    });

    test('match_mode -1 takes the next smaller item, 1 the next larger, an exact match first', () => {
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none",-1)')).toBe('banana');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none",1)')).toBe('Cherry');
        expect(value('=XLOOKUP(30,A1:A6,B1:B6,"none",1)')).toBe('Cherry');
        expect(value('=XLOOKUP(5,A1:A6,B1:B6,"none",-1)')).toBe('none');
        expect(value('=XLOOKUP(99,A1:A6,B1:B6,"none",1)')).toBe('none');
    });

    test('match_mode 2 reads * ? and ~ as wildcards, case-insensitively; other modes read them literally', () => {
        expect(value('=XLOOKUP("B*",B1:B6,A1:A6,"none",2)')).toBe(20);
        expect(value('=XLOOKUP("?herry",B1:B6,A1:A6,"none",2)')).toBe(30);
        expect(value('=XLOOKUP("*star",B1:B6,A1:A6,"none",2)')).toBe(50);
        expect(value('=XLOOKUP("~*star",B1:B6,A1:A6,"none",2)')).toBe(60);
        expect(value('=XLOOKUP("b*",B1:B6,A1:A6,"none",0)')).toBe('none');
        expect(value('=XLOOKUP("*star",B1:B6,A1:A6,"none",0)')).toBe(60);
    });

    test('search_mode -1 searches last to first', () => {
        expect(value('=XLOOKUP("apple",B1:B6,A1:A6,"none",0,1)')).toBe(10);
        expect(value('=XLOOKUP("apple",B1:B6,A1:A6,"none",0,-1)')).toBe(40);
        expect(value('=XLOOKUP("a*",B1:B6,A1:A6,"none",2,-1)')).toBe(40);
    });

    test('search_mode 2 is a binary search over ascending data, -2 over descending', () => {
        expect(value('=XLOOKUP(30,A1:A6,B1:B6,"none",0,2)')).toBe('Cherry');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none",0,2)')).toBe('none');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none",-1,2)')).toBe('banana');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,"none",1,2)')).toBe('Cherry');
        expect(value('=XLOOKUP(20,E1:E6,B1:B6,"none",0,-2)')).toBe('Cherry');
        expect(value('=XLOOKUP(25,E1:E6,B1:B6,"none",-1,-2)')).toBe('Cherry');
        expect(value('=XLOOKUP(25,E1:E6,B1:B6,"none",1,-2)')).toBe('banana');
        // Past either end.
        expect(value('=XLOOKUP(5,A1:A6,B1:B6,"none",-1,2)')).toBe('none');
        expect(value('=XLOOKUP(99,A1:A6,B1:B6,"none",-1,2)')).toBe('*star');
    });

    test('a wildcard binary search, or a mode outside its list, is #VALUE!', () => {
        expect(value('=XLOOKUP("b*",B1:B6,A1:A6,"none",2,2)')).toBe('#VALUE!');
        expect(value('=XLOOKUP(30,A1:A6,B1:B6,"none",3)')).toBe('#VALUE!');
        expect(value('=XLOOKUP(30,A1:A6,B1:B6,"none",0,0)')).toBe('#VALUE!');
    });

    test('a lookup_array that is not one row or column, or a return_array of another length, is #VALUE!', () => {
        expect(value('=XLOOKUP(30,A1:A6,B1:B5)')).toBe('#VALUE!');
        expect(value('=XLOOKUP(30,A1:B6,C1:C6)')).toBe('#VALUE!');
        expect(value('=XLOOKUP(30,Across!A1:D1,Across!A2:C2)')).toBe('#VALUE!');
    });

    test('an error argument propagates', () => {
        expect(value('=XLOOKUP(1/0,A1:A6,B1:B6)')).toBe('#DIV/0!');
    });

    test('a row lookup_array searches across and returns from the matching column', () => {
        expect(value('=XLOOKUP(30,Across!A1:D1,Across!A3:D3)')).toBe(3);
        expect(value('=XLOOKUP("D",Across!A2:D2,Across!A1:D1)')).toBe(40);
    });

    test('a 2-D return_array gives the matched row or column, which a cell shows by its top-left', () => {
        expect(value('=XLOOKUP(30,A1:A6,B1:D6)')).toBe('Cherry');
        expect(value('=SUM(XLOOKUP(30,A1:A6,C1:D6))')).toBe(11);
        expect(value('=XLOOKUP(30,Across!A1:D1,Across!A2:D3)')).toBe('c');
        expect(value('=SUM(XLOOKUP(20,Across!A1:D1,Across!A1:D3))')).toBe(22);
    });

    test('an empty if_not_found is #N/A, an empty mode its default, an empty array #VALUE!', () => {
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,,-1)')).toBe('banana');
        expect(value('=XLOOKUP(25,A1:A6,B1:B6,,)')).toBe('#N/A');
        expect(value('=XLOOKUP("apple",B1:B6,A1:A6,,,-1)')).toBe(40);
        expect(value('=XLOOKUP(30,A1:A6,B1:B6,"none",,)')).toBe('Cherry');
        expect(value('=XLOOKUP(30,A1:A6,)')).toBe('#VALUE!');
        expect(value('=XLOOKUP(30,,B1:B6)')).toBe('#VALUE!');
    });

    test('a date lookup value finds its serial', () => {
        expect(value('=XLOOKUP(DATE(2026,1,6),F1:F6,B1:B6)')).toBe('banana');
    });
});

describe('XMATCH', () => {
    test('Microsoft\'s examples: 4 in {5,4,3,2,1} is 2, 4.5 with match_mode 1 is 1, "Gra" with 1 is Grape', () => {
        expect(value('=XMATCH(4,Docs!A1:A5)')).toBe(2);
        expect(value('=XMATCH(4.5,Docs!A1:A5,1)')).toBe(1);
        expect(value('=XMATCH("Gra",Docs!B1:B5,1)')).toBe(2);
    });

    test('positions count from the start of the array, whichever way it searches', () => {
        expect(value('=XMATCH("apple",B1:B6)')).toBe(1);
        expect(value('=XMATCH("apple",B1:B6,0,-1)')).toBe(4);
        expect(value('=XMATCH(25,A1:A6,-1,2)')).toBe(2);
        expect(value('=XMATCH(25,E1:E6,1,-2)')).toBe(2);
        expect(value('=XMATCH("c",Across!A2:D2)')).toBe(3);
    });

    test('a blank lookup value finds the first blank cell', () => {
        expect(value('=XMATCH(G1,E1:E6)')).toBe(5);
    });

    test('an empty mode is its default', () => {
        expect(value('=XMATCH(25,A1:A6,-1,)')).toBe(2);
        expect(value('=XMATCH("apple",B1:B6,,-1)')).toBe(4);
    });

    test('a binary search lands an exact match on its first occurrence in every match mode, as a linear one does', () => {
        for (const matchMode of [0, -1, 1]) {
            expect(value(`=XMATCH(2,H1:H6,${matchMode},2)`)).toBe(3);
            expect(value(`=XMATCH(2,I1:I6,${matchMode},-2)`)).toBe(3);
            expect(value(`=XMATCH(2,H1:H6,${matchMode},1)`)).toBe(3);
        }
    });

    test('a miss is #N/A, a 2-D lookup_array #VALUE!', () => {
        expect(value('=XMATCH(25,A1:A6)')).toBe('#N/A');
        expect(value('=XMATCH(30,A1:B6)')).toBe('#VALUE!');
    });
});

describe('MATCH', () => {
    test('match_type 0 finds text across a row that holds blanks, numbers and parentheses', () => {
        expect(value('=MATCH("Real (Central)",Labels!A1:E1,0)')).toBe(4);
        expect(value('=MATCH("real (high)",Labels!A1:E1,0)')).toBe(5);
        expect(value('=MATCH("x",A1:A6,0)')).toBe('#N/A');
    });

    test('match_type 0 matches the whole text, with * ? and ~ as wildcards', () => {
        expect(value('=MATCH("an",B1:B6,0)')).toBe('#N/A');
        expect(value('=MATCH("ch*",B1:B6,0)')).toBe(3);
        expect(value('=MATCH("?pple",B1:B6,0)')).toBe(1);
        expect(value('=MATCH("~*star",B1:B6,0)')).toBe(6);
    });

    test('a value matches only its own kind, and a blank lookup value is 0', () => {
        expect(value('=MATCH("30",A1:A6,0)')).toBe('#N/A');
        expect(value('=MATCH(5,Labels!A1:E1,0)')).toBe(3);
        expect(value('=MATCH(G1,Labels!A1:E1,0)')).toBe('#N/A');
    });

    test('match_type 1, the default, takes the last value at or below over ascending data', () => {
        expect(value('=MATCH(25,A1:A6)')).toBe(2);
        expect(value('=MATCH(25,A1:A6,1)')).toBe(2);
        expect(value('=MATCH(99,A1:A6,1)')).toBe(6);
        expect(value('=MATCH(5,A1:A6)')).toBe('#N/A');
        expect(value('=MATCH(2,H1:H6)')).toBe(4);
        expect(value('=MATCH("c",Across!A2:D2)')).toBe(3);
    });

    test('match_type -1 takes the last value at or above over descending data', () => {
        expect(value('=MATCH(25,E1:E6,-1)')).toBe(2);
        expect(value('=MATCH(2,I1:I6,-1)')).toBe(4);
        expect(value('=MATCH(99,E1:E6,-1)')).toBe('#N/A');
    });

    test('an empty match_type is 0, an exact match', () => {
        expect(value('=MATCH(25,A1:A6,)')).toBe('#N/A');
        expect(value('=MATCH(30,A1:A6,)')).toBe(3);
    });
});

describe('VLOOKUP', () => {
    test('an empty range_lookup is FALSE, an exact match, as in Excel', () => {
        expect(value('=VLOOKUP(25,A1:B6,2)')).toBe('banana');
        expect(value('=VLOOKUP(25,A1:B6,2,)')).toBe('#N/A');
        expect(value('=VLOOKUP(30,A1:B6,2,)')).toBe('Cherry');
    });

    test('an exact match is case-insensitive, with * ? and ~ as wildcards, and only of its own kind', () => {
        expect(value('=VLOOKUP("APPLE",B1:C6,2,FALSE)')).toBe(1.5);
        expect(value('=VLOOKUP("ch*",B1:C6,2,FALSE)')).toBe(4);
        expect(value('=VLOOKUP("~*star",B1:C6,2,FALSE)')).toBe(6);
        expect(value('=VLOOKUP("30",A1:B6,2,FALSE)')).toBe('#N/A');
    });

    test('a blank lookup value is 0, so it finds no blank cell', () => {
        expect(value('=VLOOKUP(G1,G1:H6,2,FALSE)')).toBe('#N/A');
        expect(value('=IFNA(VLOOKUP(G1,G1:H6,2,FALSE),"")')).toBe('');
    });

    test('an approximate match takes the last row at or below over ascending data', () => {
        expect(value('=VLOOKUP(99,A1:B6,2,TRUE)')).toBe('*star');
        expect(value('=VLOOKUP(5,A1:B6,2,TRUE)')).toBe('#N/A');
        expect(value('=VLOOKUP(25,A1:B6,2,-1)')).toBe('banana');
    });

    test('a column past the table is #REF!, one below 1 #VALUE!', () => {
        expect(value('=VLOOKUP(30,A1:B6,3,FALSE)')).toBe('#REF!');
        expect(value('=VLOOKUP(30,A1:B6,0,FALSE)')).toBe('#VALUE!');
    });
});

describe('HLOOKUP', () => {
    test('searches the first row and returns from the row asked for', () => {
        expect(value('=HLOOKUP("C",Across!A2:D3,2,FALSE)')).toBe(3);
        expect(value('=HLOOKUP(25,Across!A1:D3,2)')).toBe('b');
        expect(value('=HLOOKUP(30,Across!A1:D3,4,FALSE)')).toBe('#REF!');
    });
});

describe('a blank lookup value', () => {
    test('MATCH and VLOOKUP read it as 0 and find no empty cell, nor does "" or 0', () => {
        expect(value('=MATCH(Blanks!C1,Blanks!A1:A4,0)')).toBe('#N/A');
        expect(value('=VLOOKUP(Blanks!C1,Blanks!A1:B4,2,FALSE)')).toBe('#N/A');
        expect(value('=MATCH(0,Blanks!A1:A4,0)')).toBe('#N/A');
        expect(value('=MATCH("",Blanks!A1:A4,0)')).toBe('#N/A');
    });

    test('XMATCH finds the first empty cell', () => {
        expect(value('=XMATCH(Blanks!C1,Blanks!A1:A4)')).toBe(1);
    });
});

describe('INDEX', () => {
    test('a row_num of 0, empty or a blank cell is the whole column, a column_num of 0 or empty the whole row', () => {
        expect(value('=SUM(INDEX(C1:D6,,1))')).toBe(23);
        expect(value('=SUM(INDEX(C1:D6,0,2))')).toBe(38);
        expect(value('=SUM(INDEX(C1:D6,G1,2))')).toBe(38);
        expect(value('=SUM(INDEX(C1:D6,2,))')).toBe(12.5);
        expect(value('=SUM(INDEX(C1:D6,3,0))')).toBe(11);
        expect(value('=SUM(INDEX(C1:D6,0,0))')).toBe(61);
        expect(value('=SUM(INDEX(C1:C6,0))')).toBe(23);
    });

    test('a whole column shows its first cell, and a fraction truncates', () => {
        expect(value('=INDEX(C1:D6,0,2)')).toBe(3);
        expect(value('=SUM(INDEX(C1:D6,2.9,0))')).toBe(12.5);
    });

    test('an index past the array is #REF!, a negative one #VALUE!', () => {
        expect(value('=INDEX(C1:D6,7,0)')).toBe('#REF!');
        expect(value('=INDEX(C1:D6,0,3)')).toBe('#REF!');
        expect(value('=INDEX(C1:D6,-1,0)')).toBe('#VALUE!');
    });

    test('an empty cell it gives shows 0, as a reference to one does', () => {
        expect(value('=INDEX(Labels!A1:E1,,1)')).toBe(0);
        expect(value('=INDEX(Labels!A1:E1,1)')).toBe(0);
        expect(value('=Labels!A1:E1')).toBe(0);
        expect(value('=Labels!A1')).toBe(0);
    });

    test('a row and a column still give one cell', () => {
        expect(value('=INDEX(C1:D6,2,2)')).toBe(12);
        expect(value('=INDEX(B1:B6,3)')).toBe('Cherry');
    });

    // Microsoft's INDEX: a one-row or one-column array takes its one index along itself.
    test('one index into a one-row range picks along the row', () => {
        expect(value('=INDEX(Across!A1:D1,2)')).toBe(20);
        expect(value('=INDEX(Across!A1:D1,4)')).toBe(40);
        expect(value('=INDEX(Across!A1:D1,5)')).toBe('#REF!');
        expect(value('=INDEX(Across!A1:D1,1,3)')).toBe(30);
        expect(value('=SUM(INDEX(Across!A1:D1,0))')).toBe(100);
        expect(value('=INDEX(Across!A1:A3,2)')).toBe('a');
    });
});
