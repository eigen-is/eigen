import { describe, expect, test } from 'bun:test';
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
