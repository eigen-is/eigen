import { describe, expect, test } from 'bun:test';
import { Fact, shapeFacts } from '../../eval/facts';
import {
    ERROR_LITERALS,
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
    storedText,
    Token,
} from '../../text';
import { at, dice, failure, findSheet, grouped, sheetName, shown, stored, treeA1, treeStored } from './support';

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

    test.each([
        ...['=A1 TRUE', '=A1 false', '=NOT TRUE', '=A1 5', '=A1 "x"', '=A1 #N/A', '=A1 {1}', '=A1:B2 TRUE C1'],
        ...['=(1,2)', '=(A1,2)', '=(1,A1)', '=("a",A1)', '=(A1,TRUE)', '=SUM((A1,1))', '=(A1,B1,3)', '=(A1,{1})'],
    ])('an intersection and a union take only what may yield a reference: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
        expect(parseStored(text.replaceAll(/[A-C]\d/g, 'RC'))).toMatchObject({ reason: 'syntax' });
    });

    test.each([
        ['=A1 (1+2)', '(RC [(1+2)])'],
        ['=A1 SUM(1)', '(RC SUM(1))'],
        ['=A1 Rate', '(RC Rate)'],
        ['=A1 TRUE()', '(RC TRUE())'],
        ['=(A1,Rate)', '[(RC,Rate)]'],
        ['=(A1,#REF!,C1)', '[((RC,#REF!),RC[2])]'],
        ['=(A1,(B1))', '[(RC,[RC[1]])]'],
        ['=(IF(1,A1),B1#)', '[(IF(1,RC),(RC[1]#))]'],
    ])('and cannot know more than that: %s', (text, expected) => {
        expect(group(text)).toBe(expected);
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
        ['=0.1234567890123456789', '=0.123456789012345'],
        ['=123456789012345678', '=123456789012345000'],
        ['=999999999999999999', '=999999999999999000'],
        ['=0.000123456789012345678', '=0.000123456789012345'],
        ['=1.99999999999999999', '=1.99999999999999'],
        ['=00000000000000000001.5', '=1.5'],
        ['=1234567890.12345678E5', '=123456789012345'],
        ['=123456789012345678E-20', '=0.00123456789012345'],
        ['=0.00000000000000000000', '=0'],
        ['=123456789012345', '=123456789012345'],
        ['=1234567890123456', '=1234567890123450'],
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

    test.each([
        ['=0.0000001', '=0.0000001'],
        ['=1E-7', '=0.0000001'],
        ['=A1*0.000000001', '=A1*0.000000001'],
        ['=1.5E-7', '=0.00000015'],
        ['=1E-10', '=0.0000000001'],
        ['=1E-5', '=0.00001'],
        ['=0.000000000008854', '=0.000000000008854'],
        ['=1E-18', '=0.000000000000000001'],
        ['=1.23456789012345E-18', '=0.00000000000000000123456789012345'],
        ['=9.99999999999999E-19', '=9.99999999999999E-19'],
        ['=1.6e-19', '=1.6E-19'],
        ['=0.0000000000000000001', '=1E-19'],
        ['=1E-20', '=1E-20'],
        ['=6.626E-34', '=6.626E-34'],
        ['=0.00000000000000000000000000000000066260', '=6.626E-34'],
        ['=5E-324', '=5E-324'],
        ['=1E+15', '=1000000000000000'],
        ['=1E20', '=100000000000000000000'],
        ['=123456789012345E6', '=123456789012345000000'],
        ['=9.99999999999999e20', '=999999999999999000000'],
        ['=1E21', '=1E+21'],
        ['=1000000000000000000000', '=1E+21'],
        ['=1.5e21', '=1.5E+21'],
        ['=1.23456789012345E+100', '=1.23456789012345E+100'],
        ['=1E308', '=1E+308'],
        ['=0', '=0'],
    ])('a number prints in plain digits where Excel writes them: %s shows as %s', (text, expected) => {
        expect(shown(text)).toBe(expected);
        expect(stored(text)).toBe(expected.replace('A1', 'RC[-13]'));
        expect(treeStored(stored(text))).toEqual(treeA1(text));
    });

    test('a number of 15 digits at any exponent has one spelling, which reads back as the same value', () => {
        const { random } = dice(9);
        for (let exponent = -323; exponent <= 307; exponent += 1) {
            for (let run = 0; run < 40; run += 1) {
                let digits = String(1 + Math.floor(random() * 9));
                for (let i = Math.floor(random() * 15); i > 0; i -= 1) digits += Math.floor(random() * 10);
                const typed = `=${digits.charAt(0)}.${digits.slice(1)}0E${exponent}`;
                const tree = treeA1(typed);
                const value = Number(typed.slice(1));
                expect(tree.value).toBe(value);
                const text = printStored(tree);
                expect(treeStored(text).value).toBe(value);
                expect(printStored(treeStored(text))).toBe(text);
                expect(shown(text)).toBe(text);
                const plain = /^=(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(text);
                const scientific = /^=[1-9](?:\.\d*[1-9])?E[+-]\d{2,3}$/.test(text);
                // Below the smallest normal number a double holds fewer digits than were typed.
                const significant = text.replace(/E.*|[=.]/g, '').replace(/^0+|0+$/g, '').length;
                if (exponent > -300) expect(significant).toBeLessThanOrEqual(15);
                expect(plain || scientific).toBe(true);
                expect(plain).toBe(exponent >= -18 && exponent <= 20);
            }
        }
    });

    test('a number is its value, a string its content', () => {
        expect(treeA1('=1.5e-3')).toMatchObject({ kind: NodeKind.Number, value: 0.0015 });
        expect(treeA1('="a""b"')).toMatchObject({ kind: NodeKind.String, text: 'a"b' });
        expect(treeA1('=true')).toMatchObject({ kind: NodeKind.Boolean, value: 1 });
        expect(treeA1('=#n/a')).toMatchObject({ kind: NodeKind.Error, value: 7, text: '' });
    });

    test('an error leaf holds the place of its literal in the list, from 1', () => {
        expect(ERROR_LITERALS.slice(0, 10)).toEqual([
            '#NULL!',
            '#DIV/0!',
            '#VALUE!',
            '#REF!',
            '#NAME?',
            '#NUM!',
            '#N/A',
            '#SPILL!',
            '#CALC!',
            '#ERROR!',
        ]);
        for (const [index, literal] of ERROR_LITERALS.entries()) {
            const tree = treeA1(`=${literal.toLowerCase()}`);
            expect(tree).toMatchObject({ kind: NodeKind.Error, value: index + 1, text: '' });
            expect(printStored(tree)).toBe(`=${literal}`);
            expect(treeStored(`=${literal}`)).toEqual(tree);
            expect(shown(`=IFERROR(${literal},1)`)).toBe(`=IFERROR(${literal},1)`);
        }
        expect(ERROR_LITERALS).toHaveLength(19);
    });

    test.each(['=#FOO!', '=#REF?', '=#NAME!', '=#N/B', '=#REF', '=#DIV/1!', '=#A1!', '=#!', '=#\uFB01ELD!'])(
        'only a known error literal is one: %s does not parse',
        (text) => {
            expect(failure(text)).toBe('syntax');
            expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
        },
    );

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

    test.each([
        ['=SUM (1,2)', 'SUM(1,2)', '=SUM (1,2)', ' '],
        ['=IF (A1,1,2)', 'IF(RC[-13],1,2)', '=IF (A1,1,2)', ' '],
        ['=sum  (A1:A3)', 'SUM(RC[-13]:R[2]C[-13])', '=SUM  (A1:A3)', '  '],
        ['=TRUE ()', 'TRUE()', '=TRUE ()', ' '],
        ['=false\n()', 'FALSE()', '=FALSE\n()', '\n'],
        ['=MyRange (A1:B2)', 'MYRANGE(RC[-13]:R[1]C[-12])', '=MYRANGE (A1:B2)', ' '],
        ['=A (1)', 'A(1)', '=A (1)', ' '],
    ])('a word, whitespace and ( is a call, and keeps its whitespace: %p', (text, expected, a1, spaceOpen) => {
        const tree = treeA1(text);
        expect(tree).toMatchObject({ kind: NodeKind.Call, spaceOpen });
        expect(grouped(tree)).toBe(expected);
        expect(shown(text)).toBe(a1);
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(treeA1(a1)).toEqual(tree);
    });

    test('a call nested in a call keeps the whitespace of each', () => {
        expect(shown('=IF (SUM  (A1)>0, MAX (1,2) ,3)')).toBe('=IF (SUM  (A1)>0, MAX (1,2),3)');
        expect(stored('=1+SUM (A1)', 'A1')).toBe('=1+SUM (RC)');
    });

    test.each([
        ['=A1 (B1:C1)', '(RC[-13] [RC[-12]:RC[-11]])'],
        ['=LOG10 (100)', '(R[9]C[8495] [100])'],
        ['=A1:B2 (B1)', '(RC[-13]:R[1]C[-12] [RC[-12]])'],
        ['=SUM(A1:B2) (B1)', '(SUM(RC[-13]:R[1]C[-12]) [RC[-12]])'],
        ['=(A1:B2) (B1)', '([RC[-13]:R[1]C[-12]] [RC[-12]])'],
        ['=Sheet2!Rate (B1)', '([s2]!Rate [RC[-12]])'],
        ['=RC (B1)', '(rc [RC[-12]])'],
        ['=r1c1 (B1)', '(r1c1 [RC[-12]])'],
    ])('a reference, whitespace and ( stays an intersection: %s', (text, expected) => {
        const tree = treeA1(text);
        expect(grouped(tree)).toBe(expected);
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(treeA1(shown(text))).toEqual(tree);
    });

    test('a column, a colon and a column before whitespace and ( is one range in both grammars', () => {
        expect(group('=A:IF (B1)')).toBe('(C:C[239] [RC[1]])');
        expect(parseStored('=A:IF (RC)')).toMatchObject({ reason: 'syntax' });
        expect(parseStored('=[s2]!A:BF  (1)()')).toMatchObject({ reason: 'syntax' });
        expect(stored('=IF (A1,B1):B', 'A1')).toBe('=IF (RC,RC[1]):B');
        expect(grouped(treeStored('=IF (RC,RC[1]):B'))).toBe('(IF(RC,RC[1]):B)');
        expect(stored('=A:IF(B1)', 'A1')).toBe('=A:IF(RC[1])');
    });

    test('stored text reads a word, whitespace and ( the same way', () => {
        expect(treeStored('=SUM (RC)')).toEqual(treeA1('=SUM (N1)'));
        expect(grouped(treeStored('=RC (R1C1)'))).toBe('(RC [R1C1])');
        expect(parseStored('=A1 (1)')).toMatchObject({ reason: 'syntax' });
        expect(grouped(treeStored('=rc (1)'))).toBe('(rc [1])');
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
        '=',
        '',
    ])('%p does not parse, and says so without throwing', (text) => {
        expect(failure(text)).toBe('syntax');
    });

    test('a formula reads without its =, as a file holds it', () => {
        expect(treeA1('SUM(1)')).toEqual(treeA1('=SUM(1)'));
        expect(failure('=')).toBe('syntax');
    });
});

describe('what a name may hold (parsing.md rule 31)', () => {
    test.each([
        ['an ideographic space', '=SUM(A1,\u3000B1)'],
        ['a zero-width space', '=A1\u200b+1'],
        ['a zero-width joiner', '=x\u200dy'],
        ['a byte-order mark', '=\ufeffA1'],
        ['a line separator', '=A1\u2028+1'],
        ['a no-break space', '=A1\u00a0+B1'],
        ['a narrow no-break space', '=1\u202f+1'],
        ['a Hangul filler', '=\u3164'],
        ['a variation selector', '=x\ufe0f'],
        ['a soft hyphen', '=x\u00ady'],
        ['full-width digits and plus', '=\uff11\uff0b\uff12'],
        ['a full-width plus', '=A1\uff0bB1'],
        ['full-width letters', '=\uff21\uff11'],
        ['a full-width call', '=\uff33\uff35\uff2d(1)'],
        ['a multiplication sign', '=A\u00d7B'],
        ['a minus sign', '=A1\u2212B1'],
        ['curly quotes', '=\u201ca\u201d'],
        ['a currency sign', '=\u20ac'],
        ['an emoji', '=\ud83d\ude00'],
        ['an emoji inside a name', '=x\ud83d\ude00'],
        ['half a surrogate pair', '=x\ud83d'],
        ['a digit of another script first', '=\u0663x'],
        ['a combining mark alone', '=\u0301'],
    ])('%s is no part of a name, so the text does not parse', (_, text) => {
        expect(failure(text)).toBe('syntax');
        expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
        expect(storedText(text, 0, 0, findSheet)).toBe(`=${text}`);
    });

    test.each([
        '=\u00dcbersicht',
        '=\u00e9t\u00e9_2',
        '=\u0394x',
        '=\u6570\u636e',
        '=\ub370\uc774\ud130',
        '=\ud840\udc00x',
        '=Stra\u00dfe9',
        '=x\u0663',
        '=\uff76\uff85',
        '=x.y?',
        '=\\a',
        '=_1',
        '=a\\b?c.d',
    ])('letters of any script, digits, _ . \\ and ? make a name: %s', (text) => {
        const tree = treeA1(text);
        expect(tree).toMatchObject({ kind: NodeKind.Name, text: text.slice(1) });
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(shown(text)).toBe(text);
    });

    test('a sheet and a function are named by the same characters', () => {
        expect(treeA1('=\u6570\u636e!A1')).toMatchObject({ kind: NodeKind.Ref, sheet: '\u6570\u636e' });
        expect(treeA1('=\u0394x(1)')).toMatchObject({ kind: NodeKind.Call, text: '\u0394X' });
        expect(failure('=\u6570\u3000\u636e!A1')).toBe('syntax');
        expect(failure('=A1:B2\u200b')).toBe('syntax');
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
        '=Sheet2!A1:B2!C1',
        '=A1:Sheet2!B2:C3',
        '=A1:Sheet2!B2#',
        '=(A2):A1:Sheet2!B2',
    ])('two cells around a colon are one range on one sheet: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
    });

    test.each([
        '=RC:[s2]!RC',
        "=RC:'x'!RC",
        '=[s1]!RC:[s2]!RC',
        "='x'!RC:[s2]!RC",
        '=R1C1:RC!RC',
        '=RC:[s1]!RC:R[1]C',
        '=RC:[s2]!RC#',
    ])('two cells around a colon are one range on one sheet in stored text too: %s does not parse', (text) => {
        expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
    });

    test.each([
        ['=SUM(A1):Sheet2!A1', '=SUM(RC[-13]):[s2]!RC[-13]'],
        ['=(A1):Sheet2!B2', '=(RC[-13]):[s2]!R[1]C[-12]'],
        ['=A1:A2:Sheet2!B2', '=RC[-13]:R[1]C[-13]:[s2]!R[1]C[-12]'],
        ['=Sheet1!A1:A2:Sheet2!B2', '=[s1]!RC[-13]:R[1]C[-13]:[s2]!R[1]C[-12]'],
        ['=A1 :Sheet2!B2', '=RC[-13] :[s2]!R[1]C[-12]'],
        ['=A1: Sheet2!B2', '=RC[-13]: [s2]!R[1]C[-12]'],
        ['=A1:Sheet2!B:C', '=RC[-13]:[s2]!C[-12]:C[-11]'],
        ['=A1:Sheet2!Rate', '=RC[-13]:[s2]!Rate'],
        ['=Sheet2!A1:Sheet1!Rate', '=[s2]!RC[-13]:[s1]!Rate'],
        ['=INDEX(A:A,1):NoSuch!B2', "=INDEX(C[-13]:C[-13],1):'NoSuch'!R[1]C[-12]"],
    ])('any other operand of the : operator may name a sheet of its own: %s is stored as %s', (text, kept) => {
        expect(stored(text)).toBe(kept);
        expect(treeStored(kept)).toEqual(treeA1(text));
        expect(shown(text)).toBe(text);
    });

    test('a sheet behind a name and a colon shows in quotes, as bare it reads as a 3-D reference', () => {
        expect(stored("=Rate:'Sheet2'!B2")).toBe('=Rate:[s2]!R[1]C[-12]');
        expect(shown("=Rate:'Sheet2'!B2")).toBe("=Rate:'Sheet2'!B2");
        expect(shown("=A1:Rate:'NoSuch'!B2#")).toBe("=A1:Rate:'NoSuch'!B2#");
        expect(treeA1('=Rate:Sheet2!B2')).toMatchObject({ sheetKind: SheetKind.Span, sheet: 'Rate:Sheet2' });
        expect(shown('=Rate :Sheet2!B2')).toBe('=Rate :Sheet2!B2');
        expect(shown('=Sheet1!Rate:Sheet2!B2')).toBe('=Sheet1!Rate:Sheet2!B2');
    });

    test.each([
        ['=NoSuch!A1:NoSuch!B2', "='NoSuch'!RC[-13]:R[1]C[-12]", '=NoSuch!A1:B2'],
        ["='No Such'!$A$1:'No Such'!B2", "='No Such'!R1C1:R[1]C[-12]", "='No Such'!$A$1:B2"],
        ['=Sheet2!A1: Sheet2!B2', '=[s2]!RC[-13]: [s2]!R[1]C[-12]', '=Sheet2!A1: Sheet2!B2'],
        ['=Sheet2!A1:Sheet2!B2:C3', '=[s2]!RC[-13]:R[1]C[-12]:R[2]C[-11]', '=Sheet2!A1:B2:C3'],
        ['=Sheet2!A1:Sheet2!B2:Sheet2!C3', '=[s2]!RC[-13]:R[1]C[-12]:[s2]!R[2]C[-11]', '=Sheet2!A1:B2:Sheet2!C3'],
        ['=Sheet2!A1:Sheet2!Rate', '=[s2]!RC[-13]:[s2]!Rate', '=Sheet2!A1:Sheet2!Rate'],
        ['=A1:INDEX(Sheet2!B:B,5)', '=RC[-13]:INDEX([s2]!C[-12]:C[-12],5)', '=A1:INDEX(Sheet2!B:B,5)'],
    ])('a second corner may repeat the sheet of the first: %s is stored as %s and shows as %s', (text, kept, a1) => {
        expect(stored(text)).toBe(kept);
        expect(treeStored(kept)).toEqual(treeA1(text));
        expect(shown(text)).toBe(a1);
    });

    test.each([
        ['=Sheet2!A:Sheet2!B', '=[s2]!C[-13]:C[-12]', '=Sheet2!A:B'],
        ['=Sheet2!$A:Sheet2!$B', '=[s2]!C1:C2', '=Sheet2!$A:$B'],
        ['=Sheet2!1:Sheet2!2', '=[s2]!R:R[1]', '=Sheet2!1:2'],
        ["=sheet2!$1:'Sheet2'!3", '=[s2]!R1:R[2]', '=Sheet2!$1:3'],
        ['=SUM(Sheet2!A:Sheet2!A)', '=SUM([s2]!C[-13]:C[-13])', '=SUM(Sheet2!A:A)'],
        ["='No Such'!A:'No Such'!B", "='No Such'!C[-13]:C[-12]", "='No Such'!A:B"],
        ['=Jan:Dec!1:Jan:Dec!2', "='Jan:Dec'!R:R[1]", '=Jan:Dec!1:2'],
        ['=[1]Book!$A:[1]Book!B', "='[1]Book'!C1:C[-12]", '=[1]Book!$A:B'],
        ['=Sheet2!A:Sheet2!B:Sheet2!C', '=[s2]!C[-13]:C[-12]:[s2]!c', '=Sheet2!A:B:Sheet2!c'],
    ])('a whole column or row may repeat its sheet too: %s is stored as %s and shows as %s', (text, kept, a1) => {
        expect(stored(text)).toBe(kept);
        expect(treeStored(kept)).toEqual(treeA1(text));
        expect(shown(text)).toBe(a1);
        expect(stored(a1)).toBe(kept);
    });

    test.each([
        '=Sheet2!A:Sheet1!B',
        '=Sheet2!$A:Sheet1!$B',
        '=Sheet2!1:Sheet1!2',
        '=Sheet2!A:NoSuch!B',
        '=Sheet2!1:Sheet2!B',
        '=Sheet2!$A:Sheet2!2',
        '=Sheet2!1:Sheet2!',
        "=''!A1:5!B1",
        "=''!A:+!B",
    ])('and names no other sheet, and no other kind of end: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
    });

    test('stored text that repeats the sheet reads as the one range', () => {
        expect(treeStored('=[s2]!C1:[s2]!C2')).toEqual(treeStored('=[s2]!C1:C2'));
        expect(treeStored('=[s2]!R:[s2]!R[1]')).toEqual(treeStored('=[s2]!R:R[1]'));
        expect(treeStored("='x'!RC:'x'!R[1]C")).toEqual(treeStored("='x'!RC:R[1]C"));
        expect(parseStored('=[s2]!A:[s2]!B')).toMatchObject({ reason: 'syntax' });
        expect(parseStored('=[s2]!C1:[s1]!C2')).toMatchObject({ reason: 'syntax' });
    });

    test('a 3-D reference parses and is kept, and shows bare, as it reads back', () => {
        expect(shown('=SUM(Sheet1:Sheet3!A1)')).toBe('=SUM(Sheet1:Sheet3!A1)');
        expect(shown("=SUM('Sheet 1:Sheet 3'!A1)")).toBe("=SUM('Sheet 1:Sheet 3'!A1)");
        expect(stored('=SUM(Sheet1:Sheet3!A1:B2)', 'A1')).toBe("=SUM('Sheet1:Sheet3'!RC:R[1]C[1])");
        expect(treeA1('=Sheet1:Sheet3!A1')).toMatchObject({ sheetKind: SheetKind.Span, sheet: 'Sheet1:Sheet3' });
        expect(treeStored("='Sheet1:Sheet3'!RC")).toMatchObject({ sheetKind: SheetKind.Span, sheet: 'Sheet1:Sheet3' });
    });

    test.each([
        ['=SUM(Jan:Dec!B2)', 'Jan:Dec'],
        ['=SUM(Q:FY!B2)', 'Q:FY'],
        ['=SUM(a:b!B2)', 'a:b'],
        ['=SUM(Jan:Sheet3!B2)', 'Jan:Sheet3'],
        ['=SUM(Sheet1:Dec!B2)', 'Sheet1:Dec'],
    ])('the two sheets of a 3-D reference may read as columns: %s', (text, sheets) => {
        const tree = treeA1(text, 'A1');
        expect(tree.children[0]).toMatchObject({ kind: NodeKind.Ref, sheetKind: SheetKind.Span, sheet: sheets });
        expect(printStored(tree)).toBe(`=SUM('${sheets}'!R[1]C[1])`);
        const a1 = printA1(tree, 0, 0, sheetName);
        expect(a1).toBe(`=SUM(${sheets}!B2)`);
        expect(treeA1(a1, 'A1')).toEqual(tree);
        expect(treeStored(printStored(tree))).toEqual(tree);
    });

    test.each(['=A[1]:B[2]!C1', '=A[1]!C1', '=Sheet1:B[2]!C1', '=SUM(R[1]C:Dec!A1)'])(
        'a sheet name with a bracket needs quotes: %s does not parse',
        (text) => {
            expect(failure(text)).toBe('syntax');
        },
    );

    test('a quoted prefix with a bracket is another workbook in both grammars', () => {
        const tree = treeA1("='A[1]:B[2]'!C1", 'A1');
        expect(tree).toMatchObject({ sheetKind: SheetKind.External, sheet: 'A[1]:B[2]' });
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(parseStored('=A[1]:B[2]!RC')).toMatchObject({ reason: 'syntax' });
    });

    test('a reference to another workbook parses and is kept, and shows bare where it reads back', () => {
        expect(shown('=[1]Sheet1!$A$1')).toBe('=[1]Sheet1!$A$1');
        expect(shown("='[1]My Sheet'!$A$1")).toBe("='[1]My Sheet'!$A$1");
        expect(shown('=[1]!GlobalName')).toBe('=[1]!GlobalName');
        expect(shown("='[1]x'!$A$1:'[1]x'!B2")).toBe('=[1]x!$A$1:B2');
        expect(shown("='C:\\path\\[Book.xlsx]Sheet1'!A1")).toBe("='C:\\path\\[Book.xlsx]Sheet1'!A1");
        expect(stored('=[1]Sheet1!$A$1')).toBe("='[1]Sheet1'!R1C1");
        expect(stored('=[1]!GlobalName')).toBe("='[1]'!GlobalName");
        expect(treeA1('=[1]Sheet1!$A$1')).toMatchObject({ sheetKind: SheetKind.External, sheet: '[1]Sheet1' });
    });

    test.each([
        ['=[1]!Func(1)', '=[1]!Func(1)'],
        ['=[1]!PCovar($B$6:$B$17, 2 )', '=[1]!PCovar($B$6:$B$17, 2 )'],
        ['=[1]!wbname()', '=[1]!wbname()'],
        ['=1+[1]!Func(A1)(2)*3', '=1+[1]!Func(A1)(2)*3'],
        ["='C:\\x\\[Book.xlsx]'!Func(1)", "='C:\\x\\[Book.xlsx]'!Func(1)"],
        ["=[1]!'SGJ212,LA'", "=[1]!'SGJ212,LA'"],
        ["=[1]!'it''s'+1", "=[1]!'it''s'+1"],
        ["=[1]!'Rate'", '=[1]!Rate'],
        ["=[1]!'A1'", "=[1]!'A1'"],
        ["=[1]!'RC'", "=[1]!'RC'"],
        ["=[1]!''", "=[1]!''"],
        ['=[1]!TAX2(1)', "=[1]!'TAX2'(1)"],
        ['=[1]!R[1]C(1)', "=[1]!'R[1]C'(1)"],
        ["=[1]!'my fn'(1)", "=[1]!'my fn'(1)"],
        ['=SUM([2]A:B!B11)', '=SUM([2]A:B!B11)'],
        ['=SUM([2]Section3A:formulas!$B$11:C12)', '=SUM([2]Section3A:formulas!$B$11:C12)'],
        ['=[2]Jan:Dec!A:[2]Jan:Dec!B', '=[2]Jan:Dec!A:B'],
    ])('a function, a quoted name and a 3-D pair of another workbook parse and are kept: %s', (text, a1) => {
        const tree = treeA1(text);
        expect(shown(text)).toBe(a1);
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(treeA1(a1)).toEqual(tree);
        expect(shapeFacts(tree, new Map()) & Fact.Kept).toBe(Fact.Kept);
    });

    test('another workbook is a prefix kept as text on a name or a reference, and a call calls the name', () => {
        const call = treeA1('=[1]!Func(1)');
        expect(call.kind).toBe(NodeKind.Invoke);
        expect(call.children[0]).toMatchObject({
            kind: NodeKind.Name,
            text: 'Func',
            sheetKind: SheetKind.External,
            sheet: '[1]',
        });
        expect(call.children[1]).toMatchObject({ kind: NodeKind.Number, value: 1 });
        expect(treeA1("=[1]!'SGJ212,LA'")).toMatchObject({
            kind: NodeKind.Name,
            text: 'SGJ212,LA',
            sheetKind: SheetKind.External,
            sheet: '[1]',
        });
        expect(treeA1('=SUM([2]A:B!B11)').children[0]).toMatchObject({
            kind: NodeKind.Ref,
            sheetKind: SheetKind.External,
            sheet: '[2]A:B',
        });
        expect(stored('=[1]!Func(A1)', 'A1')).toBe("='[1]'!Func(RC)");
    });

    test.each([
        ...["=Sheet2!'x'", '=Sheet2!Func(1)', "='No Such'!Func(1)", '=Jan:Dec!Func(1)', "=Jan:Dec!'x'"],
        ...["=[1]!'x'!A1", "=[1]! 'x'", "=[1]!'x", '=[1]!(1)', '=[1]:B!A1', '=[1]A:!A1', '=[1]!5(1)'],
    ])('only another workbook has them: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
    });

    test.each([
        '=[s2]!Func(1)',
        "=[s2]!'x'",
        "='No Such'!Func(1)",
        "='Jan:Dec'!'x'",
        '=[1]!Func(1)',
        "='[1]'! Func(1)",
    ])('nor does stored text hold them for a sheet: %s does not parse', (text) => {
        expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
    });

    test('whitespace before the parenthesis of such a call is an intersection, as it is behind a sheet', () => {
        expect(group('=[1]!Func (B1)')).toBe("('[1]'!Func [RC[1]])");
    });

    test('#REF! behind a sheet is an error that keeps its sheet', () => {
        expect(shown('=Sheet2!#REF!')).toBe('=Sheet2!#REF!');
        expect(stored('=SUM(Sheet2!#REF!)')).toBe('=SUM([s2]!#REF!)');
    });

    test.each([
        ['=A1 #REF!', '(RC[-13] #REF!)'],
        ['=#REF! A1', '(#REF! RC[-13])'],
        ['=#REF!  #REF!', '(#REF! #REF!)'],
        ['=SUM(A1:B2 #REF!)', 'SUM((RC[-13]:R[1]C[-12] #REF!))'],
        ['=SUM(A1:B2 Sheet2!#REF!)', 'SUM((RC[-13]:R[1]C[-12] [s2]!#REF!))'],
        ['=#REF!#', '(#REF!#)'],
        ['=Sheet2!#REF!#', '([s2]!#REF!#)'],
        ['=A1:#REF!', '(RC[-13]:#REF!)'],
        ['=#REF!:A1', '(#REF!:RC[-13])'],
        ['=(#REF!,A1)', '[(#REF!,RC[-13])]'],
        ['=Sheet2!A1:Sheet2!#REF!', '([s2]!RC[-13]:[s2]!#REF!)'],
        ['=#ref! (A1)', '(#REF! [RC[-13]])'],
    ])('#REF! stands where a reference may: %s', (text, expected) => {
        const tree = treeA1(text);
        expect(grouped(tree)).toBe(expected);
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(treeA1(shown(text))).toEqual(tree);
    });

    test.each([
        ['=#REF!A1', '#REF!'],
        ['=#REF!$A$1', '#REF!'],
        ['=#ReF!xfd1048576', '#REF!'],
        ['=SUM(#REF!A1:B2)', 'SUM(#REF!)'],
        ['=#REF!A:B+1', '(#REF!+1)'],
        ['=#REF!$1:2', '#REF!'],
        ['=1+#REF!A1*2', '(1+(#REF!*2))'],
        ['=#REF!A1:#REF!B2', '(#REF!:#REF!)'],
        ['=#REF!A1#', '(#REF!#)'],
        ['=A1 #REF!B1', '(RC[-13] #REF!)'],
    ])('the cells Excel writes behind the #REF! of a deleted sheet are dropped: %s', (text, expected) => {
        const tree = treeA1(text);
        expect(grouped(tree)).toBe(expected);
        expect(treeStored(printStored(tree))).toEqual(tree);
        expect(treeA1(shown(text))).toEqual(tree);
    });

    test('that #REF! is the leaf of a reference that broke, with its whitespace', () => {
        expect(treeA1('=#REF!A1')).toEqual(treeA1('=#REF!'));
        expect(shown('= #REF!A1 + 1')).toBe('= #REF! + 1');
        expect(shown("='[1]x y'!#REF!")).toBe("='[1]x y'!#REF!");
        expect(shown('=SUM(Sheet2!A1:#REF!)')).toBe('=SUM(Sheet2!A1:#REF!)');
    });

    test.each(['=#REF!Rate', '=#REF!A', '=#REF!5', '=#REF!A1B', '=#N/AA1', '=#REF!"a"', '=#REF!#REF!'])(
        'only cells stand there: %s does not parse',
        (text) => {
            expect(failure(text)).toBe('syntax');
        },
    );

    test.each(['=#REF!RC', '=#REF!R1C1', '=#REF!A1', '=#REF!C:C'])(
        'the stored form never holds that spelling: %s does not parse',
        (text) => {
            expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
        },
    );

    test('a reference that left the grid or lost its sheet shows as text that parses', () => {
        const tree = treeA1('=SUM(A1:B2 C1)+A1#+Sheet2!A1', 'C3');
        const gone = treeStored('=SUM([gone]!RC [gone]!R1C1:R2C2)+[gone]!RC#');
        for (const a1 of [printA1(tree, 0, 0, sheetName), printA1(gone, 0, 0, sheetName)]) {
            expect(a1).toContain('#REF!');
            const back = treeA1(a1, 'A1');
            expect(treeStored(printStored(back))).toEqual(back);
        }
    });

    test.each(['=1 #REF!', '=A1 #N/A', '=#N/A#', '=Sheet2!#N/A', '=#N/A A1', '="a" #REF!'])(
        'no other error does: %s does not parse',
        (text) => {
            expect(failure(text)).toBe('syntax');
        },
    );

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

    test.each([
        '=R',
        '=C',
        '=R5',
        '=C3',
        '=R+1',
        '=SUM(C)',
        '=[s2]!R',
        "='x'!C2",
        '=A:B',
        '=a:xfd',
        '=[s2]!A:B',
        '=Jan:Dec',
        '=RC:A:B',
        '=rc:C[1]:C[3]',
        '=F:C1:C2',
        '=SUM:C1:C2#',
        '=A:B:RC',
    ])('stored text that would show as a reference is refused: %s', (text) => {
        expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
    });

    test.each([
        ['=R', '=r'],
        ['=LET(C,1,C)', '=LET(c,1,c)'],
        ['=Sheet2!RC', '=[s2]!rc'],
        ['=A :B', '=A :B'],
        ['=A: B', '=A: B'],
        ['=XFE:XFF', '=XFE:XFF'],
        ['=Rate:Total', '=Rate:Total'],
        ['=Sheet2!Rate:Sheet2!B', '=[s2]!Rate:[s2]!B'],
        ['=rc:SUM(A1)', '=rc:SUM(RC[-13])'],
        ['=A:B:C', '=C[-13]:C[-12]:c'],
        ['=A1:B', '=RC[-13]:B'],
        ['=x:INDEX(A:A,1)', '=x:INDEX(C[-13]:C[-13],1)'],
    ])('what a person types that looks like one is kept apart: %s is stored as %s', (text, kept) => {
        const tree = treeA1(text);
        expect(printStored(tree)).toBe(kept);
        expect(treeStored(kept)).toEqual(tree);
        expect(stored(printA1(tree, ...at('N1'), sheetName))).toBe(kept);
    });

    test.each([
        ...['=1:11.', '=1.:11', '=1:1E1', '=1:2.5', '=0:5', '=1:9999999', '=SUM(1.0:2)', '=1 :11', '=1:A', '=A1:1.:2'],
        ...['=1.:1:2', '=1:2:3', '=A1:"a"', '=TRUE:A1', '=A1:-B1', '=A1:#N/A', '=A1:{1}', '=A1%:B1'],
    ])('a colon joins only what may yield a reference: %s does not parse', (text) => {
        expect(failure(text)).toBe('syntax');
        expect(parseStored(text)).toMatchObject({ reason: 'syntax' });
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
