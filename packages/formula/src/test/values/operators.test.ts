import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NAME, NULL, NUM, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, valueAt } from '../recalc/support';

describe('coercion to number', () => {
    test.each([
        ['="1"+1', 2],
        ['="1e3"*1', 1000],
        ['=" 1 "+1', 2],
        ['="1,000"+1', 1001],
        ['="$5"+1', 6],
        ['="50%"+0', 0.5],
        ['="1 1/2"+0', 1.5],
        ['="(5)"+0', -5],
        ['="2020-01-31"+0', 43861],
        ['="12:00"+0', 0.5],
        ['=".5"+0', 0.5],
        ['="5."+0', 5],
        ['=TRUE+1', 2],
        ['=TRUE*TRUE', 1],
        ['=-TRUE', -1],
        ['=A1+1', 1],
        ['=A1*A2', 0],
        ['=-"5"', -5],
        ['="5"%', 0.05],
        ['=5%%', 0.0005],
        ['=+"5"', '5'],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test.each([
        ['="abc"+1'],
        ['=" "+1'],
        ['="TRUE"+1'],
        ['="1.000,5"+0'],
        ['="0x1A"+0'],
        ['="1e"+0'],
        ['="1 2"+0'],
        ['="Infinity"+0'],
    ])('%s is #VALUE!', (formula) => {
        expect(evaluate(formula)).toBe(VALUE);
    });

    // The picks taken from Google: empty text is 0 in arithmetic, where Excel answers #VALUE!.
    test.each([
        ['=""*0', 0],
        ['=""+1', 1],
        ['=B1+1', 1],
    ])('empty text is zero: %s is %p', (formula, expected) => {
        expect(evaluate(formula, { B1: '=""' })).toBe(expected);
    });
});

describe('arithmetic', () => {
    test.each([
        ['=-2^2', 4],
        ['=2^3^2', 64],
        ['=1+2*3', 7],
        ['=(1+2)*3', 9],
        ['=7/2', 3.5],
        ['=1E-308/1E10', 0],
        ['=0*-1', 0],
        ['=2^0.5', Math.SQRT2],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test.each([
        ['=0^0', NUM],
        ['=A1^0', NUM],
        ['=0^-1', DIV0],
        ['=(-8)^0.5', NUM],
        ['=1E308*10', NUM],
        ['=1/0', DIV0],
        ['=0/0', DIV0],
        ['=1/(0*-1)', DIV0],
    ])('%s is an error', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test('an odd root of a negative number is real', () => {
        expect(evaluate('=(-8)^(1/3)')).toBeCloseTo(-2, 12);
    });

    test('zero is never negative', () => {
        expect(Object.is(evaluate('=0*-1'), 0)).toBe(true);
        expect(Object.is(evaluate('=-A1'), 0)).toBe(true);
    });
});

describe('text', () => {
    test.each([
        ['="1"&1', '11'],
        ['=1&TRUE', '1TRUE'],
        ['=A1&"x"', 'x'],
        ['=1/3&""', '0.333333333333333'],
        ['=2/3&""', '0.666666666666667'],
        ['=0.1+0.2&""', '0.3'],
        ['=1E+20&""', '1E+20'],
        ['=123456789012&""', '123456789012'],
        ['=A1&A1', ''],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test('a text result that reads like an error stays text', () => {
        expect(evaluate('="#N/"&"A"')).toBe('#N/A');
        expect(evaluate('=IFERROR("#N/"&"A","caught")')).toBe('#N/A');
    });
});

describe('comparison', () => {
    test.each([
        ['=1<"a"', true],
        ['="a"<TRUE', true],
        ['=TRUE>1E+300', true],
        ['=TRUE=1', false],
        ['=1="1"', false],
        ['=10<"9"', true],
        ['="10"<"9"', true],
        ['="1/2/2020"="01/02/2020"', false],
        ['="a"="A"', true],
        ['="a"<"B"', true],
        ['="Z"<"a"', false],
        ['="a"="á"', false],
        ['="abc"<"abcd"', true],
        ['="straße"="STRASSE"', true],
        ['=TRUE>FALSE', true],
        ['=A1=0', true],
        ['=A1=""', true],
        ['=A1=FALSE', true],
        ['=A1=A2', true],
        ['=A1<1', true],
        ['=A1>-1', true],
        ['=A1<"a"', true],
        ['=""=0', false],
        ['=""<0', false],
        ['=1<>2', true],
        ['=2>=2', true],
        ['=2<=1', false],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test('a blank equals the empty text a formula made', () => {
        const cells: Cells = { B1: '=""' };
        expect(evaluate('=A1=B1', cells)).toBe(true);
        expect(evaluate('=B1=0', cells)).toBe(false);
    });
});

describe('precision', () => {
    test.each([
        ['=0.1+0.2=0.3', true],
        ['=(0.1+0.2-0.3)=0', false],
        ['=4.1-4=0.1', false],
        ['=1/3*3=1', true],
        ['=2^53+1=2^53', true],
        ['=0.1*3=0.3', true],
        ['=49/49=1', true],
        ['=0.1+0.2>0.3', false],
        ['=0.1+0.2<0.3', false],
    ])('numbers compare on 15 digits: %s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });

    test('arithmetic keeps the whole double', () => {
        expect(evaluate('=(43.1-43.2)+1')).toBe(0.8999999999999986);
        expect(evaluate('=30.2-30')).toBe(0.1999999999999993);
        expect(evaluate('=1E+15+0.3')).toBe(1000000000000000.2);
    });

    // Excel on the web, 11 Nov 2026: only the last + or - of a formula snaps to zero.
    test.each([
        ['=0.1+0.2-0.3', 0],
        ['=(0.1+0.2-0.3)', 5.551115123125783e-17],
        ['=0.1+0.2-0.3+0', 5.551115123125783e-17],
        ['=1*(0.5-0.4-0.1)', -2.7755575615628914e-17],
        ['=1-0.9-0.1', 0],
        ['=1.333+1.225-1.333-1.225', 0],
        ['=SUM(0.1,0.2,-0.3)', 0],
        ['=SUM(0.1,0.2,-0.3)+1', 1],
        ['=SUM(A1:A3)', 0],
        ['=SUM(A1:A3)*1', 0],
        ['=SUM(0.1,0.2,-0.3,1E-20)', 5.552115123125783e-17],
        ['=SUM(0.1,0.2,-0.3,0)', 5.551115123125783e-17],
        ['=SUM(A1:A3,B9)', 0],
        ['=SUM(A1:A2,(0.1+0.2-0.3))', 0.30000000000000004 + 5.551115123125783e-17],
        ['=SUMPRODUCT(A1:A3)', 5.551115123125783e-17],
        ['=IF(TRUE,0.1+0.2-0.3)', 5.551115123125783e-17],
        ['=-0.3+0.1+0.2', 0],
        ['=0.1+0.2+-0.3', 0],
    ])('the zero snap: %s is %p', (formula, expected) => {
        expect(evaluate(formula, { A1: 0.1, A2: 0.2, A3: -0.3 })).toBe(expected);
    });

    test('a snapped sum is the same whichever loop added it', () => {
        const cells: Cells = { A1: 0.1, A2: 0.2, A3: -0.3, A4: 'text', B1: 0.1, B2: 0.2, B3: -0.3, B4: NA };
        expect(evaluate('=SUM(A1:A9)', cells)).toBe(0);
        expect(evaluate('=SUM(A1:A3*1)', cells)).toBe(0);
        expect(evaluate('=IFERROR(SUM(B1:B4),SUM(B1:B3))', cells)).toBe(0);
    });
});

describe('errors', () => {
    const cells: Cells = { A1: NA, A2: DIV0, A3: 1 };

    test.each([
        ['=#N/A+#DIV/0!', NA],
        ['=1/0+NA()', DIV0],
        ['="a"+#N/A', VALUE],
        ['=#N/A+"a"', NA],
        ['="a"&#N/A', NA],
        ['=#N/A=1', NA],
        ['=#N/A=#DIV/0!', NA],
        ['=1=#N/A', NA],
        ['=A2+A1', DIV0],
        ['=-A1', NA],
        ['=A1%', NA],
        ['=NOSUCHFN(1)', NAME],
        ['=nosuchname', NAME],
        ['=A1:A2 A3:A4', NULL],
        ['=SUM(B1:B2 C1:C2)', NULL],
        ['=Nowhere!A1', REF],
        ['=SUM(Nowhere!A1:A3)', REF],
        ['=A1#', REF],
    ])('%s is an error', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a reference that leaves the grid is #REF!', () => {
        const engine = engineOf({ s1: { B2: '=A1' } });
        engine.setFormula('s1', 0, 0, '=R[-1]C[-1]');
        engine.setFormula('s1', 0, 2, '=SUM(R[-1]C[1]:RC[1])');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(REF);
        expect(valueAt(engine, 'C1')).toBe(REF);
    });

    test('text that does not parse is kept and shows #ERROR!', () => {
        const engine = engineOf({ s1: { A1: 1 } });
        engine.setFormula('s1', 0, 1, '==R[1]C[1](');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'B1')).toMatchObject({ text: '#ERROR!' });
    });

    test('an error only a file knows is carried, and is an error to a formula', () => {
        const engine = engineOf({ s1: { B1: '=IFERROR(A1,"caught")', C1: '=A1' } });
        engine.setValue('s1', 0, 0, { ...NA, text: '#BUSY!', code: 0 });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'B1')).toBe('caught');
        expect(valueAt(engine, 'C1')).toMatchObject({ text: '#BUSY!' });
    });
});

describe('references', () => {
    const cells: Cells = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 };

    test.each([
        ['=A2', 2],
        ['=$B$3', 30],
        ['=SUM(A1:B3)', 66],
        ['=SUM(A:A)', 6],
        ['=SUM(2:2)', 22],
        ['=SUM(B3:A1)', 66],
        ['=SUM((A1:A3,B1))', 16],
        ['=SUM(A1:B2 B1:B3)', 30],
        ['=SUM(A1:INDEX(B1:B3,2))', 33],
        ['=SUM(A1:A2:B3)', 66],
        ['=Sheet2!A1+A1', 101],
        ['=SUM(Sheet2!A:A)', 300],
        ['=(A1)', 1],
        ['=((A1:A3)) A2:B2', 2],
    ])('%s is %p', (formula, expected) => {
        const engine = engineOf({ s1: { ...cells, N1: formula }, s2: { A1: 100, A2: 200 } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'N1')).toBe(expected);
    });

    test('a range is #VALUE! where two sheets or a value would have to make one', () => {
        expect(evaluate('=SUM(A1:INDEX(Sheet2!A1:A3,2))', cells)).toBe(VALUE);
        expect(evaluate('=SUM(A1:INDEX({1,2},2))', cells)).toBe(VALUE);
        expect(evaluate('=(A1,B2)+1', cells)).toBe(VALUE);
    });

    // Excel stores 0 for a blank result; the engine follows Google here (batch 21).
    test('a formula result that is blank leaves its cell blank', () => {
        expect(evaluate('=A9', cells)).toBeNull();
        expect(evaluate('=IF(TRUE,A9)', cells)).toBeNull();
        expect(evaluate('=IF(TRUE,,2)', cells)).toBeNull();
        expect(evaluate('=C1=0', { C1: '=A1' })).toBe(true);
        expect(evaluate('=ISBLANK(C1)', { C1: '=A1' })).toBe(true);
    });
});
