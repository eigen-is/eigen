import { describe, expect, spyOn, test } from 'bun:test';
import {
    EXCEL_2007_FUNCTIONS,
    EXCEL_ARRAY_FUNCTIONS,
    EXCEL_FUTURE_FUNCTIONS,
    EXCEL_WORKSHEET_FUNCTIONS,
} from '../../functions/excel-names';
import { FUNCTIONS } from '../../functions/library';
import {
    intersect,
    isLegacy,
    parseA1,
    parseStored,
    parseXlsx,
    printA1,
    printStored,
    printXlsx,
    typedText,
    xlsxTree,
} from '../../text';
import * as parser from '../../text/parser';
import { ShapeTable } from '../../text/shapes';
import { at, findSheet, sheetName, treeA1 } from './support';
import { bar, fileOf, intersected, read } from './xlsx-support';

// Excel's own answers, recorded in batch 15 of the oracle (Excel for the web, 12 November 2026). Part T: a formula
// typed into a cell, the mark Excel saved it with and the text of its <f>. `ours` is set where this build
// answers another mark than Excel, each one named in the test below the table.
const TYPED: readonly {
    row: string;
    host: string;
    typed: string;
    excel: 'plain' | 'array';
    file: string;
    ours?: 'plain' | 'array';
    oursFile?: string;
}[] = [
    { row: 'T1', host: 'D1', typed: 'SUM(A1:A3*B1:B3)', excel: 'array', file: 'SUM(A1:A3*B1:B3)' },
    {
        row: 'T2',
        host: 'D4',
        typed: 'SUMPRODUCT((A1:A3>1)*B1:B3)',
        excel: 'array',
        file: 'SUMPRODUCT((A1:A3>1)*B1:B3)',
        ours: 'plain',
    },
    {
        row: 'T3',
        host: 'D7',
        typed: 'SUMPRODUCT(--(LEN(A1:A3)>0))',
        excel: 'array',
        file: 'SUMPRODUCT(--(LEN(A1:A3)>0))',
        ours: 'plain',
    },
    {
        row: 'T4',
        host: 'D10',
        typed: 'SUMPRODUCT(IF(A1:A3>1,B1:B3,0))',
        excel: 'array',
        file: 'SUMPRODUCT(IF(A1:A3>1,B1:B3,0))',
    },
    {
        row: 'T5',
        host: 'D13',
        typed: 'INDEX(B1:B3,MATCH(1,(A1:A3=2)*(B1:B3=20),0))',
        excel: 'array',
        file: 'INDEX(B1:B3,MATCH(1,(A1:A3=2)*(B1:B3=20),0))',
    },
    {
        row: 'T6',
        host: 'D16',
        typed: 'MATCH(TRUE,INDEX(A1:A3>1,0),0)',
        excel: 'array',
        file: 'MATCH(TRUE,INDEX(A1:A3>1,0),0)',
        ours: 'plain',
    },
    {
        row: 'T7',
        host: 'D19',
        typed: 'LOOKUP(2,1/(A1:A3<>""),B1:B3)',
        excel: 'array',
        file: 'LOOKUP(2,1/(A1:A3<>""),B1:B3)',
        ours: 'plain',
    },
    {
        row: 'T8',
        host: 'D22',
        typed: 'VLOOKUP(2,A1:B3*1,2,FALSE)',
        excel: 'array',
        file: 'VLOOKUP(2,A1:B3*1,2,FALSE)',
    },
    { row: 'T9', host: 'D25', typed: 'OR(A1:A3=2)', excel: 'array', file: 'OR(A1:A3=2)' },
    { row: 'T10', host: 'D28', typed: 'INDEX(A1:B3,2,2)', excel: 'plain', file: 'INDEX(A1:B3,2,2)' },
    { row: 'T11', host: 'D31', typed: 'IF(A1>0,B1:B3,0)', excel: 'array', file: 'IF(A1>0,B1:B3,0)' },
    {
        row: 'T12',
        host: 'D34',
        typed: 'IFS(A1>0,"a",TRUE,"b")',
        excel: 'array',
        file: '_xlfn.IFS(A1>0,"a",TRUE,"b")',
        ours: 'plain',
    },
    { row: 'T13', host: 'D37', typed: 'XLOOKUP(A1,A:A,B:B)', excel: 'plain', file: '_xlfn.XLOOKUP(A1,A:A,B:B)' },
    { row: 'T14', host: 'D40', typed: 'N(A1:A3)', excel: 'plain', file: 'N(A1:A3)' },
    { row: 'T15', host: 'D43', typed: 'ROW(A1:A3)', excel: 'array', file: 'ROW(A1:A3)' },
    { row: 'T16', host: 'D46', typed: 'A1*{1,2,3}', excel: 'array', file: 'A1*{1,2,3}' },
    { row: 'T17', host: 'D49', typed: 'TRANSPOSE(A1:A3)', excel: 'array', file: 'TRANSPOSE(A1:A3)' },
    // The typed form, SUM((A1,@B1:B3)), is refused by the A1 reader, so this row is read from Excel's own file text.
    {
        row: 'T18',
        host: 'D52',
        typed: 'SUM((A1,_xlfn.SINGLE(B1:B3)))',
        excel: 'plain',
        file: 'SUM((A1,_xlfn.SINGLE(B1:B3)))',
    },
    {
        row: 'T19',
        host: 'D55',
        typed: 'LET(f,LAMBDA(x,x+1),f(2))',
        excel: 'array',
        file: '_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.f(2))',
    },
    {
        row: 'T20',
        host: 'D58',
        typed: 'BYROW(A1:B3,SUM)',
        excel: 'array',
        file: '_xlfn.BYROW(A1:B3,_xludf.SUM)',
        oursFile: '_xlfn.BYROW(A1:B3,SUM)',
    },
    {
        row: 'T21',
        host: 'D61',
        typed: 'BYROW(A1:B3,XLOOKUP)',
        excel: 'array',
        file: '_xlfn.BYROW(A1:B3,_xleta.XLOOKUP)',
        oursFile: '_xlfn.BYROW(A1:B3,XLOOKUP)',
    },
];

