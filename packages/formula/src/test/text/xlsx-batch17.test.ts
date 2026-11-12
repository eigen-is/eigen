import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { isLegacy } from '../../text';
import { treeA1 } from './support';
import { bar, fileOf, read } from './xlsx-support';

// Excel's own answers, recorded in batch 17 of the oracle (Excel for the web, 12 November 2026), row n in cell
// G1, G13, G25 and so on. Per row: the formula as typed, the mark Excel saved it with, the text of its <f>, and
// what Excel's formula bar shows when that text is opened from a plain <f>.
const ROWS: readonly (readonly [typed: string, mark: 'plain' | 'array', file: string, bar: string])[] = [
    ['INDEX(A1:A10,E1)', 'array', 'INDEX(A1:A10,E1)', '=@INDEX(A1:A10,E1)'],
    ['INDEX(A1:C10,0,2)', 'array', 'INDEX(A1:C10,0,2)', '=@INDEX(A1:C10,0,2)'],
    ['INDEX(A1:C10,E1,0)', 'array', 'INDEX(A1:C10,E1,0)', '=@INDEX(A1:C10,E1,0)'],
    ['INDEX(A1:C10,E1,2)', 'array', 'INDEX(A1:C10,E1,2)', '=@INDEX(A1:C10,E1,2)'],
    ['INDEX(A1:A10*2,E1)', 'array', 'INDEX(A1:A10*2,E1)', '=@INDEX(A1:A10*2,E1)'],
    ['SUM(INDEX(A1:C10,0,2))', 'plain', 'SUM(INDEX(A1:C10,0,2))', '=SUM(INDEX(A1:C10,0,2))'],
    [
        'INDEX(B1:B10,MATCH(E1,A1:A10,0))',
        'plain',
        'INDEX(B1:B10,MATCH(E1,A1:A10,0))',
        '=INDEX(B1:B10,MATCH(E1,A1:A10,0))',
    ],
    [
        'INDEX(B1:B10,MATCH(1,(A1:A10=3)*(B1:B10=30),0))',
        'array',
        'INDEX(B1:B10,MATCH(1,(A1:A10=3)*(B1:B10=30),0))',
        '=INDEX(B1:B10,MATCH(1,(@A1:A10=3)*(@B1:B10=30),0))',
    ],
    ['MATCH(30,B1:B10*1,0)', 'array', 'MATCH(30,B1:B10*1,0)', '=MATCH(30,@B1:B10*1,0)'],
    ['MATCH(E1,A1:A10,0)', 'plain', 'MATCH(E1,A1:A10,0)', '=MATCH(E1,A1:A10,0)'],
    ['VLOOKUP(E1,A1:B10,2,FALSE)', 'plain', 'VLOOKUP(E1,A1:B10,2,FALSE)', '=VLOOKUP(E1,A1:B10,2,FALSE)'],
    ['VLOOKUP(E1,A1:B10*1,2,FALSE)', 'array', 'VLOOKUP(E1,A1:B10*1,2,FALSE)', '=VLOOKUP(E1,@A1:B10*1,2,FALSE)'],
    ['HLOOKUP(1,A1:B10*1,3,FALSE)', 'array', 'HLOOKUP(1,A1:B10*1,3,FALSE)', '=HLOOKUP(1,@A1:B10*1,3,FALSE)'],
    ['LOOKUP(E1,A1:A10*1,B1:B10)', 'array', 'LOOKUP(E1,A1:A10*1,B1:B10)', '=LOOKUP(E1,A1:A10*1,B1:B10)'],
    ['LOOKUP(2,1/(A1:A10<5),B1:B10)', 'array', 'LOOKUP(2,1/(A1:A10<5),B1:B10)', '=LOOKUP(2,1/(A1:A10<5),B1:B10)'],
    ['XLOOKUP(E1,A1:A10,B1:B10)', 'plain', '_xlfn.XLOOKUP(E1,A1:A10,B1:B10)', '=XLOOKUP(E1,A1:A10,B1:B10)'],
    ['XLOOKUP(E1,A1:A10,B1:C10)', 'array', '_xlfn.XLOOKUP(E1,A1:A10,B1:C10)', '=@XLOOKUP(E1,A1:A10,B1:C10)'],
    ['XLOOKUP(E1,A1:A10*1,B1:B10)', 'array', '_xlfn.XLOOKUP(E1,A1:A10*1,B1:B10)', '=@XLOOKUP(E1,A1:A10*1,B1:B10)'],
    ['XMATCH(30,B1:B10*1)', 'array', '_xlfn.XMATCH(30,B1:B10*1)', '=XMATCH(30,B1:B10*1)'],
    ['SUMIF(A1:A10,">5",B1:B10)', 'plain', 'SUMIF(A1:A10,">5",B1:B10)', '=SUMIF(A1:A10,">5",B1:B10)'],
    ['SUMPRODUCT(A1:A10,B1:B10)', 'plain', 'SUMPRODUCT(A1:A10,B1:B10)', '=SUMPRODUCT(A1:A10,B1:B10)'],
    ['SUMPRODUCT((A1:A10>5)*B1:B10)', 'array', 'SUMPRODUCT((A1:A10>5)*B1:B10)', '=SUMPRODUCT((A1:A10>5)*B1:B10)'],
    ['COUNTIF(A1:A10,A1:A10)', 'array', 'COUNTIF(A1:A10,A1:A10)', '=COUNTIF(A1:A10,@A1:A10)'],
    ['SUM(IF(A1:A10>5,B1:B10))', 'array', 'SUM(IF(A1:A10>5,B1:B10))', '=SUM(IF(@A1:A10>5,B1:B10))'],
    ['MAX(ABS(A1:A10-5))', 'array', 'MAX(ABS(A1:A10-5))', '=MAX(ABS(@A1:A10-5))'],
    ['AND(A1:A10>0)', 'array', 'AND(A1:A10>0)', '=AND(@A1:A10>0)'],
    ['CONCAT(C1:C10&"-")', 'array', '_xlfn.CONCAT(C1:C10&"-")', '=CONCAT(@C1:C10&"-")'],
    [
        'TEXTJOIN(",",TRUE,C1:C10&"x")',
        'array',
        '_xlfn.TEXTJOIN(",",TRUE,C1:C10&"x")',
        '=TEXTJOIN(",",TRUE,@C1:C10&"x")',
    ],
    ['SQRT(A1:A10)', 'array', 'SQRT(A1:A10)', '=SQRT(@A1:A10)'],
    ['A1:A10', 'array', 'A1:A10', '=@A1:A10'],
    ['A1:A10+1', 'array', 'A1:A10+1', '=@A1:A10+1'],
    ['OFFSET(A1,0,0,3,1)', 'array', 'OFFSET(A1,0,0,3,1)', '=@OFFSET(A1,0,0,3,1)'],
    ['SUM(OFFSET(A1,0,0,3,1))', 'plain', 'SUM(OFFSET(A1,0,0,3,1))', '=SUM(OFFSET(A1,0,0,3,1))'],
    ['INDIRECT("A1:A3")', 'array', 'INDIRECT("A1:A3")', '=@INDIRECT("A1:A3")'],
    ['CHOOSE(2,A1:A10,B1:B10)', 'array', 'CHOOSE(2,A1:A10,B1:B10)', '=@CHOOSE(2,A1:A10,B1:B10)'],
    ['IF(E1>0,A1:A10,0)', 'array', 'IF(E1>0,A1:A10,0)', '=@IF(E1>0,A1:A10,0)'],
    ['IFERROR(A1:A10,0)', 'array', 'IFERROR(A1:A10,0)', '=IFERROR(@A1:A10,0)'],
    ['ROW(A1:A10)', 'array', 'ROW(A1:A10)', '=@ROW(A1:A10)'],
    ['ROWS(A1:A10)', 'plain', 'ROWS(A1:A10)', '=ROWS(A1:A10)'],
    ['LEN(C1:C10)', 'array', 'LEN(C1:C10)', '=LEN(@C1:C10)'],
    ['SUM(LEN(C1:C10))', 'array', 'SUM(LEN(C1:C10))', '=SUM(LEN(@C1:C10))'],
    ['N(A1:A10)', 'plain', 'N(A1:A10)', '=N(A1:A10)'],
    ['T(C1:C10)', 'plain', 'T(C1:C10)', '=T(C1:C10)'],
    ['TYPE(A1:A10)', 'array', 'TYPE(A1:A10)', '=TYPE(@A1:A10)'],
    ['ISNUMBER(A1:A10)', 'array', 'ISNUMBER(A1:A10)', '=ISNUMBER(@A1:A10)'],
    ['SUM(--ISNUMBER(A1:A10))', 'array', 'SUM(--ISNUMBER(A1:A10))', '=SUM(--ISNUMBER(@A1:A10))'],
    ['NORM.S.DIST(A1:A3,TRUE)', 'array', '_xlfn.NORM.S.DIST(A1:A3,TRUE)', '=NORM.S.DIST(@A1:A3,TRUE)'],
    ['SUM(NORM.S.DIST(A1:A3,TRUE))', 'array', 'SUM(_xlfn.NORM.S.DIST(A1:A3,TRUE))', '=SUM(NORM.S.DIST(@A1:A3,TRUE))'],
    ['TRANSPOSE(A1:A3)', 'array', 'TRANSPOSE(A1:A3)', '=@TRANSPOSE(@A1:A3)'],
    ['SUM(TRANSPOSE(A1:A3)*A1:A3)', 'array', 'SUM(TRANSPOSE(A1:A3)*A1:A3)', '=SUM(TRANSPOSE(@A1:A3)*@A1:A3)'],
];

