import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NULL, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, valueAt } from '../recalc/support';

// A is sorted with one value twice, D is not sorted, F mixes kinds around a blank, H is text for the wildcards.
const TABLES: Cells = {
    A1: 1,
    A2: 3,
    A3: 5,
    A4: 5,
    A5: 9,
    A6: 11,
    B1: 'a',
    B2: 'b',
    B3: 'c',
    B4: 'd',
    B5: 'e',
    B6: 'f',
    D1: 1,
    D2: 9,
    D3: 3,
    D4: 7,
    D5: 5,
    F1: 1,
    F2: 'x',
    F3: 3,
    F5: '5',
    F6: 7,
    H1: 'apple',
    H2: 'Apple pie',
    H3: 'a*b',
    H4: 'banana',
    I1: 1,
    I2: 2,
    I3: 3,
    I4: 4,
};

describe('MATCH', () => {
    test.each([
        ['=MATCH(5,A1:A6,0)', 3],
        ['=MATCH(5,A1:A6,1)', 4],
        ['=MATCH(5,A1:A6)', 4],
        ['=MATCH(6,A1:A6,1)', 4],
        ['=MATCH(0,A1:A6,1)', NA],
        ['=MATCH(100,A1:A6,1)', 6],
        ['=MATCH(6,A1:A6,0)', NA],
        ['=MATCH("5",A1:A6,0)', NA],
        ['=MATCH(5,A1:B6,0)', NA],
        ['=MATCH(5,D1:D5,1)', 3],
        ['=MATCH(9,D1:D5,1)', 5],
        ['=MATCH(9,D1:D5,0)', 2],
        ['=MATCH(4,F1:F6,1)', 3],
        ['=MATCH(5,F1:F6,0)', NA],
        ['=MATCH("5",F1:F6,0)', 5],
        ['=MATCH("y",F1:F6,1)', 5],
        ['=MATCH("APPLE",H1:H4,0)', 1],
        ['=MATCH("app*",H1:H4,0)', 1],
        ['=MATCH("a~*b",H1:H4,0)', 3],
        ['=MATCH("*",H1:H4,0)', 1],
        ['=MATCH("b?nana",H1:H4,0)', 4],
        ['=MATCH("*",F1:F6,0)', 2],
        ['=MATCH(9,{11,9,5,5,3,1},-1)', 2],
        ['=MATCH(4,{11,9,5,5,3,1},-1)', 4],
        ['=MATCH(12,{11,9,5,5,3,1},-1)', NA],
        ['=MATCH(5,{20,19,18,17,16,15,14,13,12,11,10,6,6,5,5,4,4,3,2,1},-1)', 14],
        ['=MATCH(3,{1,"",3},1)', 3],
        ['=MATCH(TRUE,{FALSE,TRUE},0)', 2],
        ['=MATCH(1,{FALSE,TRUE},0)', NA],
        ['=MATCH("a",{1,3,"b","d"},1)', NA],
        ['=MATCH("c",{1,3,"b","d"},1)', 3],
        ['=MATCH(9,A:A,0)', 5],
        ['=MATCH(10,A:A)', 5],
        ['=MATCH(3,A1:A6,)', 2],
        ['=MATCH(C1,A1:A6,0)', NA],
        ['=MATCH(1/0,A1:A6,0)', DIV0],
        ['=MATCH(5,#REF!,0)', REF],
        ['=MATCH(5,A1:A6,"x")', VALUE],
        ['=MATCH(5,5,0)', 1],
        ['=MATCH(0.1+0.2,{0.1,0.3},0)', 2],
        ['=SUM(MATCH({5,9},A1:A6,0))', 8],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, TABLES)).toBe(expected);
    });

    test('a blank key is 0, and an error in the cells searched is skipped', () => {
        expect(evaluate('=MATCH(C1,A1:A3,0)', { A1: 5, A2: 0 })).toBe(2);
        expect(evaluate('=MATCH(0,G77:G79,0)', { G77: NA, G78: 0, G79: 1 })).toBe(2);
        expect(evaluate('=MATCH(1,G77:G79,0)', { G77: NA, G78: 0, G79: 1 })).toBe(3);
        expect(evaluate('=MATCH(5,G77:G79,0)', { G77: NA, G78: 0, G79: 1 })).toBe(NA);
        expect(evaluate('=MATCH("",A1:A1,0)')).toBe(NA);
    });

    test('a row of mixed kinds is searched among the cells of the key own kind', () => {
        const row = { F5: 2, G5: 4, H5: 4, I5: 8, J5: 'B', K5: 'B', L5: 'D', M5: 'H' };
        const of = (key: string) => evaluate(`=MATCH(${key},F5:M5,1)`, row, 'A1');
        expect([1, 2, 3, 4, 7, 8, 9].map((key) => of(String(key)))).toEqual([NA, 1, 1, 3, 3, 4, 4]);
        expect(['A', 'B', 'C', 'D', 'G', 'H', 'I'].map((key) => of(`"${key}"`))).toEqual([NA, 6, 6, 7, 7, 8, 8]);
    });

    test('a descending search takes the first of equal keys and the last larger one', () => {
        const cells = { I1: 10, I2: 8, I3: 6, I4: 4, I5: 2 };
        expect([10, 9, 8, 7].map((key) => evaluate(`=MATCH(${key},I1:I5,-1)`, cells))).toEqual([1, 1, 2, 2]);
    });
});