// Part L: a plain <f>, with no t and no cm, and what Excel's formula bar shows for it. `ours` is set where this
// build shows another text.
const LEGACY: readonly { row: string; host: string; file: string; excel: string; ours?: string }[] = [
    { row: 'L1', host: 'D1', file: 'SUM(A1:A3*B1:B3)', excel: '=SUM(@A1:A3*@B1:B3)' },
    { row: 'L2', host: 'D2', file: 'SUMPRODUCT((A1:A3>1)*B1:B3)', excel: '=SUMPRODUCT((A1:A3>1)*B1:B3)' },
    { row: 'L3', host: 'D3', file: 'SUMPRODUCT(--(LEN(A1:A3)>0))', excel: '=SUMPRODUCT(--(LEN(A1:A3)>0))' },
    { row: 'L4', host: 'D4', file: 'SUMPRODUCT(IF(A1:A3>1,B1:B3,0))', excel: '=SUMPRODUCT(IF(@A1:A3>1,B1:B3,0))' },
    {
        row: 'L5',
        host: 'D5',
        file: 'INDEX(B1:B3,MATCH(1,(A1:A3=2)*(B1:B3=20),0))',
        excel: '=INDEX(B1:B3,MATCH(1,(@A1:A3=2)*(@B1:B3=20),0))',
    },
    { row: 'L6', host: 'D6', file: 'LOOKUP(2,1/(A1:A3<>""),B1:B3)', excel: '=LOOKUP(2,1/(A1:A3<>""),B1:B3)' },
    {
        row: 'L7',
        host: 'D7',
        file: 'VLOOKUP(2,A1:B3*1,2,FALSE)',
        excel: '=VLOOKUP(2,@A1:B3*1,2,FALSE)',
    },
    { row: 'L8', host: 'D8', file: 'IF(A1>0,B1:B3,0)', excel: '=@IF(A1>0,B1:B3,0)' },
    { row: 'L9', host: 'D9', file: '_xlfn.XLOOKUP(A2,A:A,B:B)', excel: '=XLOOKUP(A2,A:A,B:B)' },
    { row: 'L10a', host: 'D10', file: 'ROW(A1:A3)', excel: '=@ROW(A1:A3)' },
    { row: 'L10b', host: 'D11', file: 'N(A1:A3)', excel: '=N(A1:A3)' },
    { row: 'L10c', host: 'D12', file: 'CHOOSE(2,A1:A3,B1:B3)', excel: '=@CHOOSE(2,A1:A3,B1:B3)' },
    { row: 'L11a', host: 'D13', file: 'A1*{1,2,3}', excel: '=A1*@{1,2,3}' },
    { row: 'L11b', host: 'D14', file: 'TRANSPOSE(A1:A3)', excel: '=@TRANSPOSE(@A1:A3)', ours: '=@TRANSPOSE(A1:A3)' },
    { row: 'L12a', host: 'D15', file: '_xlfn.SINGLE(A1)', excel: '=@A1' },
    {
        row: 'L12b',
        host: 'D16',
        file: 'NORM.S.DIST(0,TRUE)',
        excel: '=@NORM.S.DIST(0,TRUE)',
        ours: '=NORM.S.DIST(0,TRUE)',
    },
    { row: 'L12c', host: 'D17', file: '_XLUDF.FOO(1)', excel: '=@FOO(1)', ours: '=@_XLUDF.FOO(1)' },
    { row: 'L12d', host: 'D18', file: '_xlfn.NEWTHING(1)', excel: '=@_xlfn.NEWTHING(1)', ours: '=@_XLFN.NEWTHING(1)' },
    { row: 'L12e', host: 'D19', file: 'NEWTHING(1)', excel: '=@NEWTHING(1)' },
];

describe("text/xlsx: Excel's own mark for a typed formula (oracle batch 15, part T)", () => {
    for (const { row, host, typed, excel, file, ours, oursFile } of TYPED) {
        test(`${row} ${typed} is ${ours ?? excel}`, () => {
            const tree = row === 'T18' ? read(typed, host) : treeA1(`=${typed}`, host);
            expect(isLegacy(tree, FUNCTIONS) ? 'plain' : 'array').toBe(ours ?? excel);
            expect(fileOf(tree, host).text).toBe(oursFile ?? file);
        });
    }

    test("the rows where our mark is not Excel's are plain here, with the same value either way", () => {
        // An operator in an array parameter: T2, T3 and T7 are L2, L3 and L6, where Excel's plain reading gives the
        // same 50, 3 and 30, and T6 is the same INDEX in MATCH that plain files hold. T12 holds single cells only.
        const ours = TYPED.filter((row) => row.ours !== undefined);
        expect(ours.map(({ row }) => row)).toEqual(['T2', 'T3', 'T6', 'T7', 'T12']);
        for (const row of ours) expect([row.excel, row.ours]).toEqual(['array', 'plain']);
        expect(TYPED.filter(({ oursFile }) => oursFile !== undefined).map(({ row }) => row)).toEqual(['T20', 'T21']);
    });

    test('what Excel wrote for a typed formula reads back and is written the same', () => {
        for (const { host, file, excel } of TYPED) {
            const tree = read(file, host);
            expect(printXlsx(xlsxTree(tree, FUNCTIONS, excel === 'plain'), ...at(host), sheetName)).toBe(file);
        }
    });
});

describe('text/xlsx: where Excel puts the @ in a plain <f> (oracle batch 15, part L)', () => {
    for (const { row, host, file, excel, ours } of LEGACY) {
        test(`${row} ${file} shows ${ours ?? excel}`, () => {
            expect(bar(file, host)).toBe(ours ?? excel);
        });
    }

    test("the rows where our formula bar is not Excel's are the named ones", () => {
        expect(LEGACY.filter(({ ours }) => ours !== undefined).map(({ row }) => row)).toEqual([
            'L11b',
            'L12b',
            'L12c',
            'L12d',
        ]);
    });

    test('a plain <f> is written back as it was, and plain', () => {
        for (const { row, host, file } of LEGACY) {
            const out = fileOf(intersected(read(file, host)), host);
            if (row === 'L12b') expect(out).toEqual({ legacy: true, text: '_xlfn.NORM.S.DIST(0,TRUE)' });
            else if (row === 'L12c') expect(out).toEqual({ legacy: true, text: '_xludf.FOO(1)' });
            else expect(out).toEqual({ legacy: true, text: file });
        }
    });

    test('L13: an array formula is read without the pass, and its INDEX stays as it is', () => {
        expect(printA1(read('INDEX(A1:B3,2,2)', 'F2'), ...at('F2'), sheetName)).toBe('=INDEX(A1:B3,2,2)');
    });
});

