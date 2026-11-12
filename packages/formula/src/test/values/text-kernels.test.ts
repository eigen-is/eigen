import { describe, expect, test } from 'bun:test';
import { ansiCharacter, ansiCode } from '../../values/ansi';
import {
    countCharacters,
    cutCharacters,
    findCharacters,
    findLastCharacters,
    firstCode,
    searchCharacters,
} from '../../values/characters';
import { partBeside } from '../../values/delimited';
import { lowerCase, properCase, upperCase } from '../../values/letter-case';
import { separatedNumber } from '../../values/separated-number';
import { patternStart } from '../../values/wildcard';

const EMOJI = String.fromCodePoint(128512);

describe('characters', () => {
    test('a character is one UTF-16 code unit, so an emoji is two', () => {
        expect(countCharacters(`${EMOJI}a`)).toBe(3);
        expect(cutCharacters(`${EMOJI}ab`, 2, 1)).toBe('a');
        expect(cutCharacters('abc', 1, 99)).toBe('bc');
        expect(cutCharacters('abc', 5, 1)).toBe('');
        expect(findCharacters('a', `${EMOJI}a`, 1)).toBe(3);
        expect(searchCharacters('A', `${EMOJI}a`, 1)).toBe(3);
    });

    test('a find starts at a position from 1 and answers 0 for nothing', () => {
        expect(findCharacters('o', 'Hello World', 6)).toBe(8);
        expect(findCharacters('O', 'Hello World', 1)).toBe(0);
        expect(findCharacters('', 'abc', 4)).toBe(4);
    });

    test('a find from the end answers the last place at or before a position', () => {
        expect(findLastCharacters('o', 'Hello World', 11)).toBe(8);
        expect(findLastCharacters('o', 'Hello World', 7)).toBe(5);
        expect(findLastCharacters('o', 'Hello World', 4)).toBe(0);
        expect(findLastCharacters('H', 'Hello World', 1)).toBe(1);
    });

    test('the first code is a whole code point, though a pair counts as two characters', () => {
        expect(firstCode(`${EMOJI}a`)).toBe(128512);
        expect(firstCode('€')).toBe(8364);
        expect(firstCode('')).toBeUndefined();
    });

    test('a search folds case without changing a length', () => {
        expect(searchCharacters('É', 'àéî', 1)).toBe(2);
        expect(searchCharacters('ss', 'straße', 1)).toBe(0);
        expect(searchCharacters('e', 'straße', 1)).toBe(6);
    });
});

describe('patternStart', () => {
    test.each([
        ['B', 'ABCABC', 0, 1],
        ['B', 'ABCABC', 2, 4],
        ['?C', 'ABCABC', 0, 1],
        ['?C', 'ABCABC', 2, 4],
        ['*', 'ABC', 2, 2],
        ['*C', 'ABC', 0, 0],
        ['B*', 'ABC', 0, 1],
        ['A*C*C', 'ABCABC', 0, 0],
        ['A*C*C', 'ABCABC', 1, -1],
        ['B*A*D', 'ABCABC', 0, -1],
        ['A??C', 'ABCABC', 0, -1],
        ['C?', 'ABCABC', 0, 2],
        ['C?', 'ABC', 0, -1],
        ['~*', 'A*C', 0, 1],
        ['~~', 'A~C', 0, 1],
        ['~', 'A~C', 0, 0],
        ['A~', 'BA~', 0, 1],
        ['~~~', 'A~C', 0, 1],
        ['~C', 'A~C', 0, 2],
        ['', 'ABC', 3, 3],
        ['?', 'ABC', 3, -1],
    ])('%p in %p from %i starts at %i', (sought, key, from, expected) => {
        expect(patternStart(sought, key, from)).toBe(expected);
    });
});

describe('letter case', () => {
    test('a text keeps its length', () => {
        expect(upperCase('straße ŉ')).toBe('STRAßE ŉ');
        expect(lowerCase('İSTANBUL')).toBe('istanbul');
        expect(lowerCase('ΟΔΥΣΣΕΥΣ')).toBe('οδυσσευς');
    });

    test('no letter of Unicode changes the length of a text in lower case', () => {
        for (let point = 0; point <= 0x10ffff; point += 1) {
            if (point >= 0xd800 && point <= 0xdfff) continue;
            const letter = String.fromCodePoint(point);
            if (lowerCase(letter).length !== letter.length) throw new Error(`U+${point.toString(16)}`);
        }
    });

    test('a final sigma does not depend on another letter of the text', () => {
        expect(lowerCase('ΑΣ')).toBe('ας');
        expect(lowerCase('ΑΣ İ')).toBe('ας i');
        expect(lowerCase('ΣΑ İ')).toBe('σα i');
    });

    test('an accent written apart does not end a word', () => {
        expect(properCase(`e${String.fromCharCode(769)}lise d${String.fromCharCode(769)}`)).toBe(
            `E${String.fromCharCode(769)}lise D${String.fromCharCode(769)}`,
        );
    });

    test('proper case starts a word after anything that is no letter', () => {
        expect(properCase("o'NEIL mc-donald 3rd x2y")).toBe("O'Neil Mc-Donald 3Rd X2Y");
        expect(properCase('ǆ ß İ ı ﬁ')).toBe('Ǆ ß I I ﬁ');
        expect(properCase(`${EMOJI}a`)).toBe(`${EMOJI}A`);
        expect(properCase('')).toBe('');
    });
});

