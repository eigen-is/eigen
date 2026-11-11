import { describe, expect, test } from 'bun:test';
import {
    MAX_ARGUMENTS,
    MAX_FORMULA_LENGTH,
    MAX_NESTING,
    MAX_STORED_LENGTH,
    NodeKind,
    parseA1,
    parseStored,
    printA1,
    printStored,
    RefFlag,
    RefKind,
    SheetKind,
    sheetFinder,
    Token,
} from '../../text';
import { at, failure, findSheet, grouped, sheetName, shown, stored, treeA1, treeStored } from './support';

const group = (text: string, host = 'A1') => grouped(treeA1(text, host));

describe('operators bind as in Excel (parsing.md 2.1)', () => {
    test.each([
        ['=-2^2', '((-2)^2)'],
        ['=0-2^2', '(0-(2^2))'],
        ['=-(2^2)', '(-[(2^2)])'],
        ['=2^-2', '(2^(-2))'],
        ['=-2^-2', '((-2)^(-2))'],
        ['=2^3^2', '((2^3)^2)'],
        ['=--2^2', '((-(-2))^2)'],
        ['=-A1^2', '((-RC)^2)'],
        ['=-1^0.5', '((-1)^0.5)'],
        ['=2*3&"x"', '((2*3)&"x")'],
        ['="a"&1+2', '("a"&(1+2))'],
        ['=1&2*3', '(1&(2*3))'],
        ['=1+2&3+4', '((1+2)&(3+4))'],
        ['=1&2=12', '((1&2)=12)'],
        ['="12"=1&2', '("12"=(1&2))'],
        ['=1+2%', '(1+(2%))'],
        ['=50%*2', '((50%)*2)'],
        ['=2%^2', '((2%)^2)'],
        ['=2^50%', '(2^(50%))'],
        ['=5%%', '((5%)%)'],
        ['=(1+2)%', '([(1+2)]%)'],
        ['=((10-9)%)%', '([([(10-9)]%)]%)'],
        ['=1=1=1', '((1=1)=1)'],
        ['=1<2<3', '((1<2)<3)'],
        ['=3>2>1', '((3>2)>1)'],
        ['=1+1=2', '((1+1)=2)'],
        ['=10-2-3', '((10-2)-3)'],
        ['=2/2/2', '((2/2)/2)'],
        ['=6/3*2', '((6/3)*2)'],
        ['=2-3+4', '((2-3)+4)'],
        ['=1--1', '(1-(-1))'],
        ['=1+-+1', '(1+(-(+1)))'],
        ['=+"a"', '(+"a")'],
        ['=-"3"', '(-"3")'],
        ['=2*-3', '(2*(-3))'],
        ['=0.1+(0.2+0.3)', '(0.1+[(0.2+0.3)])'],
        ['=(1-3)-(3+5)', '([(1-3)]-[(3+5)])'],
        ['=(A1&B1)*2', '([(RC&RC[1])]*2)'],
        ['=A1=(B1=C1)', '(RC=[(RC[1]=RC[2])])'],
        ['=1<=2<>3>=4', '(((1<=2)<>3)>=4)'],
        ['=2*3^2', '(2*(3^2))'],
        ['=2^3/2', '((2^3)/2)'],
        ['=1+2*3', '(1+(2*3))'],
        ['=6/2-1', '((6/2)-1)'],
        ['=1&2-3', '(1&(2-3))'],
        ['=1<2&3', '(1<(2&3))'],
        ['=-2%^3*4+5&6=7', '(((((((-2)%)^3)*4)+5)&6)=7)'],
    ])('%s', (text, expected) => {
        expect(group(text)).toBe(expected);
    });

    test('-5% has a value either way, and prints back', () => {
        expect(shown('=-5%')).toBe('=-5%');
    });
});