describe('text/xlsx: the three contexts', () => {
    test('one value is wanted at the root, under an operator and at a value parameter', () => {
        expect(bar('A1:A10')).toBe('=@A1:A10');
        expect(bar('A:A')).toBe('=@A:A');
        expect(bar('A1:A3*2')).toBe('=@A1:A3*2');
        expect(bar('-A1:A3')).toBe('=-@A1:A3');
        expect(bar('A1:A3%')).toBe('=@A1:A3%');
        expect(bar('(A1:A3)')).toBe('=(@A1:A3)');
        expect(bar('2*(MyUdf(1))')).toBe('=2*(@MYUDF(1))');
        expect(bar('IF(A1,(B1:B3),0)')).toBe('=@IF(A1,(B1:B3),0)');
        expect(bar('(A1:A3,B1)*2')).toBe('=@(A1:A3,B1)*2');
        expect(bar('SQRT(A1:A4)')).toBe('=SQRT(@A1:A4)');
        expect(bar('COUNTIF(A1:A10,B1:B3)')).toBe('=COUNTIF(A1:A10,@B1:B3)');
        expect(bar('A1:A3 A2:C2')).toBe('=@A1:A3 A2:C2');
        expect(bar('A1:INDEX(B:B,5)')).toBe('=@A1:INDEX(B:B,5)');
        expect(bar('A1#')).toBe('=@A1#');
    });

    test('a reference parameter takes a range as it is, and an operator under it wants one value again', () => {
        expect(bar('SUM(A1:A10)')).toBe('=SUM(A1:A10)');
        expect(bar('SUM(A1#)')).toBe('=SUM(A1#)');
        expect(bar('SUM(-A1:A3)')).toBe('=SUM(-@A1:A3)');
        expect(bar('SUM(--(A1:A10>3))')).toBe('=SUM(--(@A1:A10>3))');
        expect(bar('MAX(A1:A3*B1:B3)')).toBe('=MAX(@A1:A3*@B1:B3)');
        expect(bar('AND(A1:A10>0)')).toBe('=AND(@A1:A10>0)');
        expect(bar('COUNT(1/(A1:A10>0))')).toBe('=COUNT(1/(@A1:A10>0))');
        expect(bar('SUM(ABS(A1:A3))')).toBe('=SUM(ABS(@A1:A3))');
        expect(bar('SUM((A1:A3,B1:B3))')).toBe('=SUM((A1:A3,B1:B3))');
    });

    test('an array parameter keeps an array through operators and value parameters, and ends at a call that picks', () => {
        expect(bar('SUMPRODUCT(ABS(A1:A3))')).toBe('=SUMPRODUCT(ABS(A1:A3))');
        expect(bar('SUMPRODUCT((A1:A10>5)*B1:B10,-C1:C10%)')).toBe('=SUMPRODUCT((A1:A10>5)*B1:B10,-C1:C10%)');
        expect(bar('SUMPRODUCT(IFERROR(A1:A3/B1:B3,0))')).toBe('=SUMPRODUCT(IFERROR(@A1:A3/@B1:B3,0))');
        expect(bar('SUMPRODUCT(SUM(A1:A3*2))')).toBe('=SUMPRODUCT(SUM(@A1:A3*2))');
    });

    test('a call that picks an argument is cut as a whole, and a function that answers a place gets the @ itself', () => {
        expect(bar('IF(A1>0,B1:B10,0)+1')).toBe('=@IF(A1>0,B1:B10,0)+1');
        expect(bar('IF(A1>0,B1:B3*2,0)')).toBe('=IF(A1>0,@B1:B3*2,0)');
        expect(bar('IFERROR(A1:A3,0)')).toBe('=IFERROR(@A1:A3,0)');
        expect(bar('IFERROR(A1,B1:B3)')).toBe('=@IFERROR(A1,B1:B3)');
        expect(bar('SUM(IF(A1>0,B1:B10,C1:C10))')).toBe('=SUM(IF(A1>0,B1:B10,C1:C10))');
        expect(bar('OFFSET(A1,1,1)')).toBe('=@OFFSET(A1,1,1)');
        expect(bar('SUM(OFFSET(A1,1,1,3,1))')).toBe('=SUM(OFFSET(A1,1,1,3,1))');
        expect(bar('INDIRECT("A1")&"x"')).toBe('=@INDIRECT("A1")&"x"');
        expect(bar('ROW()+ROW(A1)+COLUMN(A1:C1)')).toBe('=ROW()+ROW(A1)+@COLUMN(A1:C1)');
        expect(bar('ABS(INDEX(A1:C10,2,3))')).toBe('=ABS(INDEX(A1:C10,2,3))');
    });

    test('an array constant under a value parameter stays, and so does an argument past the last parameter', () => {
        expect(bar('ABS({1,2,3})+SUM(ABS({1,2,3}))')).toBe('=ABS({1,2,3})+SUM(ABS({1,2,3}))');
        expect(bar('ABS(A1:A3,B1:B3)+PI(A1:A3)')).toBe('=ABS(@A1:A3,B1:B3)+PI(A1:A3)');
    });

    test('INDEX is one cell when each index is a number but 0 or a call of one value, XLOOKUP along one line', () => {
        expect(bar('INDEX(A:A,MATCH(B1,C:C,0))+INDEX(A1:C3,2,3)+INDEX(A1:C3,ROW(),2)')).toBe(
            '=INDEX(A:A,MATCH(B1,C:C,0))+INDEX(A1:C3,2,3)+INDEX(A1:C3,ROW(),2)',
        );
        expect(bar('INDEX(A:A,B1)')).toBe('=@INDEX(A:A,B1)');
        expect(bar('INDEX(A1:C3,,2)+INDEX(A1:C3,2,0)+INDEX(A:A,Rate)+INDEX(A:A,B1+1)')).toBe(
            '=@INDEX(A1:C3,,2)+@INDEX(A1:C3,2,0)+@INDEX(A:A,Rate)+@INDEX(A:A,B1+1)',
        );
        expect(bar('INDEX(A:A,INDEX(B:B,C1))+INDEX(A:A,ROW(B1:B3))')).toBe(
            '=@INDEX(A:A,@INDEX(B:B,C1))+@INDEX(A:A,@ROW(B1:B3))',
        );
        expect(bar('SUM(INDEX(A1:C10,0,2))&INDEX(A1:A3>1,2)')).toBe('=SUM(INDEX(A1:C10,0,2))&INDEX(A1:A3>1,2)');
        expect(bar('_xlfn.XLOOKUP(A1,B:B,C:C)+_xlfn.XLOOKUP(A1,$B$1:$B$9,C1:C9)+_xlfn.XLOOKUP(A1,B1:J1,B2:J2)')).toBe(
            '=XLOOKUP(A1,B:B,C:C)+XLOOKUP(A1,$B$1:$B$9,C1:C9)+XLOOKUP(A1,B1:J1,B2:J2)',
        );
        expect(bar('_xlfn.XLOOKUP(A1,B:B,C:D)+_xlfn.XLOOKUP(A1,B1,C1:D1)+_xlfn.XLOOKUP(A1,B:B,Rate)')).toBe(
            '=@XLOOKUP(A1,B:B,C:D)+@XLOOKUP(A1,B1,C1:D1)+@XLOOKUP(A1,B:B,Rate)',
        );
        expect(bar('_xlfn.XLOOKUP(A1,B:B,$C1:C$9)+_xlfn.XLOOKUP(A1,B:B,C:C,D1:D3)')).toBe(
            '=@XLOOKUP(A1,B:B,$C1:C$9)+@XLOOKUP(A1,B:B,C:C,D1:D3)',
        );
    });

    test('a function that answers a part of its table is many cells unless its form is known to answer one', () => {
        const index = FUNCTIONS.get('INDEX');
        if (!index) throw new Error('no INDEX');
        const functions = new Map(FUNCTIONS).set('SLICE', index);
        const cut = intersect(read('ABS(SLICE(A1:B3,1,1))+ABS(INDEX(A1:B3,1,1))'), functions);
        if ('reason' in cut) throw new Error(cut.reason);
        expect(printA1(cut, ...at('D2'), sheetName)).toBe('=ABS(@SLICE(A1:B3,1,1))+ABS(INDEX(A1:B3,1,1))');
    });

    test('a user function gets the @ and takes its arguments as they are; a name and a single cell get none', () => {
        expect(bar('MyUdf(A1:A3)+1')).toBe('=@MYUDF(A1:A3)+1');
        expect(bar('[1]!Func(A1:A3)')).toBe('=@[1]!Func(A1:A3)');
        expect(bar('MyName*2+A1+Sheet2!B5')).toBe('=MyName*2+A1+Sheet2!B5');
        expect(bar('{1,2,3}')).toBe('=@{1,2,3}');
        expect(bar('SUM(A1*{1,2,3})')).toBe('=SUM(A1*{1,2,3})');
        expect(bar('SUM(COUNTIFS(A1:F1,{"bar","baz"}))')).toBe('=SUM(COUNTIFS(A1:F1,{"bar","baz"}))');
    });

    test('nothing inside LET or LAMBDA gets an @, and the whitespace before a cut node moves to its @', () => {
        expect(bar('_xlfn.LET(_xlpm.x,A1:A3,ABS(_xlpm.x)+ABS(B1:B3))')).toBe('=LET(x,A1:A3,ABS(x)+ABS(B1:B3))');
        expect(bar('1+ A1:A3')).toBe('=1+ @A1:A3');
        expect(bar('ABS(\n A1 :A3)')).toBe('=ABS(\n @A1 :A3)');
    });

    test('the pass does nothing to a tree it already ran over', () => {
        for (const { file, host } of LEGACY) {
            const once = intersected(read(file, host));
            expect(intersected(once)).toBe(once);
        }
    });
});