describe('VLOOKUP and HLOOKUP', () => {
    test.each([
        ['=VLOOKUP(5,A1:B6,2,FALSE)', 'c'],
        ['=VLOOKUP(5,A1:B6,2,TRUE)', 'd'],
        ['=VLOOKUP(5,A1:B6,2)', 'd'],
        ['=VLOOKUP(4,A1:B6,2)', 'b'],
        ['=VLOOKUP(0,A1:B6,2)', NA],
        ['=VLOOKUP(5,A1:B6,3,FALSE)', REF],
        ['=VLOOKUP(5,A1:B6,0,FALSE)', VALUE],
        ['=VLOOKUP("app*",H1:I4,2,FALSE)', 1],
        ['=VLOOKUP("APPLE PIE",H1:I4,2,FALSE)', 2],
        ['=VLOOKUP(C1,A1:B6,2,FALSE)', NA],
        ['=VLOOKUP(5,A1:B6,2,0)', 'c'],
        ['=VLOOKUP(5,A1:B6,2,)', 'c'],
        ['=VLOOKUP(5,A1:B6,2.9,FALSE)', 'c'],
        ['=VLOOKUP(9,A:B,2,FALSE)', 'e'],
        ['=VLOOKUP(11,A1:C6,3,FALSE)', 0],
        ['=VLOOKUP(9,A3:A3,1,FALSE)', NA],
        ['=VLOOKUP("b",{"a",1;"B",2},2,FALSE)', 2],
        ['=VLOOKUP("a",{1;3;"b";"d"},1,1)', NA],
        ['=VLOOKUP(1/0,A1:B6,2)', DIV0],
        ['=VLOOKUP(5,A1:B6,"x")', VALUE],
        ['=VLOOKUP({1,2},A1:B6,2,FALSE)', 'a'],
        ['=HLOOKUP(3,{1,3,5;"a","b","c"},2,FALSE)', 'b'],
        ['=HLOOKUP(4,{1,3,5;"a","b","c"},2)', 'b'],
        ['=HLOOKUP(3,{1,3,5;"a","b","c"},3,FALSE)', REF],
        ['=HLOOKUP(9,A2:F4,2,FALSE)', 3],
        ['=HLOOKUP("X",A2:F2,1,FALSE)', 'x'],
        ['=HLOOKUP(2,D1:F1,1)', 1],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, TABLES)).toBe(expected);
    });

    test('a found cell that is blank gives 0 in a cell and nothing in a text', () => {
        expect(evaluate('=VLOOKUP(1,A1:B6,2,FALSE)', { A1: 1 })).toBe(0);
        expect(evaluate('=VLOOKUP(1,D1:E1,2)', { D1: 1 })).toBe(0);
        expect(evaluate('=VLOOKUP(1,A1:B6,2,FALSE)&"."', { A1: 1 })).toBe('.');
    });

    test('a sorted column is searched among the cells of the key own kind', () => {
        const mixed = { U1: 1, U2: 3, U3: 'b', U4: 'd', V1: 'one', V2: 'two', V3: 'three', V4: 'four' };
        const of = (key: string) => evaluate(`=VLOOKUP(${key},U1:V4,2)`, mixed);
        expect(['0', '1', '2', '3', '4'].map(of)).toEqual([NA, 'one', 'one', 'two', 'two']);
        expect(['"a"', '"b"', '"c"', '"d"', '"e"'].map(of)).toEqual([NA, 'three', 'three', 'four', 'four']);
        const numbers = { J2: 1, J3: 2, J4: 4, K2: 11, K3: 12, K4: 14 };
        expect(
            ['1', '4', '3.5', '5', '-0.5', '11'].map((key) => evaluate(`=VLOOKUP(${key},J2:K4,2,1)`, numbers)),
        ).toEqual([11, 14, 12, 14, NA, 14]);
        const unsorted = { J2: 5, J3: 8, J4: 6, K2: 21, K3: 24, K4: 22 };
        expect(['5', '6', '8', '7'].map((key) => evaluate(`=VLOOKUP(${key},J2:K4,2,0)`, unsorted))).toEqual([
            21,
            22,
            24,
            NA,
        ]);
    });

    test('text is found in any case and with its accents', () => {
        expect(evaluate('=VLOOKUP("ABCD",A1:A1,1,0)', { A1: 'abcd' })).toBe('abcd');
        const accents = { A1: 'coté', A2: 'côte', A3: 'côté', B1: 1, B2: 2, B3: 3 };
        expect(evaluate('=VLOOKUP("coté",A1:B3,2,0)', accents)).toBe(1);
        expect(evaluate('=VLOOKUP("côte",A1:B3,2,0)', accents)).toBe(2);
        expect(evaluate('=VLOOKUP("CÔTÉ",A1:B3,2,0)', accents)).toBe(3);
        expect(evaluate('=VLOOKUP("cote",A1:B3,2,0)', accents)).toBe(NA);
    });

    test('a key has no length limit', () => {
        const long = 'a'.repeat(300);
        expect(evaluate('=VLOOKUP(C1,H1:I4,2,FALSE)', { ...TABLES, C1: long })).toBe(NA);
        expect(evaluate('=VLOOKUP(C1,H1:I5,2,FALSE)', { ...TABLES, C1: long, H5: long.toUpperCase(), I5: 5 })).toBe(5);
        expect(evaluate('=MATCH(C1&"*",H1:H5,0)', { ...TABLES, C1: long, H5: `${long}b` })).toBe(5);
    });

    test('the result cell is computed when it is still to be', () => {
        const engine = engineOf({
            s1: { A1: '=VLOOKUP("k"&2,Data!A1:B3,2,FALSE)' },
            data: { A1: 'k1', A2: '="K"&(1+1)', A3: 'k3', B1: 1, B2: '=B1+41', B3: 3 },
        });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(42);
    });
});