describe('reference operators (parsing.md 2.2)', () => {
    test.each([
        ['=SUM(A1:B2 B1:C3)', 'SUM((RC:R[1]C[1] RC[1]:R[2]C[2]))'],
        ['=A1:B2 B1:C3', '(RC:R[1]C[1] RC[1]:R[2]C[2])'],
        ['=SUM((A1,B1))', 'SUM([(RC,RC[1])])'],
        ['=SUM(A1,B1)', 'SUM(RC,RC[1])'],
        ['=(A1,B1)', '[(RC,RC[1])]'],
        ['=SUM((A1:B1,A2:B2) A1:A2)', 'SUM(([(RC:RC[1],R[1]C:R[1]C[1])] RC:R[1]C))'],
        ['=A1:B2:C3', '(RC:R[1]C[1]:R[2]C[2])'],
        ['=SUM(A1:INDEX(B:B,5))', 'SUM((RC:INDEX(C[1]:C[1],5)))'],
        ['=SUM(INDEX(A:A,2):INDEX(A:A,4))', 'SUM((INDEX(C:C,2):INDEX(C:C,4)))'],
        ['=SUM(OFFSET(A1,1,0):B5)', 'SUM((OFFSET(RC,1,0):R[4]C[1]))'],
        ['=SUM(A:A 1:1)', 'SUM((C:C R:R))'],
        ['=A1 +B1', '(RC+RC[1])'],
        ['=SUM(A1 :B2)', 'SUM((RC:R[1]C[1]))'],
        ['=@A1:A10', '(@RC:R[9]C)'],
        ['=SUM(A1#)', 'SUM((RC#))'],
        ['=-A1#', '(-(RC#))'],
        ['=@A1#', '(@(RC#))'],
        ['=-A1 B1', '(-(RC RC[1]))'],
        ['=A1:B2 B1:C3 C1', '((RC:R[1]C[1] RC[1]:R[2]C[2]) RC[2])'],
        ['=(A1,B1 C1)', '[(RC,(RC[1] RC[2]))]'],
        ['=(1+A1,B1)', '[(1+(RC,RC[1]))]'],
    ])('%s', (text, expected) => {
        expect(group(text)).toBe(expected);
    });

    test('a space between two operands that are not both references is no operator', () => {
        expect(failure('=1 2')).toBe('syntax');
        expect(failure('=A1 2')).toBe('syntax');
        expect(failure('="a" A1')).toBe('syntax');
    });

    test('an error literal ends where it ends, and # before / is the spill operator', () => {
        expect(group('=#N/A/2')).toBe('(#N/A/2)');
        expect(group('=#GETTING_DATA/#DIV/0!')).toBe('(#GETTING_DATA/#DIV/0!)');
        expect(group('=A1#/Sheet2!B1')).toBe('((RC#)/[s2]!RC[1])');
        expect(group('=#REF!/Sheet2!B1')).toBe('(#REF!/[s2]!RC[1])');
    });

    test('# needs a reference', () => {
        expect(failure('=A1%#')).toBe('syntax');
        expect(failure('=1#')).toBe('syntax');
    });

    test('a union needs its own parentheses', () => {
        expect(failure('=A1,B1')).toBe('syntax');
    });
});