describe('text/xlsx: which mark a typed formula is written with', () => {
    const mark = (typed: string) => (isLegacy(treeA1(`=${typed}`, 'D2'), FUNCTIONS) ? 'plain' : 'array');

    test('a formula old Excel computes to the same value is plain', () => {
        for (const typed of [
            'SUM(A1:A3)',
            'A1+B1',
            'VLOOKUP(A1,B:C,2,FALSE)',
            'INDEX(A:A,MATCH(B1,C:C,0))',
            '@A1:A3',
        ]) {
            expect(mark(typed)).toBe('plain');
        }
        for (const typed of ['SUMPRODUCT((A1:A3>1)*B1:B3)', 'SUM(@A1:A3)', '@SUM(A1:A3)', 'IFERROR(INDEX(A:A,3),"")']) {
            expect(mark(typed)).toBe('plain');
        }
    });

    test('a range where old Excel would cut it to one value is an array formula', () => {
        for (const typed of ['A1:A3', 'ABS(A1:A3)', 'SUM(--(A1:A10>3))', 'MAX(A1:A3*B1:B3)', 'AND(A1:A10>0)']) {
            expect(mark(typed)).toBe('array');
        }
        for (const typed of ['OFFSET(A1,1,1)', 'INDIRECT("A1")', 'MyUdf(1)', 'A1#', 'CHOOSE(2,A1:A3,B1:B3)']) {
            expect(mark(typed)).toBe('array');
        }
    });

    test('where the rule cannot tell, the formula is an array formula: the named set', () => {
        // A range, or an operator on one, under a parameter whose records do not say how old Excel read it.
        expect(mark('TYPE(A1:A10)')).toBe('array');
        expect(mark('ISREF(A1:A10)')).toBe('array');
        expect(mark('TYPE(A1)+N(A1:A10)&T(A1:A10)')).toBe('plain');
        expect(mark('SUMXMY2(A1:A3*2,B1:B3)')).toBe('array');
        expect(mark('N(A1:A3*2)')).toBe('array');
        expect(bar('TYPE(A1:A10)+SUMXMY2(A1:A3*2,B1:B3)')).toBe('=TYPE(A1:A10)+SUMXMY2(A1:A3*2,B1:B3)');
        // A function of Excel's that the engine lacks and that answers an array.
        for (const typed of [
            'TRANSPOSE(A1:C1)',
            'UNIQUE(A1:A9)',
            'SEQUENCE(3)',
            'SORT(A1:A9)',
            'FILTER(A1:A9,B1:B9)',
        ]) {
            expect(mark(typed)).toBe('array');
        }
        // LET and LAMBDA, which no Excel without dynamic arrays has.
        expect(mark('LET(x,1,x+1)')).toBe('array');
        expect(mark('LAMBDA(x,x+1)(2)')).toBe('array');
    });

    test('a function the engine lacks takes its arguments as they stand: the accepted loss', () => {
        expect(mark('NPV(A1,B1:B9)')).toBe('plain');
        expect(mark('NORM.S.DIST(A1:A10,TRUE)')).toBe('plain');
        expect(bar('NORM.S.DIST(A1:A10,TRUE)')).toBe('=NORM.S.DIST(A1:A10,TRUE)');
    });

    test('a typed @ that old Excel would add is dropped, and any other is written as SINGLE', () => {
        const written = (typed: string) => fileOf(treeA1(`=${typed}`, 'D2'), 'D2');
        expect(written('@A1:A3')).toEqual({ legacy: true, text: 'A1:A3' });
        expect(written('ABS( @A1:A3)')).toEqual({ legacy: true, text: 'ABS( A1:A3)' });
        expect(written('@A1')).toEqual({ legacy: true, text: '_xlfn.SINGLE(A1)' });
        expect(written('SUM(@A1:A3)')).toEqual({ legacy: true, text: 'SUM(_xlfn.SINGLE(A1:A3))' });
        expect(written('@SUM(A1:A3)')).toEqual({ legacy: true, text: '_xlfn.SINGLE(SUM(A1:A3))' });
        expect(written('@@A1:A3')).toEqual({ legacy: true, text: '_xlfn.SINGLE(_xlfn.SINGLE(A1:A3))' });
        expect(written('@A1:A3+B1:B3')).toEqual({ legacy: false, text: '_xlfn.SINGLE(A1:A3)+B1:B3' });
        expect(written('@(A1+B1)')).toEqual({ legacy: true, text: '_xlfn.SINGLE((A1+B1))' });
        expect(written('@(A1:A3)')).toEqual({ legacy: true, text: '_xlfn.SINGLE((A1:A3))' });
        expect(written('(@A1:A3)')).toEqual({ legacy: true, text: '(A1:A3)' });
        expect(written('SUM(@(A1,B1))+@(A1,B1)')).toEqual({ legacy: true, text: 'SUM(_xlfn.SINGLE((A1,B1)))+(A1,B1)' });
        expect(written('(@A1,B1)')).toEqual({ legacy: true, text: '(_xlfn.SINGLE((A1,B1)))' });
        expect(written('SUM(A1#)+@A1:A2')).toEqual({ legacy: true, text: 'SUM(_xlfn.ANCHORARRAY(A1))+A1:A2' });
    });
});

