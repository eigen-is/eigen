import { describe, expect, test } from 'bun:test';
import { isSearchableTextFile } from '../../constants/preview';

describe('isSearchableTextFile', () => {
    test('plaintext + markdown + code are searchable', () => {
        expect(isSearchableTextFile('text/plain', 'notes.txt')).toBe(true);
        expect(isSearchableTextFile('text/markdown', 'README.md')).toBe(true);
        expect(isSearchableTextFile('application/json', 'data.json')).toBe(true);
    });
    test('eigen container mimes are NOT plaintext-searchable (handled via onSync)', () => {
        expect(isSearchableTextFile('application/eigendoc', 'doc.eigendoc')).toBe(false);
        expect(isSearchableTextFile('application/eigensheets', 's.eigensheets')).toBe(false);
    });
    test('binary is not searchable', () => {
        expect(isSearchableTextFile('image/png', 'photo.png')).toBe(false);
    });
});