describe('literals and names (parsing.md 2.3)', () => {
    test.each([
        ['=1E3', '=1000'],
        ['=1.5e-3', '=0.0015'],
        ['=.5', '=0.5'],
        ['=5.', '=5'],
        ['=1.50', '=1.5'],
        ['=1E21', '=1E+21'],
        ['=0.1234567890123456789', '=0.123456789012346'],
        ['="a""b"', '="a""b"'],
        ['=""', '=""'],
        ['="line1\nline2"', '="line1\nline2"'],
        ['=true', '=TRUE'],
        ['=TRUE()', '=TRUE()'],
        ['=#N/A', '=#N/A'],
        ['=ISERROR(#REF!)', '=ISERROR(#REF!)'],
        ['=#div/0!', '=#DIV/0!'],
        ['={1,2;3,4}', '={1,2;3,4}'],
        ['={-1,"a",TRUE,#N/A}', '={-1,"a",TRUE,#N/A}'],
        ['=IF(A1,,2)', '=IF(A1,,2)'],
        ['=SUM(1,)', '=SUM(1,)'],
        ['=PI()', '=PI()'],
        ['=LAMBDA(x,x+1)(2)', '=LAMBDA(x,x+1)(2)'],
        ['=LET(x,1,x+1)', '=LET(x,1,x+1)'],
        ['=LET(r,1,c,2,r+c)', '=LET(r,1,c,2,r+c)'],
        ['=XLOOKUP(1,A:A,B:B)', '=XLOOKUP(1,A:A,B:B)'],
        ['=Rate*2', '=Rate*2'],
        ['=Sheet1!Rate', '=Sheet1!Rate'],
        ['=norm.s.dist(1,true)', '=NORM.S.DIST(1,TRUE)'],
    ])('%s shows as %s', (text, expected) => {
        expect(shown(text)).toBe(expected);
    });

    test('a number is its value, a string its content', () => {
        expect(treeA1('=1.5e-3')).toMatchObject({ kind: NodeKind.Number, value: 0.0015 });
        expect(treeA1('="a""b"')).toMatchObject({ kind: NodeKind.String, text: 'a"b' });
        expect(treeA1('=true')).toMatchObject({ kind: NodeKind.Boolean, value: 1 });
        expect(treeA1('=#n/a')).toMatchObject({ kind: NodeKind.Error, text: '#N/A' });
    });

    test('TRUE() stays a call, apart from the literal', () => {
        expect(treeA1('=TRUE()')).toMatchObject({ kind: NodeKind.Call, text: 'TRUE', children: [] });
    });

    test('a word before ( is a function even when it reads as a cell', () => {
        expect(treeA1('=LOG10(100)')).toMatchObject({ kind: NodeKind.Call, text: 'LOG10' });
        expect(treeA1('=LOG10')).toMatchObject({ kind: NodeKind.Ref, op: RefKind.Cell });
    });

    test('the last cell of the grid is a reference, one past it a name', () => {
        expect(treeA1('=XFD1048576', 'A1')).toMatchObject({ kind: NodeKind.Ref, row: 1048575, column: 16383 });
        expect(treeA1('=XFE1')).toMatchObject({ kind: NodeKind.Name, text: 'XFE1' });
        expect(treeA1('=A1048577')).toMatchObject({ kind: NodeKind.Name });
        expect(treeA1('=A0')).toMatchObject({ kind: NodeKind.Name });
    });

    test('an unknown function parses', () => {
        expect(treeA1('=nosuchfn(1)')).toMatchObject({ kind: NodeKind.Call, text: 'NOSUCHFN' });
    });

    test('a left-out argument is a node of its own', () => {
        expect(treeA1('=IF(A1,,2)').children.map((child) => child.kind)).toEqual([
            NodeKind.Ref,
            NodeKind.Empty,
            NodeKind.Number,
        ]);
        expect(treeA1('=SUM(1,)').children).toHaveLength(2);
        expect(treeA1('=PI()').children).toHaveLength(0);
    });

    test('a lambda called in place', () => {
        expect(group('=LAMBDA(x,x+1)(2)')).toBe('LAMBDA(x,(x+1))(2)');
        expect(treeA1('=LAMBDA(x,x+1)(2)').kind).toBe(NodeKind.Invoke);
    });

    test('an array constant holds constants only, in rows of one length', () => {
        expect(treeA1('={1,2;3,4}')).toMatchObject({ kind: NodeKind.Array, op: 2 });
        expect(treeA1('={1,2;3,4}').children).toHaveLength(4);
        expect(failure('={1,2;3}')).toBe('syntax');
        expect(failure('={1+1}')).toBe('syntax');
        expect(failure('={A1}')).toBe('syntax');
        expect(failure('={}')).toBe('syntax');
        expect(failure('={SUM(1)}')).toBe('syntax');
    });

    test.each([
        '=1+',
        '=SUM(1,2',
        '=1 +* 2',
        '=)',
        '="open',
        "='Sheet2!A1",
        '=A1\u00a0+B1',
        '=1E999',
        '=Table1[Amount]',
        '=A1:Sheet2!B2',
        '=Sheet2!',
        '=Sheet2! A1',
        '=$',
        '=A$B',
        'SUM(1)',
        '=',
        '',
    ])('%p does not parse, and says so without throwing', (text) => {
        expect(failure(text)).toBe('syntax');
    });
});