describe('text/xlsx: the file spellings', () => {
    const round = (text: string, legacy = false, host = 'E5') =>
        printXlsx(xlsxTree(read(text, host), FUNCTIONS, legacy), ...at(host), sheetName);
    const shown = (text: string, host = 'E5') => printA1(read(text, host), ...at(host), sheetName);

    test('a text with no = reads, and printXlsx writes none', () => {
        expect(shown('A1+1')).toBe('=A1+1');
        expect(printXlsx(treeA1('=SUM(A1:B2)*Sheet2!$C$1'), ...at('N1'), sheetName)).toBe('SUM(A1:B2)*Sheet2!$C$1');
        expect(printStored(read('A1+1', 'A1'))).toBe(printStored(treeA1('=A1+1', 'A1')));
    });

    test('_xlfn. and _xlfn._xlws. go on reading and come back on writing, from the one inventory', () => {
        expect(shown('_xlfn.XLOOKUP(A1,B:B,C:C)+_xlfn._xlws.FILTER(A:A,B:B)+_XLFN.concat(1,2)')).toBe(
            '=XLOOKUP(A1,B:B,C:C)+FILTER(A:A,B:B)+CONCAT(1,2)',
        );
        expect(round('_xlfn.IFNA(SUM(A1:A2),_xlfn.XLOOKUP(1,B:B,C:C))+_xlfn._xlws.SORT(D1:D3)')).toBe(
            '_xlfn.IFNA(SUM(A1:A2),_xlfn.XLOOKUP(1,B:B,C:C))+_xlfn._xlws.SORT(D1:D3)',
        );
        for (const name of EXCEL_WORKSHEET_FUNCTIONS) expect(EXCEL_FUTURE_FUNCTIONS.has(name)).toBe(true);
    });

    test('a new function a producer wrote bare gets its prefix', () => {
        expect(round('NORM.S.DIST(A1,TRUE)+FILTER(A:A,B:B)+_xlfn.SORT(A:A)')).toBe(
            '_xlfn.NORM.S.DIST(A1,TRUE)+_xlfn._xlws.FILTER(A:A,B:B)+_xlfn._xlws.SORT(A:A)',
        );
    });

    test('_xlfn. on a name the inventory lacks stays, byte for byte, and so do the other prefixes', () => {
        for (const text of [
            '_xlfn.NEWTHING(1)',
            '_xlfn.ORG.LIBREOFFICE.ROUNDSIG(A1,2)',
            '_xlfn._xlws.NEWTHING(1)',
            '_xlfn.SUM(1)',
            '_xlfn._xlws.XLOOKUP(1)',
            '_xludf.FOO(A1)',
            '_xll.ADDIN(A1)',
            '__xludf.DUMMYFUNCTION("x")',
            '_xlfn.BYROW(A1:B3,_xleta.XLOOKUP)',
            '_xlfn.BYROW(A1:B3,_xludf.SUM)',
        ]) {
            expect(round(text)).toBe(text);
        }
        expect(shown('_xlfn.NEWTHING(1)')).toBe('=_XLFN.NEWTHING(1)');
    });

    test('a prefix with no name after it is a function no one has, and comes back as it was', () => {
        for (const text of ['_xlfn.(1)', '1+_xlfn._xlws.(1)', 'SUM(_xlpm.(1))', '_xludf.()']) {
            expect(round(text)).toBe(text);
            expect(parseStored(printStored(read(text, 'E5')))).toEqual(read(text, 'E5'));
        }
    });

    test('SINGLE and ANCHORARRAY are @ and #, with or without the prefix, and stable over read, write, read', () => {
        expect(shown('_xlfn.SINGLE(A1:A3)+_xlfn.ANCHORARRAY(B1)')).toBe('=@A1:A3+B1#');
        for (const text of ['SINGLE(A1:A3)', 'ANCHORARRAY(A1)', '_xlfn.SINGLE(_xlfn.ANCHORARRAY(A1))']) {
            const tree = read(text, 'E5');
            const written = round(text);
            expect(written.includes('_xlfn.')).toBe(true);
            expect(printStored(read(written, 'E5'))).toBe(printStored(tree));
            expect(round(written)).toBe(written);
        }
        expect(shown('_xlfn.SINGLE(A1,B1)+_xlfn.ANCHORARRAY()')).toBe('=SINGLE(A1,B1)+ANCHORARRAY()');
        expect(round('1+ _xlfn.SINGLE( A1)* _xlfn.ANCHORARRAY(B1)')).toBe(
            '1+ _xlfn.SINGLE( A1)* _xlfn.ANCHORARRAY(B1)',
        );
    });

    test('_xlpm. goes on a bound name and on a bound name that is called, and a LET name binds from the next pair', () => {
        const lambda = '_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.f(2))';
        expect(shown(lambda)).toBe('=LET(f,LAMBDA(x,x+1),F(2))');
        expect(round(lambda)).toBe(lambda);
        expect(round('_xlfn.LET(_xlpm.x,x,_xlpm.x)')).toBe('_xlfn.LET(_xlpm.x,x,_xlpm.x)');
        expect(round('_xlfn.LET(_xlpm.a,1,_xlpm.b,_xlpm.a+b,_xlpm.a*_xlpm.b)+a')).toBe(
            '_xlfn.LET(_xlpm.a,1,_xlpm.b,_xlpm.a+b,_xlpm.a*_xlpm.b)+a',
        );
        expect(round('_xlfn.LAMBDA(_xlpm.a,_xlop.b,_xlpm.a+_xlpm.b)(1,2)')).toBe(
            '_xlfn.LAMBDA(_xlpm.a,_xlop.b,_xlpm.a+_xlpm.b)(1,2)',
        );
        expect(round('LET(Rate,1,rate*2)+Rate')).toBe('_xlfn.LET(_xlpm.Rate,1,_xlpm.Rate*2)+Rate');
    });

    // Batch 18 of the oracle: what Excel wrote for a typed LET or LAMBDA. Row 9 is read from the file only: typed
    // here, a:b is the columns A to B. Rows 10, 16 and 17 (the names a1, true and x.y) Excel kept as text.
    const BOUND: readonly (readonly [row: number, typed: string, file: string])[] = [
        [1, 'LET(x,1,x+1)', '_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'],
        [2, 'LET(sum,1,sum+1)', '_xlfn.LET(_xlpm.sum,1,_xlpm.sum+1)'],
        [3, 'LET(sum,SUM(A1:A3),sum*2)', '_xlfn.LET(_xlpm.sum,SUM(A1:A3),_xlpm.sum*2)'],
        [4, 'LET(sum,SUM(A1:A3),SUM(B1:B3)/sum)', '_xlfn.LET(_xlpm.sum,SUM(A1:A3),SUM(B1:B3)/_xlpm.sum)'],
        [5, 'LET(f,LAMBDA(x,x+1),f(2))', '_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.f(2))'],
        [6, 'LET(sum,LAMBDA(x,x+1),sum(2))', '_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),SUM(2))'],
        [7, 'LET(max,5,max)', '_xlfn.LET(_xlpm.max,5,_xlpm.max)'],
        [8, 'LET(index,2,INDEX(A1:A3,index))', '_xlfn.LET(_xlpm.index,2,INDEX(A1:A3,_xlpm.index))'],
        [9, '', '_xlfn.LET(_xlpm.a,A1,_xlpm.b,B3,SUM(_xlpm.a:_xlpm.b))'],
        [11, 'LET(r,2,c,3,r*c)', '_xlfn.LET(_xlpm.r,2,_xlpm.c,3,_xlpm.r*_xlpm.c)'],
        [12, 'LET(rate,2,rate*A1)', '_xlfn.LET(_xlpm.rate,2,_xlpm.rate*A1)'],
        [13, 'LET(x,A1:A3,x x)', '_xlfn.LET(_xlpm.x,A1:A3,_xlpm.x _xlpm.x)'],
        [14, 'LAMBDA(sum,sum+1)(2)', '_xlfn.LAMBDA(_xlpm.sum,_xlpm.sum+1)(2)'],
        [15, 'LAMBDA(x,SUM(x))(A1:A3)', '_xlfn.LAMBDA(_xlpm.x,SUM(_xlpm.x))(A1:A3)'],
        [18, 'LET(_x,1,_x+1)', '_xlfn.LET(_xlpm._x,1,_xlpm._x+1)'],
        [19, 'LET(Sum,1,SUM(A1:A3)+Sum)', '_xlfn.LET(_xlpm.Sum,1,SUM(A1:A3)+_xlpm.Sum)'],
        [20, 'LET(x,1,X+1)', '_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'],
    ];

    test("a typed LET or LAMBDA is written as Excel writes it, and Excel's text comes back as it was (batch 18)", () => {
        for (const [row, typed, file] of BOUND) {
            if (typed !== '') expect([row, fileOf(treeA1(`=${typed}`, 'D1'), 'D1').text]).toEqual([row, file]);
            const tree = read(file, 'D1');
            expect([row, round(file, false, 'D1')]).toEqual([row, file]);
            expect(parseStored(printStored(tree))).toEqual(tree);
            expect(isLegacy(tree, FUNCTIONS)).toBe(false);
        }
    });

    test('a called name spelled like a function is the function, bound or not, and a prefixed one stays apart', () => {
        const called = read('_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),_xlpm.sum(2))', 'D1');
        const summed = read('_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),SUM(2))', 'D1');
        expect(printStored(called)).not.toBe(printStored(summed));
        expect(round('_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),_xlpm.sum(2))')).toBe(
            '_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),_xlpm.SUM(2))',
        );
        const reviewers =
            '_xlfn.LET(_xlpm.sum,SUM(A1:A3),_xlpm.max,MAX(B1:B3),SUM(B1:B3)/_xlpm.sum+MAX(A1:A3)-_xlpm.max)';
        expect(round(reviewers)).toBe(reviewers);
        expect(fileOf(treeA1('=LET(count,COUNT(A:A),total,SUM(A:A),total/count+COUNT(B:B))'), 'N1').text).toBe(
            '_xlfn.LET(_xlpm.count,COUNT(A:A),_xlpm.total,SUM(A:A),_xlpm.total/_xlpm.count+COUNT(B:B))',
        );
        const spaced = read('_xlpm.A1 (B1,B2)+_xlpm.f (1)', 'D1');
        expect(parseStored(printStored(spaced))).toEqual(spaced);
    });

    test('a parameter whose bare name would read as a cell or a boolean keeps its prefix', () => {
        for (const text of ['_xlpm.A1+_xlpm.TRUE+_xlpm.rc+_xlpm.', '_xlpm.x+1']) {
            const tree = read(text, 'E5');
            expect(parseStored(printStored(tree))).toEqual(tree);
        }
        expect(shown('_xlpm.A1+_xlpm.x')).toBe('=_xlpm.A1+x');
        // A name the A1 reader keeps in lower case, as r and c are, is stripped and comes back.
        expect(shown('_xlfn.LET(_xlpm.r,3,_xlpm.C,4,_xlpm.r+_xlpm.C)')).toBe('=LET(r,3,c,4,r+c)');
        for (const text of ['_xlfn.LET(_xlpm.r,3,_xlpm.c,4,_xlpm.r+_xlpm.c)', '_xlfn.LET(_xlpm.A1,3,_xlpm.A1+1)']) {
            expect(round(text)).toBe(text);
        }
    });

    test("another workbook's prefix and a 3-D prefix print bare when they read back as themselves", () => {
        for (const text of [
            '[1]Sheet1!A1',
            '[1]!Rate',
            '[1]!Func(1)',
            '[2]Jan:Dec!B11',
            'Sheet1:Sheet3!A1',
            "'[1]foo bar'!#REF!",
            "'A 1:B 2'!A1",
            "'C:\\path\\[Book.xlsx]Sheet1'!A1",
            "[1]!'SGJ212,LA'",
            'Rate:Sheet1:Sheet3!A1',
        ]) {
            expect(round(text)).toBe(text);
            expect(parseStored(printStored(read(text, 'E5')))).toEqual(read(text, 'E5'));
        }
        expect(round("'[1]Sheet1'!A1+'Sheet1:Sheet3'!A1")).toBe('[1]Sheet1!A1+Sheet1:Sheet3!A1');
    });
});

