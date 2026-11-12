import { describe, expect, test } from 'bun:test';
import {
    MAX_STORED_LENGTH,
    parseA1,
    parseStored,
    parseXlsx,
    printStored,
    sheetFinder,
    storedKey,
    storedText,
    typedText,
} from '../../text';
import { ShapeTable } from '../../text/shapes';
import { at, dice, findSheet, sheetName } from './support';

// A sheet whose id is as long as the ids a workbook gives, so a!A1 is twelve times as long stored as typed.
const wide = sheetFinder([
    { id: '0b9f6c1e-6a4d-4c1b-9a53-3f1f0c9d2e77', name: 'a' },
    { id: 'k3', name: 'b' },
]);
const LAST = [1048575, 16383] as const;

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

    test('a formula whose stored text would pass the bound is kept as typed, at the host where it would', () => {
        const typed = `=${'a!A1+'.repeat(2200)}1`;
        expect(typed).toHaveLength(11002);
        const near = storedText(typed, 0, 0, wide);
        expect(near).toHaveLength(2200 * 42 + 2);
        expect(printStored(readBack(near))).toBe(near);
        const far = storedText(typed, ...LAST, wide);
        expect(far).toBe(`=${typed}`);
        const table = new ShapeTable();
        expect(typedText(table.shape(table.intern(far)), ...LAST, sheetName)).toBe(typed);
    });

    test('a formula of a file whose stored text would pass the bound is refused as too long', () => {
        const text = `${'a!A1+'.repeat(2200)}1`;
        const tree = parseXlsx(text, ...LAST, wide);
        if ('reason' in tree) throw new Error(tree.reason);
        expect(storedKey(tree)).toEqual({ reason: 'too-long', at: 0 });
        const near = parseXlsx(text, 0, 0, wide);
        if ('reason' in near) throw new Error(near.reason);
        expect(storedKey(near)).toBe(storedText(`=${text}`, 0, 0, wide));
    });

    test('the longest stored text is stored, and one character more is not', () => {
        const terms = (MAX_STORED_LENGTH - 2) / 2;
        const longest = `=${'1+'.repeat(terms)}1`;
        expect(storedText(longest, 0, 0, wide)).toBe(longest);
        // 1.0 is stored as 1, and A1 at B2 as R[-1]C[-1]: the bound is on what is stored, either way.
        const zeros = `=${'1+'.repeat(terms)}1.0`;
        expect(storedText(zeros, 0, 0, wide)).toBe(`==${'1+'.repeat(terms)}1.0`);
        const longer = `=${'1+'.repeat(terms - 1)}A1`;
        expect(longer).toHaveLength(MAX_STORED_LENGTH - 1);
        expect(storedText(longer, 0, 0, wide)).toBe(`=${'1+'.repeat(terms - 1)}RC`);
        expect(storedText(longer, 1, 1, wide)).toBe(`=${longer}`);
    });

    test('law: near the bound a typed formula is kept as typed, or its stored text reads back as itself', () => {
        const { random, pick } = dice(20261113);
        const terms = ['a!A1', 'a!$B$2:C3', 'b!XFD1048576', 'A1', '$C$7', ' 1.50', '"x"', 'SUM(a!A:A, 2)', 'a!Rate'];
        let kept = 0;
        let stored = 0;
        for (let run = 0; run < 60; run += 1) {
            const [row, column] = pick([[0, 0], LAST, [500000, 8000]] as const);
            const target = MAX_STORED_LENGTH + Math.floor(random() * 400) - 200;
            const few = pick([terms, terms.slice(0, 1), terms.slice(0, 3), terms.slice(3)]);
            let typed = '=1';
            for (let length = 2; length < target; ) {
                const term = pick(few);
                typed += `+${term}`;
                length += storedText(`=${term}`, row, column, wide).length;
            }
            const key = storedText(typed, row, column, wide);
            if (key === `=${typed}`) {
                kept += 1;
                continue;
            }
            stored += 1;
            expect(key.length).toBeLessThanOrEqual(MAX_STORED_LENGTH);
            expect(printStored(readBack(key))).toBe(key);
        }
        expect(kept).toBeGreaterThan(10);
        expect(stored).toBeGreaterThan(10);
    });
});

function readBack(stored: string) {
    const tree = parseStored(stored);
    if ('reason' in tree) throw new Error(`${stored.length} characters do not read back: ${tree.reason}`);
    return tree;
}
