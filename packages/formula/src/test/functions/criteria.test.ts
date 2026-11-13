import { describe, expect, test } from 'bun:test';
import { DIV0, NA, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, valueAt } from '../recalc/support';

// One cell of every kind in A, a power of two beside it in B: a SUMIF over them names the rows that matched.
const KINDS: Cells = {
    A1: 1,
    A2: '1',
    A3: 10,
    A4: 'apple',
    A5: 'Apple pie',
    A7: '=""',
    A8: true,
    A9: 'TRUE',
    A10: NA,
    A11: 'a*b',
    A12: 0,
    A13: 45292,
    A14: 0.1,
    B1: 1,
    B2: 2,
    B3: 4,
    B4: 8,
    B5: 16,
    B6: 32,
    B7: 64,
    B8: 128,
    B9: 256,
    B10: 512,
    B11: 1024,
    B12: 2048,
    B13: 4096,
    B14: 8192,
};

describe('a criterion names its rows', () => {
    test.each([
        ['1', 3, 2],
        ['"1"', 3, 2],
        ['"=1"', 3, 2],
        ['"1.0"', 3, 2],
        ['">0"', 12293, 4],
        ['">=1"', 4101, 3],
        ['"<1"', 10240, 2],
        ['"<=0"', 2048, 1],
        ['"<>1"', 16382, 13],
        ['"0"', 2048, 1],
        ['"<>0"', 14335, 13],
        ['"apple"', 8, 1],
        ['"APPLE"', 8, 1],
        ['"apple*"', 24, 2],
        ['"*pie"', 16, 1],
        ['"?pple"', 8, 1],
        ['"*"', 1370, 6],
        ['"?*"', 1306, 5],
        ['""', 96, 2],
        ['"="', 32, 1],
        ['"<>"', 16351, 13],
        ['"<>*"', 15013, 8],
        ['"<>?*"', 15077, 9],
        ['"<>apple"', 16375, 13],
        ['TRUE', 128, 1],
        ['"true"', 128, 1],
        ['FALSE', 0, 0],
        ['"#N/A"', 512, 1],
        ['"<>#N/A"', 15871, 13],
        ['#N/A', 512, 1],
        ['"a~*b"', 1024, 1],
        ['"a*b"', 1024, 1],
        ['"~*"', 0, 0],
        ['"10%"', 8192, 1],
        ['45292', 4096, 1],
        ['">=1/1/2024"', 4096, 1],
        ['">5"', 4100, 2],
        ['">a"', 1304, 4],
        ['"<a"', 66, 2],
        ['C1', 2048, 1],
        ['"apple "', 0, 0],
        ['"=apple pie"', 16, 1],
        ['"=*"', 1370, 6],
        ['"=TRUE"', 128, 1],
        ['"<>TRUE"', 16255, 13],
        ['">=10"', 4100, 2],
        ['">"', 0, 0],
        ['">="', 0, 0],
        ['"<"', 0, 0],
        ['"<="', 0, 0],
        ['"<#N/A"', 0, 0],
        ['">FALSE"', 128, 1],
    ])('%s', (criterion, sum, count) => {
        expect(evaluate(`=SUMIF(A1:A14,${criterion},B1:B14)`, KINDS)).toBe(sum);
        expect(evaluate(`=COUNTIF(A1:A14,${criterion})`, KINDS)).toBe(count);
        expect(evaluate(`=SUMIFS(B1:B14,A1:A14,${criterion})`, KINDS)).toBe(sum);
        expect(evaluate(`=COUNTIFS(A1:A14,${criterion})`, KINDS)).toBe(count);
    });

    test('>< is greater than the text <, by the engine own order of text', () => {
        expect(evaluate('=COUNTIF(A1:A4,"><")', { A1: '<', A2: '>', A3: 'a', A4: 5 })).toBe(2);
        expect(evaluate('=SUMIF(A1:A14,"><",B1:B14)', KINDS)).toBe(1306);
    });

    test('an array of criteria gives one result each', () => {
        expect(evaluate('=SUMIF(A1:A14,{1,"apple"},B1:B14)', KINDS)).toBe(3);
        expect(evaluate('=INDEX(SUMIF(A1:A14,{1,"apple"},B1:B14),1,2)', KINDS)).toBe(8);
        expect(evaluate('=SUM(COUNTIF(A1:A14,{1,"apple"}))', KINDS)).toBe(3);
        expect(evaluate('=SUM(SUMIF(A1:A3,{"a","b"},B1:B3))', { A1: 'a', A2: 'b', A3: 'a', B1: 1, B2: 2, B3: 4 })).toBe(
            7,
        );
    });

    test('a criterion in a cell is read as text with its operator', () => {
        const years = { I1: 2000, I2: 2001, I3: 2006, I4: 2007, I5: 2008, I6: 2009, K1: '>2006', K2: '2006' };
        expect(evaluate('=COUNTIF(I1:I6,K1)', years)).toBe(3);
        expect(evaluate('=COUNTIF(I1:I6,K2)', years)).toBe(1);
        expect(evaluate('=COUNTIF(I1:I6,">="&K2)', years)).toBe(4);
    });

    test('text is ordered without its case, and a blank is no text', () => {
        const fruit = { L1: 'apple', L2: 'pear', L3: 'pomelo', L4: 'melon' };
        expect(evaluate('=COUNTIF(L1:L5,">=P")', fruit)).toBe(2);
        const letters = { Z3: 'A', Z4: 'B', Z5: 'C', Y2: 1, Y3: 10, Y4: 100, Y5: 1000, Y6: 10000 };
        expect(evaluate('=SUMIF(Z2:Z6,"=B",Y2:Y6)', letters)).toBe(100);
        expect(evaluate('=SUMIF(Z2:Z6,"<>B",Y2:Y6)', letters)).toBe(11011);
        expect(evaluate('=SUMIF(Z2:Z6,"<B",Y2:Y6)', letters)).toBe(10);
        expect(evaluate('=SUMIF(Z2:Z6,">B",Y2:Y6)', letters)).toBe(1000);
        expect(evaluate('=SUMIF(Z2:Z6,"<=B",Y2:Y6)', letters)).toBe(110);
        expect(evaluate('=SUMIF(Z2:Z6,">=B",Y2:Y6)', letters)).toBe(1100);
        expect(evaluate('=SUMIF(Z2:Z6,"=",Y2:Y6)', letters)).toBe(10001);
        expect(evaluate('=SUMIF(Z2:Z6,"<>",Y2:Y6)', letters)).toBe(1110);
    });

    test('text is matched whole, in any case', () => {
        const cells = { Q3: 'abc', Q4: 'ABC', Q5: 'Abc', Q6: 'aBc', Q7: 'Abc', Q8: 'a', Q9: 'A', Q10: 'A', Q11: 'A' };
        expect(evaluate('=COUNTIF(Q3:Q11,"abc")', cells)).toBe(5);
        expect(evaluate('=COUNTIF(Q3:Q11,"a")', cells)).toBe(4);
        expect(evaluate('=COUNTIF(Q3:Q11,"a?c")', cells)).toBe(5);
        expect(evaluate('=COUNTIF(A1:A2,"STRASSE")', { A1: 'straße', A2: 'Strasse' })).toBe(2);
    });

    test.each([
        ['a*', 3],
        ['*c?', 1],
        ['a*c', 2],
        ['*2?*b*', 1],
        ['*2?*b', 0],
        ['*', 5],
        ['?', 1],
        ['a?c', 2],
        ['a??', 2],
        ['*~?', 1],
        ['~~', 1],
        ['a~bc', 1],
        ['**a**', 4],
    ])('the wildcard pattern %s', (pattern, count) => {
        const cells = { A1: 'abcd1234ab12', A2: 'abc', A3: 'what?', A4: '~', A5: 'acc', A6: 12 };
        expect(evaluate(`=COUNTIF(A1:A6,"${pattern}")`, cells)).toBe(count);
    });

    test('only equality reads a text cell as a number', () => {
        const cells = { I49: 5, I50: '5', I51: 55, I52: '55', I53: '5.0', I54: ' 5 ', I55: '$5' };
        expect(evaluate('=COUNTIF(I49:I55,"=5")', cells)).toBe(5);
        expect(evaluate('=COUNTIF(I49:I55,5)', cells)).toBe(5);
        expect(evaluate('=COUNTIF(I49:I55,">2")', cells)).toBe(2);
        expect(evaluate('=COUNTIF(I49:I55,"<>5")', cells)).toBe(6);
        expect(evaluate('=COUNTIF(I46:L46,F46)', { F46: '3', I46: '3' })).toBe(1);
    });

    test('an error in the range is no match and no result', () => {
        expect(evaluate('=COUNTIF(F20:F22,"=0")', { F20: DIV0, F21: 0, F22: 1 })).toBe(1);
        expect(evaluate('=SUMIF(A1:A3,">0",B1:B3)', { A1: 1, A2: NA, A3: 3, B1: 1, B2: 2, B3: 4 })).toBe(5);
    });

    test('numbers are equal on 15 digits', () => {
        const cells = { A1: 0.1, A2: 0.2, A3: 0.3, B1: 1, B2: 1, B3: 1 };
        expect(evaluate('=SUMIF(A1:A3,"="&(0.1+0.2),B1:B3)', cells)).toBe(1);
        expect(evaluate('=SUMIF(A1:A3,0.1+0.2,B1:B3)', cells)).toBe(1);
        expect(evaluate('=COUNTIF(A1:A3,"<>"&(0.1+0.2))', cells)).toBe(2);
        expect(evaluate('=COUNTIF(A1:A3,">="&(0.1+0.2))', cells)).toBe(1);
    });

    test('a text id of 16 digits equals another that agrees in 15', () => {
        expect(evaluate('=COUNTIF(A1:A2,A1)', { A1: '1234567890123456', A2: '1234567890123457' })).toBe(2);
    });

    test('a criterion has no length limit', () => {
        const long = 'a'.repeat(300);
        expect(evaluate('=SUMIF(A1:A3,C1)', { A1: 1, A2: 2, A3: 3, C1: long })).toBe(0);
        expect(evaluate('=COUNTIF(A1:A3,C1)', { A1: long, A2: `${long}b`, A3: 3, C1: long })).toBe(1);
        expect(evaluate('=COUNTIF(A1:A3,C1&"*")', { A1: long, A2: `${long}b`, A3: 3, C1: long })).toBe(2);
    });
});