describe('text/xlsx: a stored key reads back as the tree it was printed from', () => {
    // The falsifier's breaking strings: each made a key the stored reader refused or read as another formula.
    const BREAKING = [
        '(A1, _xlfn.SINGLE(B1))',
        'SUM(_xlfn.SINGLE(A1:A3):B5)',
        '_xlfn.SINGLE(A1:A3) B1:B5',
        'B1:B5 _xlfn.SINGLE(A1:A3)',
        '_xlfn.SINGLE(A1:A3)(1)',
        '_xlfn.ANCHORARRAY(A1)(1)',
        '_xlfn.ANCHORARRAY(-A1)',
        '_xlfn.ANCHORARRAY(_xlfn.SINGLE(A1))',
        '_xlfn.ANCHORARRAY(A1+1)',
        '_xlfn.ANCHORARRAY(A1%)',
        '_xlfn.ANCHORARRAY(5)',
        '_xlfn.ANCHORARRAY(A1:B2)',
        '_xlfn.ANCHORARRAY(#REF!)',
        '_xlfn.ANCHORARRAY(_xlfn.ANCHORARRAY(A1))',
        'B2:_xlfn.ANCHORARRAY(A1)',
        '_xlfn.ANCHORARRAY(A1):B2',
        '_xlfn.SINGLE(A1 B1)',
        '_xlfn.SINGLE((A1,B1))',
        '_xlfn.SINGLE(A1:A3)%',
        '_xlfn.SINGLE(A1=B1)',
        '_xlfn.SINGLE(A1%)',
        '_xlfn.SINGLE(A1:A3)#',
        '_xlfn.ANCHORARRAY(A1)#',
        '-_xlfn.ANCHORARRAY(A1)',
        '_xlfn.SINGLE(_xlfn.ANCHORARRAY(A1))',
        '(_xlfn.SINGLE(A1),B1)',
        'SUM((C1):_xlfn.ANCHORARRAY(A1))',
        'INDIRECT(A5):_xlfn.ANCHORARRAY(B10)',
        'A1:C3:_xlfn.ANCHORARRAY(B10)',
        'A1:_xlfn.ANCHORARRAY(B10)(1)',
        'A1:_xlfn.ANCHORARRAY(SUM(B10))',
        '_xlfn.ANCHORARRAY(#REF!)',
        '_xlfn.ANCHORARRAY([1]!x(1))',
        '_xlfn.ANCHORARRAY(_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(A1))',
    ];

    for (const text of BREAKING) {
        test(text, () => {
            for (const tree of [read(text, 'E5'), intersected(read(text, 'E5'))]) {
                expect(parseStored(printStored(tree))).toEqual(tree);
                const { legacy, text: written } = fileOf(tree, 'E5');
                const again = read(written, 'E5');
                expect(printStored(legacy ? intersected(again) : again)).toBe(printStored(tree));
            }
        });
    }

    // The reviewer's strings: a parameter beside a colon read as a column, and a name before the brackets of an @
    // after an intersection read as a call.
    for (const text of [
        '_xlfn.LET(_xlpm.a,A1,_xlpm.b,B3,SUM(_xlpm.a:_xlpm.b))',
        '_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x:_xlpm.y)(A1,B3)',
        '_xlfn.LET(_xlpm.x,A1,_xlpm.x:B3)',
        '_xlfn.LET(_xlpm.x,A1,B3:_xlpm.x)',
        '_xlfn.LET(_xlpm.rng,A1,_xlpm.rng:B3)',
        '_xlpm.x:B:B',
        'Rate _xlfn.SINGLE(B1:B3)',
        'SUM(MyRange _xlfn.SINGLE(B:B))',
        '_xlfn.LET(_xlpm.x,A1,_xlpm.x _xlfn.SINGLE(B:B))',
        'name _xlfn.ANCHORARRAY((B1,B2))',
        'A1:Rate _xlfn.SINGLE(B1:B3)',
        'Sheet2!Rate _xlfn.SINGLE(B1:B3)',
    ]) {
        test(text, () => {
            for (const tree of [read(text, 'E5'), intersected(read(text, 'E5'))]) {
                expect(parseStored(printStored(tree))).toEqual(tree);
                expect(treeA1(printA1(tree, ...at('E5'), sheetName), 'E5')).toEqual(tree);
                const { legacy, text: written } = fileOf(tree, 'E5');
                const again = read(written, 'E5');
                expect(printStored(legacy ? intersected(again) : again)).toBe(printStored(tree));
            }
        });
    }

    test('a parameter beside a colon and a name before a bracketed @ get brackets of their own', () => {
        expect(
            printA1(read('_xlfn.LET(_xlpm.a,A1,_xlpm.b,B3,SUM(_xlpm.a:_xlpm.b))', 'E5'), ...at('E5'), sheetName),
        ).toBe('=LET(a,A1,b,B3,SUM(a:(b)))');
        expect(printA1(read('Rate _xlfn.SINGLE(B1:B3)', 'E5'), ...at('E5'), sheetName)).toBe('=(Rate) (@B1:B3)');
    });

    test('an anchor that is #REF! or a call of what a call returned gets no brackets, and is written as it was', () => {
        for (const [file, typed] of [
            ['_xlfn.ANCHORARRAY(#REF!)', '=#REF!#'],
            ['_xlfn.ANCHORARRAY([1]!x(1))', '=[1]!x(1)#'],
        ]) {
            expect(printA1(read(file, 'E5'), ...at('E5'), sheetName)).toBe(typed);
            expect(fileOf(read(file, 'E5'), 'E5').text).toBe(file);
        }
    });

    test('a name the file wrote bare beside a colon or before brackets gets none it did not have', () => {
        for (const [file, typed] of [
            ['x :y', '=x :y'],
            ['SUM(ab :cd)', '=SUM(ab :cd)'],
            ['R (B1)', '=r (B1)'],
            ['c (B1:B2)', '=c (B1:B2)'],
        ]) {
            const tree = read(file, 'E5');
            expect(printA1(tree, ...at('E5'), sheetName)).toBe(typed);
            expect(parseStored(printStored(tree))).toEqual(tree);
        }
    });

    test('the brackets the reader adds around an @ under a range operator go again on writing', () => {
        const tree = read('SUM((A1,_xlfn.SINGLE(B1:B3)),_xlfn.SINGLE(A1:A3):B5)', 'E5');
        expect(printA1(tree, ...at('E5'), sheetName)).toBe('=SUM((A1,(@B1:B3)),(@A1:A3):B5)');
        expect(fileOf(tree, 'E5').text).toBe('SUM((A1,_xlfn.SINGLE(B1:B3)),_xlfn.SINGLE(A1:A3):B5)');
    });
});