describe('LOOKUP', () => {
    test.each([
        ['=LOOKUP(6,A1:A6,B1:B6)', 'd'],
        ['=LOOKUP(6,A1:B6)', 'd'],
        ['=LOOKUP(0,A1:A6,B1:B6)', NA],
        ['=LOOKUP(2,1/(A1:A6=5),B1:B6)', 'd'],
        ['=LOOKUP(100,A1:A6)', 11],
        ['=LOOKUP(3,{1,3,5;"a","b","c"})', 'b'],
        ['=LOOKUP(3,{1,"a";3,"b";5,"c"})', 'b'],
        ['=LOOKUP(3,{1,"a";3,"b"})', 'b'],
        ['=LOOKUP(3,D1:F1,A1:A3)', 5],
        ['=LOOKUP(11,A1:A6,B1:B3)', NA],
        ['=LOOKUP(9,A1:A6,#N/A)', NA],
        ['=LOOKUP(1/0,A1:A6)', DIV0],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, TABLES)).toBe(expected);
    });
});

describe('XLOOKUP and XMATCH', () => {
    test.each([
        ['=XLOOKUP(5,A1:A6,B1:B6)', 'c'],
        ['=XLOOKUP(5,A1:A6,B1:B6,,0,-1)', 'd'],
        ['=XLOOKUP(6,A1:A6,B1:B6)', NA],
        ['=XLOOKUP(6,A1:A6,B1:B6,"none")', 'none'],
        ['=XLOOKUP(6,A1:A6,B1:B6,,-1)', 'c'],
        ['=XLOOKUP(6,A1:A6,B1:B6,,-1,-1)', 'd'],
        ['=XLOOKUP(6,A1:A6,B1:B6,,1)', 'e'],
        ['=XLOOKUP(6,D1:D5,D1:D5,,-1)', 5],
        ['=XLOOKUP(6,D1:D5,D1:D5,,1)', 7],
        ['=XLOOKUP(0,D1:D5,D1:D5,,-1)', NA],
        ['=XLOOKUP(10,D1:D5,D1:D5,,1)', NA],
        ['=XLOOKUP("app*",H1:H4,I1:I4)', NA],
        ['=XLOOKUP("app*",H1:H4,I1:I4,,2)', 1],
        ['=XLOOKUP("app*",H1:H4,I1:I4,,2,-1)', 2],
        ['=XLOOKUP("b",H1:H4,I1:I4,,-1)', 2],
        ['=XLOOKUP("b",H1:H4,I1:I4,,1)', 4],
        ['=XLOOKUP(5,A1:A6,B1:B6,,0,2)', 'c'],
        ['=XLOOKUP(9,D1:D5,D1:D5,,0,2)', NA],
        ['=XLOOKUP(6,A1:A6,B1:B6,,-1,2)', 'd'],
        ['=XLOOKUP(6,A1:A6,B1:B6,,1,2)', 'e'],
        ['=XLOOKUP(4,{11,9,5,5,3,1},{"a","b","c","d","e","f"},,1,-2)', 'd'],
        ['=XLOOKUP(4,{11,9,5,5,3,1},{"a","b","c","d","e","f"},,-1,-2)', 'e'],
        // Of equal keys a search down the values takes the last one (Excel: XMATCH(2,{3,2,2,2,1},0,-2) is 4).
        ['=XLOOKUP(5,{11,9,5,5,3,1},{"a","b","c","d","e","f"},,0,-2)', 'd'],
        ['=XLOOKUP(5,A1:A6,B1:C6)', 'c'],
        ['=INDEX(XLOOKUP(5,A1:A6,B1:C6),1,2)', 0],
        ['=XLOOKUP(5,A1:B6,B1:B6)', VALUE],
        ['=XLOOKUP(5,A1:A6,B1:B5)', VALUE],
        ['=XLOOKUP(1,A:A,B:B)', 'a'],
        ['=XLOOKUP(3,D3:F3,D2:F2)', 9],
        ['=XLOOKUP(3,D3:F3,D2:F2,,0,-1)', 'x'],
        ['=XLOOKUP("x",D2:F2,D1:F4)', 1],
        ['=SUM(XLOOKUP("x",D2:F2,D1:F6))', 11],
        ['=XLOOKUP(3,{1,3,5},{"a","b","c"})', 'b'],
        ['=XLOOKUP(3,{1;3;5},{"a",1;"b",2;"c",3})', 'b'],
        ['=SUM(XLOOKUP(3,{1;3;5},{4,1;5,2;6,3}))', 7],
        ['=XLOOKUP(5,A1:A6,B1:B6,1/0)', 'c'],
        ['=XLOOKUP(6,A1:A6,B1:B6,1/0)', DIV0],
        ['=XLOOKUP(5,A1:A6,B1:B6,N1)', 'c'],
        ['=XLOOKUP(1/0,A1:A6,B1:B6,"none")', DIV0],
        ['=XLOOKUP(5,A1:A6,B1:B6,,3)', VALUE],
        ['=XLOOKUP(5,A1:A6,B1:B6,,0,0)', VALUE],
        ['=XLOOKUP("a*",H1:H4,I1:I4,,2,2)', VALUE],
        ['=COUNTA(XLOOKUP(1,A1:A6,B1:B6):XLOOKUP(9,A1:A6,B1:B6))', 5],
        ['=XMATCH(5,A1:A6)', 3],
        ['=XMATCH(6,A1:A6,-1)', 3],
        ['=XMATCH(5,A1:A6,0,-1)', 4],
        ['=XMATCH("app*",H1:H4)', NA],
        ['=XMATCH("app*",H1:H4,2)', 1],
        ['=XMATCH("x",D2:F2)', 3],
        ['=XMATCH(5,A1:B6)', VALUE],
        ['=XMATCH(5,A1:A6,5)', VALUE],
        ['=XMATCH(5,A1:A6,0,3)', VALUE],
        ['=XMATCH(TRUE,{1,"TRUE",TRUE})', 3],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, TABLES)).toBe(expected);
    });

    test('a key left out finds the first blank cell, also past the last used row', () => {
        const names = { A2: 'n1', A3: 'n2', A4: 'n3' };
        expect(evaluate('=XMATCH(,A2:A9)', names)).toBe(4);
        expect(evaluate('=XMATCH(C1,A2:A9)', names)).toBe(4);
        expect(evaluate('=XMATCH(,A2:A4)', names)).toBe(NA);
        expect(evaluate('=XMATCH(,A2:A9,0,-1)', names)).toBe(8);
        expect(evaluate('=XMATCH(,A1:A9)', names)).toBe(1);
        expect(evaluate('=XLOOKUP(,B1:D1,B2:D2)', { B1: 1, D1: 3, B2: 'x', C2: 'y', D2: 'z' })).toBe('y');
    });

    test('a sorted column with a blank in it is searched as if the blank were not there', () => {
        const cells = { A1: 1, A2: 2, A4: 3 };
        expect(evaluate('=XLOOKUP(3,A1:A4,A1:A4,"NF",0,2)', cells)).toBe(3);
        expect(evaluate('=MATCH(3,A1:A4,1)', cells)).toBe(4);
        expect(evaluate('=MATCH(2.5,A1:A9,1)', cells)).toBe(2);
    });
});

