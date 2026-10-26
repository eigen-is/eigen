import { describe, expect, test } from 'bun:test';
import { NO_CONTROL_PATTERN } from '@workspace/lib/validation';
import { getUniqueFileName } from '../../lib/drive/naming';
import { foldName, isReservedName, isUsableName, validateName } from '../../lib/mount/names';

// A name validateName accepts is one the backup's path check (NO_CONTROL_PATTERN) accepts too, or
// the drive holds a file no backup of its home can archive.
describe('names refuse what the backup refuses', () => {
    const noControl = new RegExp(NO_CONTROL_PATTERN);

    test.each(['a\x00b', 'a\x01b', 'a\x1fb', 'a\x7fb'])('refuses %j', (name) => {
        expect(noControl.test(name)).toBe(false);
        expect(isUsableName(name)).toBe(false);
        expect(() => validateName(name)).toThrow('Invalid file or folder name');
    });

    test('accepts a name with no control character', () => {
        expect(validateName('Report ~ 2026.pdf')).toBe('Report ~ 2026.pdf');
    });
});

// The pairs are one file on APFS, and the names below them are two.
describe('foldName folds the way APFS does', () => {
    test.each([
        ['Straße', 'STRASSE'],
        ['ſ', 'S'],
        ['ς', 'Σ'],
        ['ﬀ', 'FF'],
        ['ϑ', 'Θ'],
        ['µ', 'μ'],
        ['ǰ', 'J̌'.normalize('NFC')],
        ['ΐ', 'Ϊ́'.normalize('NFC')],
        ['ΰ', 'Ϋ́'.normalize('NFC')],
    ])('%s is %s', (a, b) => {
        expect(foldName(a)).toBe(foldName(b));
    });

    test.each([
        ['ı', 'i'],
        ['ı', 'I'],
        ['İ', 'i'],
    ])('%s is not %s', (a, b) => {
        expect(foldName(a)).not.toBe(foldName(b));
    });
});

// The reserved name and the unique names use the disk's fold, so the mount never refuses a name they
// picked or let through.
describe('the reserved name and the unique names fold the way the disk does', () => {
    test.each(['.trash', '.TRASH', '.traſh'])('%j is reserved', (name) => {
        expect(isReservedName(name)).toBe(true);
    });

    test('a fullwidth .trash is a name of its own, the same as on APFS', () => {
        expect(isReservedName('．ｔｒａｓｈ')).toBe(false);
    });

    test('a suffix whose fold is taken is skipped', () => {
        const used = new Set(['Straße.txt', 'STRASSE (2).txt'].map(foldName));
        expect(getUniqueFileName('Straße.txt', used)).toBe('Straße (3).txt');
    });
});