describe('references and sheets (parsing.md 2.4)', () => {
    test('the four flag combinations', () => {
        expect(stored('=$a$1+a$1+$a1+a1', 'C3')).toBe('=R1C1+R1C[-2]+R[-2]C1+R[-2]C[-2]');
        expect(shown('=$a$1+a$1+$a1+a1', 'C3')).toBe('=$A$1+A$1+$A1+A1');
    });

    test('a reference node holds an index or an offset per axis', () => {
        expect(treeA1('=$B5', 'C3')).toMatchObject({
            kind: NodeKind.Ref,
            op: RefKind.Cell,
            row: 2,
            column: 1,
            flags: RefFlag.ColumnAbsolute,
            sheetKind: SheetKind.Host,
        });
        expect(treeA1('=A$1:$C7', 'C3')).toMatchObject({
            op: RefKind.Range,
            row: 0,
            column: -2,
            row2: 4,
            column2: 2,
            flags: RefFlag.RowAbsolute | RefFlag.Column2Absolute,
        });
    });

    test.each([
        ['=SUM(B2:A1)', '=SUM(A1:B2)'],
        ['=SUM(A$2:B1)', '=SUM(A1:B$2)'],
        ['=SUM(D1:$A3)', '=SUM($A1:D3)'],
        ['=SUM(C:A)', '=SUM(A:C)'],
        ['=SUM($5:2)', '=SUM(2:$5)'],
    ])('%s shows its corners in order, as %s', (text, expected) => {
        expect(shown(text)).toBe(expected);
    });

    test('the tree keeps the corners as typed, so one shape serves hosts that order them differently', () => {
        expect(stored('=SUM(B$2:B1)', 'A1')).toBe('=SUM(R2C[1]:RC[1])');
        expect(stored('=SUM(B$2:B4)', 'A4')).toBe('=SUM(R2C[1]:RC[1])');
        const tree = treeStored('=SUM(R2C[1]:RC[1])');
        expect(printA1(tree, ...at('A1'), sheetName)).toBe('=SUM(B1:B$2)');
        expect(printA1(tree, ...at('A4'), sheetName)).toBe('=SUM(B$2:B4)');
    });

    test.each([
        ['=SUM(A:A)', '=SUM(C[-13]:C[-13])'],
        ['=SUM($A:$C)', '=SUM(C1:C3)'],
        ['=SUM(1:1)', '=SUM(R:R)'],
        ['=SUM($2:$5)', '=SUM(R2:R5)'],
        ['=SUM($A:C)', '=SUM(C1:C[-11])'],
    ])('whole columns and rows: %s is stored as %s', (text, expected) => {
        expect(stored(text)).toBe(expected);
        expect(shown(text)).toBe(text);
    });

    test('a lone column or row is no reference', () => {
        expect(treeA1('=A')).toMatchObject({ kind: NodeKind.Name });
        expect(treeA1('=A:A')).toMatchObject({ kind: NodeKind.Ref, op: RefKind.Columns });
        expect(treeA1('=1:1')).toMatchObject({ kind: NodeKind.Ref, op: RefKind.Rows });
    });

    test.each([
        ['=Sheet2!A1', '=[s2]!RC[-13]', '=Sheet2!A1'],
        ["='My Sheet'!A1", '=[my]!RC[-13]', "='My Sheet'!A1"],
        ["='Bob''s'!A1", '=[bob]!RC[-13]', "='Bob''s'!A1"],
        ["='Sheet2'!A1", '=[s2]!RC[-13]', '=Sheet2!A1'],
        ["='P&L'!A1", '=[pl]!RC[-13]', "='P&L'!A1"],
        ["='2024'!A1", '=[y24]!RC[-13]', "='2024'!A1"],
        ["='A1'!B2", '=[a1]!R[1]C[-12]', "='A1'!B2"],
        ["='TRUE'!A1", '=[true]!RC[-13]', "='TRUE'!A1"],
        ["='RC'!A1", '=[rc]!RC[-13]', "='RC'!A1"],
        ['=sheet2!a1', '=[s2]!RC[-13]', '=Sheet2!A1'],
        ['=Sheet2!A1:B2', '=[s2]!RC[-13]:R[1]C[-12]', '=Sheet2!A1:B2'],
        ['=Sheet2!A1:Sheet2!B2', '=[s2]!RC[-13]:R[1]C[-12]', '=Sheet2!A1:B2'],
        ["=Sheet2!A1:'Sheet2'!B2", '=[s2]!RC[-13]:R[1]C[-12]', '=Sheet2!A1:B2'],
        ['=Sheet2!A:B', '=[s2]!C[-13]:C[-12]', '=Sheet2!A:B'],
        ['=Sheet2!$1:$2', '=[s2]!R1:R2', '=Sheet2!$1:$2'],
        ['=Sheet1!A1', '=[s1]!RC[-13]', '=Sheet1!A1'],
    ])('%s is stored as %s and shows as %s', (text, storedText, a1) => {
        expect(stored(text)).toBe(storedText);
        expect(shown(text)).toBe(a1);
    });

    test('a sheet that does not exist is kept by its name', () => {
        expect(stored('=NoSuchSheet!A1', 'A1')).toBe("='NoSuchSheet'!RC");
        expect(treeA1('=NoSuchSheet!A1')).toMatchObject({ sheetKind: SheetKind.Name, sheet: 'NoSuchSheet' });
        expect(shown('=NoSuchSheet!A1')).toBe('=NoSuchSheet!A1');
        expect(shown("='No such'!A1")).toBe("='No such'!A1");
        expect(treeStored("='No''such'!RC")).toMatchObject({ sheetKind: SheetKind.Name, sheet: "No'such" });
    });

    test.each([
        '=A1:Sheet2!B2',
        '=Sheet1!A1:Sheet2!B2',
        '=A1:Sheet1!B2',
        '=A1:B1x!C1',
        '=SUM(A1:B2Data!C1)',
        '=A1:A1Sheet!B2',
        '=Sheet2!A1:NoSuch!B2',
        "=NoSuch!A1:'No Such'!B2",
        '=Sheet2!A1:Sheet1!Rate',
        '=SUM(A1):Sheet2!A1',
        '=Sheet2!A1:B2!C1',
    ])('a range ends on one sheet: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
    });

    test.each(['=RC:[s2]!RC', "=RC:'x'!RC", '=[s1]!RC:[s2]!RC', "='x'!RC:[s2]!RC", '=R1C1:RC!RC'])(
        'a range ends on one sheet in stored text too: %s does not parse',
        (text) => {
            expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
        },
    );

    test.each([
        ['=NoSuch!A1:NoSuch!B2', "='NoSuch'!RC[-13]:R[1]C[-12]", '=NoSuch!A1:B2'],
        ["='No Such'!$A$1:'No Such'!B2", "='No Such'!R1C1:R[1]C[-12]", "='No Such'!$A$1:B2"],
        ['=Sheet2!A1: Sheet2!B2', '=[s2]!RC[-13]: [s2]!R[1]C[-12]', '=Sheet2!A1: Sheet2!B2'],
        ['=Sheet2!A1:Sheet2!B2:C3', '=[s2]!RC[-13]:[s2]!R[1]C[-12]:R[2]C[-11]', '=Sheet2!A1:Sheet2!B2:C3'],
        ['=Sheet2!A1:Sheet2!B2:Sheet2!C3', '=[s2]!RC[-13]:R[1]C[-12]:[s2]!R[2]C[-11]', '=Sheet2!A1:B2:Sheet2!C3'],
        ['=Sheet2!A1:Sheet2!Rate', '=[s2]!RC[-13]:[s2]!Rate', '=Sheet2!A1:Sheet2!Rate'],
        ['=A1:INDEX(Sheet2!B:B,5)', '=RC[-13]:INDEX([s2]!C[-12]:C[-12],5)', '=A1:INDEX(Sheet2!B:B,5)'],
    ])('a second corner may repeat the sheet of the first: %s is stored as %s and shows as %s', (text, kept, a1) => {
        expect(stored(text)).toBe(kept);
        expect(treeStored(kept)).toEqual(treeA1(text));
        expect(shown(text)).toBe(a1);
    });

    test('a 3-D reference parses and is kept', () => {
        expect(shown('=SUM(Sheet1:Sheet3!A1)')).toBe('=SUM(Sheet1:Sheet3!A1)');
        expect(shown("=SUM('Sheet 1:Sheet 3'!A1)")).toBe("=SUM('Sheet 1:Sheet 3'!A1)");
        expect(stored('=SUM(Sheet1:Sheet3!A1:B2)', 'A1')).toBe("=SUM('Sheet1:Sheet3'!RC:R[1]C[1])");
        expect(treeA1('=Sheet1:Sheet3!A1')).toMatchObject({ sheetKind: SheetKind.Span, sheet: 'Sheet1:Sheet3' });
    });

    test('a reference to another workbook parses and is kept', () => {
        expect(shown('=[1]Sheet1!$A$1')).toBe('=[1]Sheet1!$A$1');
        expect(shown("='[1]My Sheet'!$A$1")).toBe("='[1]My Sheet'!$A$1");
        expect(shown('=[1]!GlobalName')).toBe('=[1]!GlobalName');
        expect(shown("='C:\\path\\[Book.xlsx]Sheet1'!A1")).toBe("='C:\\path\\[Book.xlsx]Sheet1'!A1");
        expect(stored('=[1]Sheet1!$A$1')).toBe("='[1]Sheet1'!R1C1");
        expect(stored('=[1]!GlobalName')).toBe("='[1]'!GlobalName");
        expect(treeA1('=[1]Sheet1!$A$1')).toMatchObject({ sheetKind: SheetKind.External, sheet: '[1]Sheet1' });
    });

    test('#REF! behind a sheet is an error that keeps its sheet', () => {
        expect(shown('=Sheet2!#REF!')).toBe('=Sheet2!#REF!');
        expect(stored('=SUM(Sheet2!#REF!)')).toBe('=SUM([s2]!#REF!)');
    });

    test('a reference off the grid at its host prints #REF!', () => {
        const tree = treeA1('=A1+Sheet2!B2+C$3', 'B2');
        expect(printStored(tree)).toBe('=R[-1]C[-1]+[s2]!RC+R3C[1]');
        expect(printA1(tree, ...at('A1'), sheetName)).toBe('=#REF!+Sheet2!A1+B$3');
        expect(printA1(tree, 0, 16383, sheetName)).toBe('=#REF!+Sheet2!XFD1+#REF!');
        expect(printA1(treeStored('=R[5]C'), 1048575, 0, sheetName)).toBe('=#REF!');
    });

    test('a reference to a sheet that is gone prints #REF!', () => {
        expect(printA1(treeStored('=[gone]!RC+1'), 0, 0, sheetName)).toBe('=#REF!+1');
    });
});