// The cells every sheet of Excel's reference batch holds (oracle/family-reference.md).
const BATCH: Cells = {
    A1: 1.5,
    A2: -2.5,
    A3: 0,
    A4: 10,
    A5: 1e300,
    B2: '3',
    B3: true,
    B4: '=1/0',
    B5: 'abc',
    B6: '=""',
    B7: '=NA()',
    C1: 2,
    C2: 4,
    C3: 6,
    D1: 'k1',
    D2: 'k2',
    D3: 'k3',
    D4: 'k4',
    E1: 10,
    E2: 20,
    E3: 30,
    E4: 40,
};

describe('ROWS, COLUMNS and AREAS', () => {
    test.each([
        ['=ROWS(D1:E4)', 4],
        ['=COLUMNS(D1:E4)', 2],
        ['=ROWS(B4)', 1],
        ['=COLUMNS("abc")', 1],
        ['=ROWS({1,0;TRUE,"x"})', 2],
        ['=COLUMNS({1,2,3})', 3],
        ['=ROWS(A:C)', 1048576],
        ['=COLUMNS(1:3)', 16384],
        ['=ROWS((A1:A2,C1:C2))', REF],
        ['=COLUMNS((A1:A2,C1:C3,D1:E4))', REF],
        ['=ROWS(NA())', NA],
        ['=COLUMNS(1/0)', DIV0],
        ['=ROWS(A1:A3+1)', 3],
        ['=ROWS(OFFSET(A1,0,0,3,2))', 3],
        ['=COLUMNS(INDEX(A1:C3,2,0))', 3],
        ['=ROWS(A1:A3 A2:A5)', 2],
        ['=COLUMNS(A1:A2 C1:C2)', NULL],
        ['=COLUMNS(Sheet2!A1:B3)', 2],
        ['=AREAS(B4)', 1],
        ['=AREAS(D1:E4)', 1],
        ['=AREAS((A1:A2,C1:C2))', 2],
        ['=AREAS((A1,A1))', 2],
        ['=AREAS((A1:A2,(C1,D1)))', 3],
        ['=AREAS(((A1,C1),(D1,E1)))', 4],
        ['=AREAS(A1:A2 A2:A3)', 1],
        ['=AREAS(A1:A2 C1:C2)', NULL],
        ['=AREAS(INDEX((A1:A2,C1:C2),0,0,2))', 1],
        ['=AREAS(OFFSET(A1,0,0,2,2))', 1],
        ['=AREAS(5)', VALUE],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, BATCH)).toBe(expected);
    });
});