describe('text/xlsx: a file formula whose stored form nests too deep is refused', () => {
    const wrapped = (inner: string, calls: number) => `${'ABS('.repeat(calls)}${inner}${')'.repeat(calls)}`;

    test.each([
        ['_xlfn.SINGLE(A1:A2+1)', 62],
        ['_xlfn.ANCHORARRAY(A1+1)', 62],
        ['_xlfn.SINGLE(A1:A2%)', 61],
        ['1+_xlfn.SINGLE(A1:A2+1):B2', 61],
    ])('the brackets and the operator %s becomes count: it reads under %i calls and no more', (inner, most) => {
        for (let calls = most - 2; calls <= 64; calls += 1) {
            const text = wrapped(inner, calls);
            if (calls > most) expect(parseXlsx(text, ...at('E5'), findSheet)).toMatchObject({ reason: 'too-deep' });
            else expect(parseStored(printStored(read(text, 'E5')))).toEqual(read(text, 'E5'));
        }
    });

    test('the @ of a plain <f> counts: a range under 63 calls gets it, under 64 the formula is refused', () => {
        const fits = intersected(read(wrapped('A1:A2', 63)));
        expect(parseStored(printStored(fits))).toEqual(fits);
        expect(printStored(fits)).toContain('ABS(@R[-1]C[-3]:RC[-3])');
        expect(intersect(read(wrapped('A1:A2', 64)), FUNCTIONS)).toEqual({ reason: 'too-deep', at: 0 });
        expect(intersect(read(wrapped('A1', 64)), FUNCTIONS)).toEqual(read(wrapped('A1', 64)));
    });
});