describe('what is typed is kept (parsing.md 2.5)', () => {
    test.each([
        ['= 1 +  2', '= 1 +  2'],
        ['=SUM( A1 , B1 )', '=SUM( A1, B1 )'],
        ['=1+\n2', '=1+\n2'],
        ['=1+\t2\r\n', '=1+\t2'],
        ['=(A1)', '=(A1)'],
        ['=(5)^(4)', '=(5)^(4)'],
        ['=+A1', '=+A1'],
        ['=sum(a1)', '=SUM(A1)'],
        ['=1 + (3<5)', '=1 + (3<5)'],
        ['=SUM( )', '=SUM( )'],
        ['={ 1, 2 ; 3, 4 }', '={ 1, 2; 3, 4 }'],
        ['=A1 %', '=A1 %'],
        ['=A1: B2', '=A1: B2'],
        ['=A1   B1', '=A1   B1'],
    ])('%p shows as %p', (text, expected) => {
        expect(shown(text)).toBe(expected);
    });

    test('whitespace sits on the token it precedes', () => {
        const tree = treeA1('= 1 +  2');
        expect(tree).toMatchObject({ kind: NodeKind.Binary, op: Token.Plus, space: ' ' });
        expect(tree.children[0].space).toBe(' ');
        expect(tree.children[1].space).toBe('  ');
        expect(treeA1('=SUM(1 )').spaceEnd).toBe(' ');
    });

    test('the whitespace of an intersection is the operator', () => {
        const tree = treeA1('=A1:A3  A2:B2');
        expect(tree).toMatchObject({ kind: NodeKind.Binary, op: Token.Space, space: '  ' });
        expect(tree.children[1].space).toBe('');
    });
});