describe('ADDRESS', () => {
    test.each([
        ['=ADDRESS(2,3)', '$C$2'],
        ['=ADDRESS(2,3,2)', 'C$2'],
        ['=ADDRESS(2,3,3)', '$C2'],
        ['=ADDRESS(2,3,4)', 'C2'],
        ['=ADDRESS(2,3,0)', VALUE],
        ['=ADDRESS(2,3,5)', VALUE],
        ['=ADDRESS(2,3,12.5)', VALUE],
        ['=ADDRESS(2,3,3.9)', '$C2'],
        ['=ADDRESS(2,3,FALSE)', VALUE],
        ['=ADDRESS(2,3,B1)', VALUE],
        ['=ADDRESS(2,3,,TRUE)', '$C$2'],
        ['=ADDRESS(2,3,1,)', '$C$2'],
        ['=ADDRESS(2,3,1,0)', 'R2C3'],
        ['=ADDRESS(2,3,1,B1)', 'R2C3'],
        ['=ADDRESS(2,3,1,"false")', 'R2C3'],
        ['=ADDRESS(2,3,1,"0")', VALUE],
        ['=ADDRESS(2,3,2,FALSE)', 'R2C[3]'],
        ['=ADDRESS(2,3,3,FALSE)', 'R[2]C3'],
        ['=ADDRESS(2,3,4,FALSE)', 'R[2]C[3]'],
        ['=ADDRESS(0,3)', VALUE],
        ['=ADDRESS(0.5,3)', VALUE],
        ['=ADDRESS(1.9,3)', '$C$1'],
        ['=ADDRESS(,3)', VALUE],
        ['=ADDRESS(B6,3)', VALUE],
        ['=ADDRESS(1048576,16384)', '$XFD$1048576'],
        ['=ADDRESS(1048577,3)', VALUE],
        ['=ADDRESS(2,0)', VALUE],
        ['=ADDRESS(2,16385)', VALUE],
        ['=ADDRESS(2,12.5)', '$L$2'],
        ['=ADDRESS(TRUE,"3")', '$C$1'],
        ['=ADDRESS(2,3,1,TRUE,"my sheet")', "'my sheet'!$C$2"],
        ['=ADDRESS(2,3,1,FALSE,"my sheet")', "'my sheet'!R2C3"],
        ['=ADDRESS(2,3,1,TRUE,"it\'s")', "'it''s'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,"")', '!$C$2'],
        ['=ADDRESS(2,3,1,TRUE,B1)', '!$C$2'],
        ['=ADDRESS(2,3,1,TRUE,5)', "'5'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,TRUE)', "'TRUE'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,B5)', 'abc!$C$2'],
        ['=ADDRESS(2,3,1,TRUE,"A1")', "'A1'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,"R1C1")', "'R1C1'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,"1abc")', "'1abc'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,"sheet-1")', "'sheet-1'!$C$2"],
        ['=ADDRESS(2,3,1,TRUE,"é")', 'é!$C$2'],
        ['=ADDRESS(2,3,1,,"x")', 'x!$C$2'],
        ['=ADDRESS(B4,NA())', DIV0],
        ['=CONCAT(ADDRESS({1,2},{3;4}))', '$C$1$C$2$D$1$D$2'],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, BATCH)).toBe(expected);
    });
});