describe('blank cells', () => {
    test('the empty criterion counts blanks and empty text, = only blanks, <> all that is not blank', () => {
        const mixed = { J30: 1, J31: '=""', J32: '=""', J33: 1, J34: '=""', J35: '=""' };
        expect(evaluate('=COUNTIF(J30:J35,"")', mixed)).toBe(4);
        expect(evaluate('=COUNTIF(P20:R23,"")')).toBe(12);
        expect(evaluate('=COUNTIF(I44:L44,"=")', { I44: '=""' })).toBe(3);
        expect(evaluate('=COUNTIF(I45:L45,"<>")', { I45: '=""' })).toBe(1);
        expect(evaluate('=COUNTIF(A1:C1,"")', { B1: '=""', C1: '=A1' })).toBe(2);
        expect(evaluate('=COUNTIF(A1:C1,"<>")', { B1: '=""', C1: '=A1' })).toBe(2);
    });

    test('<> of a value counts blank cells, also past the last used row', () => {
        expect(evaluate('=COUNTIF(A33:A35,"<>7")', { A34: 7, A35: 8 })).toBe(2);
        expect(evaluate('=COUNTIF(A1:A100,"<>7")', { A1: 7, A2: 8 })).toBe(99);
        expect(evaluate('=COUNTIF(A:A,"<>7")', { A1: 7, A2: 8 })).toBe(1048575);
        expect(evaluate('=COUNTIF(A:C,"")', { A1: 7, B2: '=""' })).toBe(3 * 1048576 - 1);
        expect(evaluate('=COUNTIF(A:A,"<>x")', { A1: 'x', A2: 'X', A3: 'y' })).toBe(1048574);
    });

    test('an ordering criterion never counts a blank', () => {
        const cells = { O3: 1999, O4: 2000, O5: 0, O6: 0, O7: 0, O8: 2002, O9: 2001, O10: 'X', O11: 2002, V1: '>=0' };
        expect(evaluate('=COUNTIF(O3:O15,V1)', cells)).toBe(8);
        expect(evaluate('=COUNTIF(O3:O15,W1)', { ...cells, W1: 0 })).toBe(3);
        expect(evaluate('=COUNTIF(O3:O15,W2)', cells)).toBe(3);
    });

    test('several criteria over columns of different lengths', () => {
        const cells = { A1: 'x', A2: 'x', B1: 1, B2: 2, B3: 3, B4: 4, C1: 10, C2: 20, C3: 30, C4: 40, C5: 50 };
        expect(evaluate('=COUNTIFS(A1:A9,"",B1:B9,"<>2")', cells)).toBe(7);
        expect(evaluate('=COUNTIFS(A1:A9,"<>y",B1:B9,"")', cells)).toBe(5);
        expect(evaluate('=SUMIFS(C1:C9,A1:A9,"",B1:B9,"<>3")', cells)).toBe(90);
        expect(evaluate('=SUMIFS(C1:C9,A1:A9,"<>x",B1:B9,"")', cells)).toBe(50);
        expect(evaluate('=SUMIFS(C1:C9,A1:A9,"x",B1:B9,">1")', cells)).toBe(20);
        expect(evaluate('=COUNTIFS(A1:A9,"x",B1:B9,"<>1")', cells)).toBe(1);
        expect(evaluate('=COUNTIFS(D1:D9,"",A1:A9,"x")', cells)).toBe(2);
        expect(evaluate('=SUMIF(D1:D9,"",C1:C9)', cells)).toBe(150);
    });
});