describe('the code page', () => {
    test('a code and its character go both ways', () => {
        for (let code = 1; code < 256; code += 1) expect(ansiCode(ansiCharacter(code).charCodeAt(0))).toBe(code);
    });

    test('128 to 159 are characters from elsewhere, and what the page lacks is a question mark', () => {
        expect(ansiCharacter(128)).toBe('€');
        expect(ansiCharacter(150)).toBe('–');
        expect(ansiCharacter(129).charCodeAt(0)).toBe(129);
        expect(ansiCode('Ā'.charCodeAt(0))).toBe(63);
        expect(ansiCode(0xd83d)).toBe(63);
    });
});

describe('separatedNumber', () => {
    test.each([
        ['1.234,5', ',', '.', 1234.5],
        ['1,234.5', '.', ',', 1234.5],
        ['1,5', ',', '', 1.5],
        ['1,2,3', ',', '', undefined],
        ['1.5', 'x', ',', 1.5],
        ['1.5', '1', ',', undefined],
        ['1.5', '.', '1', 0.5],
        [' 1 2\t3\n', '.', ',', 123],
        ['', '.', ',', 0],
        ['12%%', '.', ',', 0.0012],
        ['%', '.', ',', 0],
        ['1.000,5', '.', ',', undefined],
        ['1,000.5,0', '.', ',', undefined],
        ['3\u00a0000', '.', ',', undefined],
        ['(5)', '.', ',', -5],
        ['(-5)', '.', ',', undefined],
        ['($5)', '.', ',', -5],
        ['(5)%', '.', ',', -0.05],
        ['(5', '.', ',', undefined],
        ['$5', '.', ',', 5],
        ['-$5', '.', ',', -5],
        ['5$', '.', ',', undefined],
        ['5-', '.', ',', undefined],
        ['--5', '.', ',', undefined],
        ['.5', '.', ',', 0.5],
        ['5.', '.', ',', 5],
        ['.', '.', ',', undefined],
        ['1e3', '.', ',', 1000],
        ['1E-2', '.', ',', 0.01],
        ['1E+', '.', ',', undefined],
        ['1e400', '.', ',', undefined],
        ['0x1F', '.', ',', undefined],
        ['12:30', '.', ',', undefined],
    ])('%p with %p and %p is %p', (text, decimal, group, expected) => {
        expect(separatedNumber(text, decimal, group)).toBe(expected);
    });
});

describe('partBeside', () => {
    const before = (text: string, delimiters: string[], instance: number, toEnd = false) =>
        partBeside(text, text, delimiters, instance, toEnd, false);
    const after = (text: string, delimiters: string[], instance: number, toEnd = false) =>
        partBeside(text, text, delimiters, instance, toEnd, true);

    test('delimiters are counted from the start, or from the end, and never overlap', () => {
        expect(before('a-b-c', ['-'], 2)).toBe('a-b');
        expect(after('a-b-c', ['-'], 2)).toBe('c');
        expect(before('a-b-c', ['-'], -2)).toBe('a');
        expect(after('a-b-c', ['-'], -2)).toBe('b-c');
        expect(before('a-b-c', ['-'], 3)).toBeUndefined();
        expect(before('a---b', ['--'], 1)).toBe('a');
        expect(after('a---b', ['--'], 1)).toBe('-b');
        expect(before('a---b', ['--'], -1)).toBe('a-');
        expect(before('a---b', ['--'], 2)).toBeUndefined();
        expect(before('-a', ['--'], -1)).toBeUndefined();
    });

    test('of several delimiters the nearest counts', () => {
        expect(before('Hello World', ['x', 'o', ' '], 1)).toBe('Hell');
        expect(after('Hello World', [' ', 'o'], -1)).toBe('rld');
        expect(before('a-b', ['-b', '-'], 1)).toBe('a');
        expect(after('abc', ['b', 'bc'], -1)).toBe('');
    });

    test('the end the search runs toward is one more delimiter when asked', () => {
        expect(before('a-b-c', ['-'], 3, true)).toBe('a-b-c');
        expect(after('a-b-c', ['-'], 3, true)).toBe('');
        expect(before('a-b-c', ['-'], -3, true)).toBe('');
        expect(after('a-b-c', ['-'], -3, true)).toBe('a-b-c');
        expect(before('a-b-c', ['-'], 4, true)).toBeUndefined();
    });

    test('an empty delimiter stands at the end the search starts from', () => {
        expect(before('abc', [''], 1)).toBe('');
        expect(after('abc', [''], 1)).toBe('abc');
        expect(before('abc', [''], -1)).toBe('abc');
        expect(after('abc', [''], -1)).toBe('');
    });

    test('the search runs on the key and the cut is made in the text', () => {
        expect(partBeside('aXbxc', 'AXBXC', ['X'], 1, false, false)).toBe('a');
        expect(partBeside('aXbxc', 'AXBXC', ['X'], -1, false, true)).toBe('c');
    });
});
