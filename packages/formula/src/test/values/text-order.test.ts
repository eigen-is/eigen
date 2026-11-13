import { describe, expect, test } from 'bun:test';
import { NA } from '../../index';
import { compareText, textKey } from '../../values/text-order';
import { evaluate } from '../recalc/support';

const order = (a: string, b: string) => compareText(textKey(a), textKey(b));
const sorted = (words: string[]) => [...words].sort(order);

describe('textKey', () => {
    test("equal keys where Excel's = says TRUE", () => {
        expect(textKey('a')).toBe(textKey('A'));
        expect(textKey('straße')).toBe(textKey('STRASSE'));
        expect(textKey('é')).toBe(textKey('É'));
        expect(textKey('abc')).toBe('ABC');
        expect(textKey('')).toBe('');
        expect(textKey('1/2/2020')).not.toBe(textKey('01/02/2020'));
    });

    test('an accent or a space makes another key', () => {
        expect(textKey('a')).not.toBe(textKey('á'));
        expect(textKey('a')).not.toBe(textKey('a '));
    });
});

describe('compareText', () => {
    test("the oracle's comparisons", () => {
        expect(order('a', 'B')).toBe(-1);
        expect(order('Z', 'a')).toBe(1);
        expect(order('abc', 'abcd')).toBe(-1);
        expect(order('10', '9')).toBe(-1);
        expect(order('a', 'A')).toBe(0);
        expect(order('a', 'á')).toBe(-1);
        expect(order('straße', 'STRASSE')).toBe(0);
        expect(order('', 'a')).toBe(-1);
        expect(order('a', '')).toBe(1);
        expect(order('', '')).toBe(0);
    });

    test('an accented letter sorts after its base letter and before the next letter', () => {
        expect(sorted(['f', 'é', 'e', 'd', 'É', 'ë'])).toEqual(['d', 'e', 'é', 'É', 'ë', 'f']);
        expect(sorted(['zebra', 'école', 'eclair', 'etude', 'fin', 'élan'])).toEqual([
            'eclair',
            'etude',
            'école',
            'élan',
            'fin',
            'zebra',
        ]);
        expect(sorted(['o', 'ö', 'p', 'ø', 'n', 'ñ', 'œ'])).toEqual(['n', 'ñ', 'o', 'ö', 'ø', 'œ', 'p']);
        expect(sorted(['Zoë', 'Ärger', 'Arm', 'Bär', 'Bar', 'Çe', 'Ce', 'Da'])).toEqual([
            'Arm',
            'Ärger',
            'Bar',
            'Bär',
            'Ce',
            'Çe',
            'Da',
            'Zoë',
        ]);
        expect(sorted(['Ł', 'L', 'M', 'Ž', 'Z', 'Š', 'S', 'T', 'ÿ', 'y'])).toEqual([
            'L',
            'Ł',
            'M',
            'S',
            'Š',
            'T',
            'y',
            'ÿ',
            'Z',
            'Ž',
        ]);
    });

    // Excel: MATCH("k?",{"k1";"k2";"k3";"k4"}) and LOOKUP of the same are #N/A, so "k?" is before "k1".
    test('a mark sorts before the digits, whatever its character code', () => {
        expect(order('k?', 'k1')).toBe(-1);
        expect(order('k1', 'k?')).toBe(1);
        expect(sorted(['a', '~', '0', '_', '?', '9', '/', ' ', '@', 'Z', '[', '!'])).toEqual([
            ' ',
            '!',
            '/',
            '?',
            '@',
            '[',
            '_',
            '~',
            '0',
            '9',
            'a',
            'Z',
        ]);
    });

    test('a hyphen and an apostrophe take no part, and order only texts that are equal without them', () => {
        expect(sorted(['coop', 'co-op', 'cooq', 'con', "co'op", 'co-', 'co'])).toEqual([
            'co',
            'co-',
            'con',
            'coop',
            "co'op",
            'co-op',
            'cooq',
        ]);
        expect(sorted(['-', ' ', "'", '', '!'])).toEqual(['', "'", '-', ' ', '!']);
        expect(order('a-b', 'ab')).toBe(1);
        expect(order('ab-', 'a-b')).toBe(-1);
        expect(order('-a', 'A')).toBe(1);
        expect(order('a-b', 'ac')).toBe(-1);
        expect(order('a-c', 'ab')).toBe(1);
        expect(textKey('co-op')).not.toBe(textKey('coop'));
    });

    test('everything else goes by its character code', () => {
        expect(sorted(['b', 'a', '1', ' ', 'я', '中', 'α'])).toEqual([' ', '1', 'a', 'b', 'α', 'я', '中']);
        expect(order('a', '😀')).toBe(-1);
        expect(order('😀', '😁')).toBe(-1);
    });

    test('total, transitive and stable on a seeded sample', () => {
        let state = 8;
        const random = () => {
            state = (Math.imul(state, 1103515245) + 12345) | 0;
            return (state >>> 8) / 16777216;
        };
        const letters = "aAbBeEéÉèêëfFoOöØœsSßšzZžàÀçÇñÑ 019-'-'_.!中яα😀";
        const words: string[] = [];
        for (let i = 0; i < 300; i++) {
            let word = '';
            const length = Math.floor(random() * 5);
            for (let at = 0; at < length; at++) word += letters.charAt(Math.floor(random() * letters.length));
            words.push(word);
        }
        const keys = words.map(textKey);
        let wrong = 0;
        for (const a of keys) {
            for (const b of keys) {
                const ab = compareText(a, b);
                if (ab !== -compareText(b, a) || (ab === 0) !== (a === b)) wrong++;
                if (ab > 0) continue;
                for (const c of keys) if (compareText(b, c) <= 0 && compareText(a, c) > 0) wrong++;
            }
        }
        expect(wrong).toBe(0);

        const once = [...keys].sort(compareText);
        expect([...once].sort(compareText)).toEqual(once);
        expect([...keys].reverse().sort(compareText)).toEqual(once);
        for (let i = 1; i < once.length; i++)
            expect(compareText(once[i - 1] ?? '', once[i] ?? '')).toBeLessThanOrEqual(0);
    });
});

// Excel batch 13, part 2a: every mark of the keyboard against a digit, a letter and a space, alone and after a
// letter, and in a sorted search; then the eight rows on letters, accents and the two marks that take no part.
describe("Excel's order of text, through the engine", () => {
    const MARKS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    const UNWEIGHED = "'-";

    test.each([...MARKS])('the mark %s', (mark) => {
        const typed = mark === '"' ? '""' : mark;
        const light = UNWEIGHED.includes(mark);
        expect(evaluate(`=("k"&"${typed}")<"k1"`)).toBe(true);
        expect(evaluate(`=("k"&"${typed}")<"ka"`)).toBe(true);
        expect(evaluate(`="${typed}"<"1"`)).toBe(true);
        expect(evaluate(`="${typed}"<"a"`)).toBe(true);
        expect(evaluate(`="${typed}"<" "`)).toBe(light);
        expect(evaluate(`=MATCH("k"&"${typed}",{"k!","k1","ka"},1)`)).toBe(light ? NA : 1);
    });

    test.each([
        ['="a"<"B"', true],
        ['="Z"<"a"', false],
        ['="é"<"f"', true],
        ['="ä"<"z"', true],
        ['="-a"<"a"', false],
        ['="a-b"<"ab"', false],
        ['="co-op"<"coop"', false],
        ['="\'a"<"a"', false],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula)).toBe(expected);
    });
});