describe('the stored form (parsing.md 2.6)', () => {
    test.each([
        ['C1', '=A1+$B$1', '=RC[-2]+R1C2'],
        ['C2', '=A2+$B$1', '=RC[-2]+R1C2'],
        ['B5', '=A$1', '=R1C[-1]'],
        ['C5', '=B$1', '=R1C[-1]'],
        ['C1', '=A1 + $B$1', '=RC[-2] + R1C2'],
        ['C1', '=sum(A1:B1)', '=SUM(RC[-2]:RC[-1])'],
        ['C1', '=Sheet2!A1', '=[s2]!RC[-2]'],
        ['C1', '=A1', '=RC[-2]'],
        ['C1', '=Sheet1!A1', '=[s1]!RC[-2]'],
        ['B2', '=A1+C3', '=R[-1]C[-1]+R[1]C[1]'],
    ])('at %s, %s is %s', (host, text, expected) => {
        expect(stored(text, host)).toBe(expected);
    });

    test('the stored text parses to the tree the typed text gave', () => {
        const typed = treeA1("=IF( $A1>0, SUM(B:B 2:2)*-'P&L'!C3%, {1,2;3,4} )&Rate", 'D4');
        expect(treeStored(printStored(typed))).toEqual(typed);
    });

    test('R and C are references in upper case only', () => {
        expect(treeStored('=RC')).toMatchObject({ kind: NodeKind.Ref, row: 0, column: 0, flags: 0 });
        expect(treeStored('=R[-2]C3')).toMatchObject({ row: -2, column: 2, flags: RefFlag.ColumnAbsolute });
        expect(treeStored('=rc')).toMatchObject({ kind: NodeKind.Name, text: 'rc' });
        expect(treeStored('=R:R')).toMatchObject({ kind: NodeKind.Ref, op: RefKind.Rows });
        expect(treeStored('=C[1]:C[3]')).toMatchObject({ op: RefKind.Columns, column: 1, column2: 3 });
    });

    test('a name that reads as a reference in the other grammar cannot cross', () => {
        expect(stored('=LET(RC,1,RC+R1C1)')).toBe('=LET(rc,1,rc+r1c1)');
        const lone = parseStored('=A1+1');
        expect('reason' in lone && lone.reason).toBe('syntax');
    });

    test('a sheet id is read as written', () => {
        expect(treeStored('=[k3f9]!R2C1')).toMatchObject({ sheetKind: SheetKind.Id, sheet: 'k3f9', row: 1 });
        expect(printStored(treeStored('=SUM(R[-3]C:R[-1]C)*[k3f9]!R2C1'))).toBe('=SUM(R[-3]C:R[-1]C)*[k3f9]!R2C1');
    });
});

