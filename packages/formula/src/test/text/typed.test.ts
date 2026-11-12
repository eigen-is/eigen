import { describe, expect, test } from 'bun:test';
import { parseA1, parseStored, storedText, typedText } from '../../text';
import { ShapeTable } from '../../text/shapes';
import { at, findSheet, sheetName } from './support';

function crossed(typed: string, host = 'B2'): { stored: string; shown: string; parsed: boolean } {
    const stored = storedText(typed, ...at(host), findSheet);
    const table = new ShapeTable();
    const shape = table.shape(table.intern(stored));
    return { stored, shown: typedText(shape, ...at(host), sheetName), parsed: shape.tree !== null };
}

describe('typed text and stored text', () => {
    test.each([
        ['=A1+1', '=R[-1]C[-1]+1', '=A1+1'],
        ['=sum( Sheet2!$A:$A )', '=SUM( [s2]!C1:C1 )', '=SUM( Sheet2!$A:$A )'],
        ['=RC', '=rc', '=rc'],
    ])('a formula that parses is stored as its shape: %s', (typed, stored, shown) => {
        expect(crossed(typed)).toEqual({ stored, shown, parsed: true });
    });

    test.each([
        '=R[1]C[1]',
        '=R[1]C',
        '=R[-1]C[2]:RC',
        '=SUM(1,',
        '=1+',
        '=',
        '= ',
        '==1',
        '===',
        '=#FOO!',
        '=A1:Sheet2!B2',
    ])('text that does not parse is stored behind a second =, and shows as typed: %p', (typed) => {
        expect('reason' in parseA1(typed, ...at('B2'), findSheet)).toBe(true);
        expect(crossed(typed)).toEqual({ stored: `=${typed}`, shown: typed, parsed: false });
    });

    test('marked text is refused by both grammars, whatever follows the mark', () => {
        for (const text of ['==1', '==RC', '==R[1]C[1]', '==', '== 1', '==SUM(RC)']) {
            expect(parseStored(text)).toEqual({ reason: 'syntax', at: 1 });
            expect(parseA1(text, 0, 0, findSheet)).toEqual({ reason: 'syntax', at: 1 });
        }
    });

    test('stored text that fails without a mark shows as it is', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.intern('=SUM(1,'));
        expect(typedText(shape, 0, 0, sheetName)).toBe('=SUM(1,');
    });
});