describe('HYPERLINK', () => {
    test.each([
        ['=HYPERLINK("http://example.com")', 'http://example.com'],
        ['=HYPERLINK("http://example.com","Friendly")', 'Friendly'],
        ['=HYPERLINK(5)', '5'],
        ['=HYPERLINK(B1)', ''],
        ['=HYPERLINK(5,6)', 6],
        ['=HYPERLINK("x",TRUE)', true],
        ['=HYPERLINK("x",B1)', 0],
        ['=HYPERLINK("x",B1)&""', '0'],
        ['=HYPERLINK("x",)', 0],
        ['=HYPERLINK("x",B6)', ''],
        ['=HYPERLINK(,"Friendly")', 'Friendly'],
        ['=HYPERLINK(B4,"Friendly")', DIV0],
        ['=HYPERLINK("x",B7)', NA],
        ['=HYPERLINK(B4,NA())', DIV0],
        ['=HYPERLINK(HYPERLINK("a","b"))', 'b'],
        ['=CONCAT(HYPERLINK("x",{"p";"q"}))', 'pq'],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, BATCH)).toBe(expected);
    });

    test('a link alone is refused past 255 characters, a friendly name is not', () => {
        const long = { F1: 'y'.repeat(300) };
        expect(evaluate('=HYPERLINK("x"&F1)', long)).toBe(VALUE);
        expect(evaluate('=LEN(HYPERLINK("x",F1))', long)).toBe(300);
        // Excel check: only the 301 characters are recorded, the bound and a long link beside a name are not.
        expect(evaluate('=LEN(HYPERLINK(F1))', { F1: 'y'.repeat(255) })).toBe(255);
        expect(evaluate('=HYPERLINK(F1)', { F1: 'y'.repeat(256) })).toBe(VALUE);
        expect(evaluate('=HYPERLINK(F1,"f")', long)).toBe('f');
    });
});