describe('limits', () => {
    const nested = (levels: number) => `=${'('.repeat(levels)}1${')'.repeat(levels)}`;
    const args = (count: number) => `=SUM(${Array.from({ length: count }, () => '1').join(',')})`;

    test('8,192 characters', () => {
        const longest = `=${'1+'.repeat((MAX_FORMULA_LENGTH - 2) / 2)}1`;
        expect(longest).toHaveLength(MAX_FORMULA_LENGTH);
        expect(failure(longest)).toBe('parsed');
        expect(failure(`${longest} `)).toBe('too-long');
        expect(MAX_FORMULA_LENGTH).toBe(8192);
    });

    test('the limit on length is on what a person types, and stored text may be longer', () => {
        const sheets = sheetFinder([{ id: '0b9f6c1e-6a4d-4c1b-9a53-3f1f0c9d2e77', name: 'a' }]);
        const typed = `=${'a!A1+'.repeat(1638)}1`;
        expect(typed.length).toBeLessThanOrEqual(MAX_FORMULA_LENGTH);
        const tree = parseA1(typed, 1048575, 16383, sheets);
        if ('reason' in tree) throw new Error(tree.reason);
        const text = printStored(tree);
        expect(text).toHaveLength(1638 * 60 + 2);
        expect(parseStored(text)).toEqual(tree);
        expect(MAX_STORED_LENGTH).toBe(16 * MAX_FORMULA_LENGTH);
        const longest = `=${'1+'.repeat((MAX_STORED_LENGTH - 2) / 2)}1`;
        expect(longest).toHaveLength(MAX_STORED_LENGTH);
        expect(printStored(treeStored(longest))).toBe(longest);
        expect(parseStored(`${longest} `)).toEqual({ reason: 'too-long', at: MAX_STORED_LENGTH });
    });

    test('64 levels of nesting', () => {
        expect(failure(nested(MAX_NESTING))).toBe('parsed');
        expect(failure(nested(MAX_NESTING + 1))).toBe('too-deep');
        expect(failure(`=${'SUM('.repeat(65)}1${')'.repeat(65)}`)).toBe('too-deep');
        expect(failure(`=${'-'.repeat(65)}1`)).toBe('too-deep');
        expect(MAX_NESTING).toBe(64);
    });

    test('a postfix operator and a call of a call nest too', () => {
        expect(failure(`=1${'%'.repeat(MAX_NESTING)}`)).toBe('parsed');
        expect(failure(`=1${'%'.repeat(MAX_NESTING + 1)}`)).toBe('too-deep');
        expect(failure(`=F${'()'.repeat(MAX_NESTING)}`)).toBe('parsed');
        expect(failure(`=F${'()'.repeat(MAX_NESTING + 1)}`)).toBe('too-deep');
        expect(failure(`=A1${'#'.repeat(MAX_NESTING + 1)}`)).toBe('too-deep');
        expect(failure(`=${'('.repeat(60)}1${')'.repeat(60)}%%%%`)).toBe('parsed');
        expect(failure(`=${'('.repeat(60)}1${')'.repeat(60)}%%%%%`)).toBe('too-deep');
        expect(failure(`=${'('.repeat(30)}1%%%%${')%'.repeat(30)}`)).toBe('parsed');
        expect(failure(`=${'('.repeat(30)}1%%%%%${')%'.repeat(30)}`)).toBe('too-deep');
        expect(failure(`=SUM(1,${'-'.repeat(32)}F(1)${'()'.repeat(30)})`)).toBe('parsed');
        expect(failure(`=SUM(1,${'-'.repeat(32)}F(1)${'()'.repeat(31)})`)).toBe('too-deep');
        expect(failure(`={1,2}${'%'.repeat(MAX_NESTING)}`)).toBe('too-deep');
    });

    test('a chain of binary operators is not nesting, however long', () => {
        const sum = `=${'A1+'.repeat(2730)}1`;
        expect(sum).toHaveLength(MAX_FORMULA_LENGTH);
        const tree = treeA1(sum, 'B2');
        expect(printA1(tree, ...at('B2'), sheetName)).toBe(sum);
        expect(printStored(tree)).toBe(`=${'R[-1]C[-1]+'.repeat(2730)}1`);
        const crossed = `=A1${' A1'.repeat(2000)}`;
        expect(shown(crossed)).toBe(crossed);
        expect(failure(`=${'1%+'.repeat(2000)}1`)).toBe('parsed');
    });

    test('255 arguments', () => {
        expect(failure(args(MAX_ARGUMENTS))).toBe('parsed');
        expect(failure(args(MAX_ARGUMENTS + 1))).toBe('too-many-arguments');
        expect(MAX_ARGUMENTS).toBe(255);
    });

    test('a failure names where it stopped', () => {
        expect(parseA1('=1+*2', 0, 0, findSheet)).toEqual({ reason: 'syntax', at: 3 });
    });
});