// Where this build writes another mark than Excel, by row: each is plain here and an array formula in Excel.
const OUR_MARK: Record<number, string> = {
    14: 'an operator in an array parameter: the plain text gives the same 30 (part L)',
    15: 'as 14: the same 40',
    19: 'as 14: the same 3',
    22: 'as 14: the same 400',
    47: 'a range handed to a function the engine lacks: backlog',
    48: 'as 47',
};

// Where this build shows another formula bar than Excel for the plain <f>, by row.
const OUR_BAR: Record<number, string> = {
    44: '=TYPE(A1:A10)',
    47: '=NORM.S.DIST(A1:A3,TRUE)',
    48: '=SUM(NORM.S.DIST(A1:A3,TRUE))',
    49: '=@TRANSPOSE(A1:A3)',
    50: '=SUM(@TRANSPOSE(A1:A3)*@A1:A3)',
};

const host = (n: number) => `G${1 + 12 * (n - 1)}`;

describe("text/xlsx: Excel's mark for a typed formula (oracle batch 17, part T)", () => {
    ROWS.forEach(([typed, mark, file], index) => {
        const n = index + 1;
        const ours = n in OUR_MARK ? 'plain' : mark;
        test(`${n} ${typed} is ${ours}`, () => {
            const tree = treeA1(`=${typed}`, host(n));
            expect(isLegacy(tree, FUNCTIONS) ? 'plain' : 'array').toBe(ours);
            expect(fileOf(tree, host(n)).text).toBe(file);
        });
    });

    test('no row is an array formula here and plain in Excel', () => {
        for (const n of Object.keys(OUR_MARK)) expect(ROWS[Number(n) - 1][1]).toBe('array');
    });
});

describe('text/xlsx: where Excel puts the @ in a plain <f> (oracle batch 17, part L)', () => {
    ROWS.forEach(([, , file, excel], index) => {
        const n = index + 1;
        test(`${n} ${file} shows ${OUR_BAR[n] ?? excel}`, () => {
            expect(bar(file, host(n))).toBe(OUR_BAR[n] ?? excel);
            expect(fileOf(read(file, host(n)), host(n)).text).toBe(file);
        });
    });
});