describe('what Excel records for the lookups on its own cells', () => {
    test.each([
        // A size is cut toward zero after its sign is taken, so half a row is the corner's row and the one before.
        ['=SUM(ROW(OFFSET(B2,0,0,0.5,1)))', 3],
        ['=SUM(ROW(OFFSET(B2,0,0,-0.5,1)))', 5],
        ['=SUM(COLUMN(OFFSET(B2,0,0,1,0.5)))', 3],
        ['=ROWS(OFFSET(B2,0,0,1.9,1.9))', 1],
        ['=ROWS(OFFSET(B2,0,0,-2,-2))', 2],
        ['=SUM(OFFSET(A1,5,0,-3,1))', 1e300],
        ['=OFFSET(B2,0,0,0,1)', REF],
        ['=OFFSET(B2,0,0,1,0)', REF],
        ['=OFFSET(B2,0,0,B1,2)', REF],
        ['=SUM(OFFSET(A1,0,0,"2",TRUE))', -1],
        ['=SUM(OFFSET(B2,0,0,,2))', 4],
        // Excel check: the half row before the first row.
        ['=OFFSET(A1,0,0,0.5,1)', REF],
        // One index into a range of several rows and columns is refused, into an array it is a row.
        ['=INDEX(A1:C3,2)', REF],
        ['=INDEX(A1:C3,0)', REF],
        ['=INDEX(A1:C3,-1)', VALUE],
        ['=INDEX(A1:A3,2)', -2.5],
        ['=INDEX((A1:A2,C1:C3),1)', 1.5],
        ['=SUM(INDEX({1,2;3,4},1))', 3],
        ['=SUM(INDEX(A1:C3,2,))', 1.5],
        // A key that is not found is #N/A before a column or row the table lacks is #REF!.
        ['=VLOOKUP("k2",A1:A5,2,FALSE)', NA],
        ['=VLOOKUP("k2",B2,2,FALSE)', NA],
        ['=VLOOKUP(30,E1:E4,2,FALSE)', REF],
        ['=HLOOKUP(2,B1,2,FALSE)', NA],
        ['=HLOOKUP(2,A1:E4,5,FALSE)', REF],
        // Excel check: a key that is not found with an index below 1.
        ['=VLOOKUP("zz",D1:E4,0,FALSE)', VALUE],
        ['=LOOKUP(4,C1:C3,{1,0;TRUE,"x"})', NA],
        ['=LOOKUP(4,C1:C3,D1:E4)', NA],
        ['=LOOKUP(4,C1:C3,(A1:A2,C1:C2))', NA],
        ['=LOOKUP(4,C1:C3,E1:E3)', 20],
        // A mark sorts before a digit, so "k?" is below every key of the list.
        ['=LOOKUP("k?",D1:D4,E1:E4)', NA],
        ['=MATCH("k?",D1:D4)', NA],
        // A search mode is cut down, so -2.5 is no mode.
        ['=XMATCH(2,C1:C3,0,-2.5)', VALUE],
        ['=XMATCH(4,C1:C3,0,1.9)', 2],
        ['=XLOOKUP("k2",D1:D4,E1:E4,"nf",0,-2.5)', VALUE],
        ['=XLOOKUP("k2",D1:D4,E1:E4,"nf",0,1.9)', 20],
        // Excel check: a search mode between -1 and 0.
        ['=XMATCH(2,C1:C3,0,-0.5)', 1],
        ['=XLOOKUP("k2",D1:D4,(E1:E2,E3:E4))', NA],
        // One cell to search goes with a result of one column as well as with one of one row; a range of
        // another size than the result is refused whether or not the key is in it.
        ['=XLOOKUP("k2",B5,E1:E4,"nf")', 'nf'],
        ['=XLOOKUP("k2",5,E1:E4)', NA],
        ['=XLOOKUP("k2",A1:A5,E1:E4,"nf")', VALUE],
        ['=XLOOKUP("k2",D1:D4,E1)', VALUE],
        ['=XLOOKUP("k2",D1:D3,E1:E4)', VALUE],
        // Excel check: one cell that holds the key, beside a result of one column and of one row.
        ['=SUM(XLOOKUP("abc",B5,E1:E4))', 100],
        ['=SUM(XLOOKUP("abc",B5,C1:E1))', 12],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, BATCH)).toBe(expected);
    });
});
