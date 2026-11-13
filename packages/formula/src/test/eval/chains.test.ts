import { describe, expect, test } from 'bun:test';
import { NA, NULL, VALUE } from '../../index';
import { evaluate } from '../recalc/support';

// The longest formula a person can type is 8,192 characters, so each chain below is about as long as one can be.
function links(first: string, link: string): number {
    return Math.floor((8000 - first.length) / link.length);
}

function chain(first: string, link: string): string {
    return `=${first}${link.repeat(links(first, link))}`;
}

describe('a chain of operators as long as a formula can be', () => {
    test('of +', () => {
        expect(evaluate(chain('1', '+1'))).toBe(1 + links('1', '+1'));
    });

    test('of &', () => {
        expect(evaluate(chain('"a"', '&"b"'))).toBe(`a${'b'.repeat(links('"a"', '&"b"'))}`);
    });

    test('of mixed operators', () => {
        expect(evaluate(chain('1', '+2*3-4/2^2'))).toBe(1 + 5 * links('1', '+2*3-4/2^2'));
        expect(evaluate(chain('1', '-1&""+1=2'))).toBe(false);
    });

    test('of comparisons', () => {
        expect(evaluate(chain('1', '=1'))).toBe(false);
        expect(evaluate(chain('TRUE', '=TRUE'))).toBe(true);
    });

    test('of unions', () => {
        const formula = `=SUM((${chain('A1', ',A1:A2').slice(1)}))`;
        expect(evaluate(formula, { A1: 1, A2: 2 })).toBe(1 + 3 * links('A1', ',A1:A2'));
    });

    test('in a cell that another cell reads', () => {
        expect(evaluate('=A1+A2', { A1: chain('1', '+1'), A2: chain('2', '*1') })).toBe(3 + links('1', '+1'));
    });
});

describe('what a cell can hold', () => {
    const long = 'a'.repeat(20000);

    test.each([
        ['=LEN(A1&LEFT(A1,12767))', 32767],
        ['=A1&LEFT(A1,12768)', VALUE],
        ['=LEN(CONCATENATE(A1,LEFT(A1,12767)))', 32767],
        ['=CONCATENATE(A1,A1)', VALUE],
        ['=LEFT(A1&A1,5)', VALUE],
        ['=REPLACE(A1,1,0,A1)', VALUE],
        ['=LEN(A1&A1)', VALUE],
        ['=ABS(1E-320)', 0],
        ['=ROUND(1E-320,400)', 0],
        ['=SUM(1E308,1E308)', '#NUM!'],
    ])('%s is %p', (formula, expected) => {
        const value = evaluate(formula, { A1: long });
        expect(typeof value === 'object' && value !== null && typeof expected === 'string' ? value.text : value).toBe(
            expected,
        );
    });

    test('an error literal the engine does not compute is that error', () => {
        expect(evaluate('=#FIELD!')).toMatchObject({ text: '#FIELD!' });
        expect(evaluate('=#GETTING_DATA')).toMatchObject({ text: '#GETTING_DATA' });
        expect(evaluate('=IFERROR(#BLOCKED!,1)')).toBe(1);
        expect(evaluate('="a"&#CONNECT!')).toMatchObject({ text: '#CONNECT!' });
        expect(evaluate('=ISERROR(#FIELD!)')).toBe(true);
        expect(evaluate('=#N/A')).toBe(NA);
    });
});

// Excel's answers, second batch.
describe('intersections', () => {
    const cells = { A1: 5, A2: 6, A3: 7, A10: 1, B10: 2, B11: 9, C12: 3 };

    test.each([
        ['=1:1 A:A', 'N1', 5],
        ['=SUM(A10:B11 B11:C12)', 'N1', 9],
        ['=A1:A2 B1:B2', 'N1', NULL],
        ['=SUM(A1:A2 B1:B2)', 'N1', NULL],
        ['=@A1:A3', 'N2', 6],
        ['=@A1:A3', 'N5', VALUE],
    ])('%s at %s is %p', (formula, host, expected) => {
        expect(evaluate(formula, cells, host)).toBe(expected);
    });

    test('an array constant is the same array each time it is read', () => {
        expect(evaluate('=SUM({1,2;3,4})+SUM({1,2;3,4}*2)+INDEX({1,2;3,4},2,1)+A1', { A1: '=SUM({1,2;3,4})' })).toBe(
            43,
        );
        expect(evaluate('=SUM({1,"a",TRUE,-2,#N/A})')).toBe(NA);
        expect(evaluate('={5}')).toBe(5);
    });
});