describe('text/xlsx: a shared formula', () => {
    // [master's text, master's cell, a follower's cell, what Excel's follower reads]
    const FOLLOWERS: readonly (readonly [string, string, string, string])[] = [
        ['SUM(A1:A3)', 'A4', 'B4', '=SUM(B1:B3)'],
        ['$A1+A$1+$A$1', 'B2', 'C3', '=$A2+B$1+$A$1'],
        ['SUM(A:A)', 'B1', 'C1', '=SUM(B:B)'],
        ['SUM(A:A)', 'B1', 'B6', '=SUM(A:A)'],
        ['SUM($A:B)', 'C1', 'D1', '=SUM($A:C)'],
        ['SUM(1:1)', 'A2', 'A3', '=SUM(2:2)'],
        ['SUM(1:1)', 'A2', 'F2', '=SUM(1:1)'],
        ['SUM($1:2)', 'A3', 'A4', '=SUM($1:3)'],
        ['B1:A3', 'D4', 'E5', '=@B2:C4'],
        ['Sheet2!A1', 'B1', 'B2', '=Sheet2!A2'],
        ['INDEX(A:A,ROW())', 'B1', 'B4', '=INDEX(A:A,ROW())'],
        ['A1:A3', 'B1', 'B2', '=@A2:A4'],
        ['_xlfn.ANCHORARRAY(A1)', 'B1', 'B2', '=@A2#'],
        ['B1+1', 'A1', 'A4', '=B4+1'],
    ];
    // A follower whose reference runs past the edge of the grid. Excel wraps to the other edge: batch 15, part S
    // recorded that for the first row, the bar of A1048576 showing =B1. The other three were not recorded in Excel.
    const PAST_THE_EDGE: readonly (readonly [string, string, string, string])[] = [
        ['B1048576', 'A1048575', 'A1048576', '=#REF!'],
        ['XFD1', 'A1', 'B1', '=#REF!'],
        ['SUM(XFD:XFD)', 'A1', 'B1', '=SUM(#REF!)'],
        ['A1', 'A2', 'A1', '=#REF!'],
    ];

    test("a follower is its master's shape at another cell, as Excel reads it", () => {
        for (const [text, master, follower, excel] of FOLLOWERS) {
            const tree = intersected(read(text, master));
            expect(printA1(tree, ...at(follower), sheetName)).toBe(excel);
        }
        expect(FOLLOWERS.length + PAST_THE_EDGE.length).toBe(18);
    });

    test('a follower past the edge of the grid is #REF! where Excel wraps to the other edge: a known difference', () => {
        for (const [text, master, follower, ours] of PAST_THE_EDGE) {
            expect(printA1(intersected(read(text, master)), ...at(follower), sheetName)).toBe(ours);
        }
        expect(PAST_THE_EDGE[0][3]).not.toBe('=B1');
    });

    test('a follower costs no text and no parse, and one with a text of its own takes its master', () => {
        // Batch 15, part S: A1 the master, A2 a follower with its own text, A3 and A4 without.
        const cells: readonly (readonly [string, string | null])[] = [
            ['A1', 'B1+1'],
            ['A2', 'C2*2'],
            ['A3', null],
            ['A4', null],
        ];
        const typed = spyOn(parser, 'parseA1');
        const stored = spyOn(parser, 'parseStored');
        const shapes = new ShapeTable();
        let master = 0;
        const shown = cells.map(([cell, text]) => {
            if (master === 0 && text !== null) master = shapes.internTree(intersected(read(text, cell)));
            return typedText(shapes.shape(master), ...at(cell), sheetName);
        });
        expect(shown).toEqual(['=B1+1', '=B2+1', '=B3+1', '=B4+1']);
        expect([typed.mock.calls.length, stored.mock.calls.length, shapes.size]).toEqual([1, 0, 1]);
        typed.mockRestore();
        stored.mockRestore();
    });
});

describe('text/xlsx: the names of the functions that answer an array', () => {
    test('each is a function of Excel that the engine lacks, so the list shrinks as the engine grows', () => {
        for (const name of EXCEL_ARRAY_FUNCTIONS) {
            expect(EXCEL_FUTURE_FUNCTIONS.has(name) || EXCEL_2007_FUNCTIONS.has(name)).toBe(true);
            expect(FUNCTIONS.has(name)).toBe(false);
        }
    });

    test('a plain <f> gets the @ on such a call, and a typed one is not written plain', () => {
        expect(bar('_xlfn.UNIQUE(A1:A9)')).toBe('=@UNIQUE(A1:A9)');
        expect(bar('SUM(_xlfn.SEQUENCE(3))')).toBe('=SUM(SEQUENCE(3))');
        expect(isLegacy(treeA1('=SEQUENCE(3)+1'), FUNCTIONS)).toBe(false);
        expect(isLegacy(treeA1('=GETPIVOTDATA("Sales",$A$3)'), FUNCTIONS)).toBe(true);
    });
});

describe('text/xlsx: what the A1 reader makes of a file', () => {
    test('a text that fails gives the reason of the A1 reader', () => {
        expect(parseXlsx('L6-(-4,3)', 0, 0, findSheet)).toEqual({ reason: 'syntax', at: 8 });
        expect(parseA1('=L6-(-4,3)', 0, 0, findSheet)).toEqual({ reason: 'syntax', at: 9 });
        expect('reason' in parseXlsx('Sales[Amount', 0, 0, findSheet)).toBe(true);
        expect('reason' in parseXlsx('SUM(Table1[[#This Row],[Qty])', 0, 0, findSheet)).toBe(true);
    });

    test('a file spells a formula longer than Excel shows it, and such a text reads', () => {
        const file = `_xlfn.LET(_xlpm.x,1,${'_xlpm.x+'.repeat(2699)}_xlpm.x)`;
        expect(file).toHaveLength(21620);
        expect(printA1(read(file), ...at('D2'), sheetName)).toBe(`=LET(x,1,${'x+'.repeat(2699)}x)`);
        const typed = treeA1(`=${'XOR(1)+'.repeat(999)}XOR(1)`, 'A1');
        const written = fileOf(typed, 'A1').text;
        expect(written).toHaveLength(12999);
        expect(read(written, 'A1')).toEqual(typed);
    });
});