describe('the cells that are added, averaged and compared', () => {
    const TEN: Cells = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, B1: 10, B2: 20, B3: 30, B4: 40, B5: 50 };

    test.each([
        ['=SUMIF(A1:A3,">0")', { A1: 1, A2: 'x', A3: 3 }, 4],
        ['=SUMIF(A1:A3,">0",B1:B3)', { A1: 1, A2: 2, A3: 3, B1: 10, B2: 'x', B3: true }, 10],
        ['=SUMIF(A1:A3,">1",B1:B3)', { A1: 1, A2: 2, A3: 3, B1: 10, B2: DIV0, B3: 30 }, DIV0],
        ['=SUMIF(A1:A3,"<2",B1:B3)', { A1: 1, A2: 2, A3: 3, B1: 10, B2: DIV0, B3: 30 }, 10],
        ['=SUMIF(A1:A3,">0",B1:B3)', { A1: 1, A2: 2, A3: 3, B1: 10, B2: DIV0, B3: NA }, DIV0],
        ['=SUMIF(A1:A5,">2",B1)', TEN, 120],
        ['=SUMIF(A1:A5,">2",B1:B2)', TEN, 120],
        ['=SUMIF(A1:A5,">2",B2:B9)', TEN, 90],
        ['=SUMIF(A2:A5,">2",B1048575)', { ...TEN, B1048575: 7, B1048576: 9 }, 9],
        ['=SUMIF(B1:B5,">15")', TEN, 140],
        ['=SUMIFS(B1:B5,A1:A4,">2")', TEN, VALUE],
        ['=SUMIFS(B1:B5,A1:A5,">1",A1:A5,"<5")', TEN, 90],
        ['=SUMIFS(B1:B5,A1:A5,">1",A1:A5)', TEN, VALUE],
        ['=SUMIFS(B1:B5,A1:A5,">1",A1:E1,"<5")', TEN, VALUE],
        ['=SUMIFS(B2:B5,A1:A4,">2")', TEN, 90],
        ['=COUNTIFS(A1:A5,">1",B1:B5,"<50")', TEN, 3],
        ['=COUNTIFS(A1:A5,">1",B1:B4,"<50")', TEN, VALUE],
        ['=COUNTIF(A1,1)', TEN, 1],
        ['=AVERAGEIF(A1:A5,">9")', TEN, DIV0],
        ['=AVERAGEIF(A1:A5,">3")', TEN, 4.5],
        ['=AVERAGEIF(A1:A5,">3",B1)', TEN, 45],
        ['=AVERAGEIF(A1:A3,"<>2")', { A1: -1, A2: 2, A3: 1 }, 0],
        ['=AVERAGEIF(A1:A3,">0",B1:B3)', { A1: 1, A2: 2, A3: 3, B1: 10, B2: 'x', B3: true }, 10],
        ['=AVERAGEIFS(B1:B5,A1:A5,">1",A1:A5,"<4")', TEN, 25],
        ['=AVERAGEIFS(B1:B5,A1:A5,">9")', TEN, DIV0],
        ['=AVERAGEIFS(A2:C2,A1:C1,">1")', { A1: 1, B1: 2, C1: 3, A2: 10, B2: 20, C2: 30 }, 25],
        ['=MAXIFS(B1:B5,A1:A5,">9")', TEN, 0],
        ['=MAXIFS(B1:B5,A1:A5,"<4")', TEN, 30],
        ['=MAXIFS(B1:B5,A1:A5,"<4",B1:B5,"<>30")', TEN, 20],
        ['=MINIFS(B1:B5,A1:A5,">1")', TEN, 20],
        ['=MINIFS(B1:B5,A1:A5,">9")', TEN, 0],
        ['=MAXIFS(B1:B5,A1:A5,">1")', { ...TEN, B3: NA }, NA],
        ['=MINIFS(B1:B5,A1:A5,"<3")', { ...TEN, B3: NA }, 10],
        ['=MAXIFS(B1:B3,A1:A3,">0")', { A1: 1, A2: 2, A3: 3, B1: -5, B2: 'x', B3: -7 }, -5],
        ['=SUMIFS(A1:B2,A1:B2,">1")', { A1: 1, B1: 2, A2: 3, B2: 4 }, 9],
        ['=COUNTIFS(A1:B2,">1",A1:B2,"<4")', { A1: 1, B1: 2, A2: 3, B2: 4 }, 2],
        ['=SUMIF(A1:A9,">2",M1:M2)', { A1: 1, A2: 2, A3: 3, A4: 4, M1: 10, M2: 20, M3: 30, M4: 40 }, 70],
    ])('%s', (formula, cells, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a date in a criterion is its day number', () => {
        const cells = { F2: 1, F3: 2, F4: 3, F5: 4, F6: 5, F7: 6, G2: 40664, G3: 40665, G4: 40666, G5: 40667 };
        expect(evaluate('=COUNTIFS(F2:F7,"<5",G2:G7,"<5/3/2011")', cells)).toBe(2);
    });

    test('a range must be cells, and an error given as one is the result', () => {
        expect(evaluate('=SUMIF({-10;10;20;30},">0")')).toBe(VALUE);
        expect(evaluate('=COUNTIF({1,2},1)')).toBe(VALUE);
        expect(evaluate('=COUNTIF(5,5)')).toBe(VALUE);
        expect(evaluate('=SUMIFS(A1:A3*1,A1:A3,1)', { A1: 1 })).toBe(VALUE);
        expect(evaluate('=COUNTIF(#REF!,1)')).toBe(REF);
        expect(evaluate('=SUMIF(A1:A3,1,1/0)', { A1: 1 })).toBe(DIV0);
        expect(evaluate('=COUNTIFS(A1:A3,1,A1:A3)', { A1: 1 })).toBe(VALUE);
    });

    test('a range on another sheet, with formulas that are still to be computed', () => {
        const engine = engineOf({
            s1: { A1: '=SUMIFS(Data!C1:C4,Data!A1:A4,"k"&B1,Data!B1:B4,">1")', B1: '=1+1' },
            data: {
                A1: '="k"&2',
                A2: 'k2',
                A3: 'K2',
                A4: 'k3',
                B1: '=1',
                B2: '=B1+1',
                B3: 3,
                C1: 1,
                C2: '=C1*2',
                C3: 4,
                C4: 8,
            },
        });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(6);
    });

    test('a formula that counts its own column is on a loop only when it reads itself', () => {
        const engine = engineOf({ s1: { A1: 1, A2: 1, A3: '=COUNTIF(A1:A2,1)', A4: '=COUNTIF(A1:A4,1)', A5: '=A3' } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A3')).toBe(2);
        expect(valueAt(engine, 'A5')).toBe(2);
        expect(valueAt(engine, 'A4')).toBe(REF);
    });
});
