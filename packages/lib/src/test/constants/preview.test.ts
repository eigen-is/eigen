import { describe, expect, test } from 'bun:test';
import { getTextPreviewMode, isSearchableTextFile } from '../../constants/preview';

describe('isSearchableTextFile', () => {
    test('plaintext + markdown + code are searchable', () => {
        expect(isSearchableTextFile('text/plain', 'notes.txt')).toBe(true);
        expect(isSearchableTextFile('text/markdown', 'README.md')).toBe(true);
        expect(isSearchableTextFile('application/json', 'data.json')).toBe(true);
    });
    test('eigen container mimes are NOT plaintext-searchable (handled via onSync)', () => {
        expect(isSearchableTextFile('application/eigendoc', 'doc.eigendoc')).toBe(false);
        expect(isSearchableTextFile('application/eigensheets', 's.eigensheets')).toBe(false);
        expect(isSearchableTextFile('application/eigenvector', 'plan.eigenvector')).toBe(false);
    });
    test('binary is not searchable', () => {
        expect(isSearchableTextFile('image/png', 'photo.png')).toBe(false);
    });
    test('a vCard is not searchable — it has no text preview to index', () => {
        expect(isSearchableTextFile('text/vcard', 'team.vcf')).toBe(false);
        expect(isSearchableTextFile('text/x-vcard', 'team.vcf')).toBe(false);
        expect(isSearchableTextFile('application/octet-stream', 'team.vcf')).toBe(false);
    });
});

describe('getTextPreviewMode', () => {
    test('a vector drawing is a text preview — its body is the compositor page', () => {
        expect(getTextPreviewMode('application/eigenvector', 'plan.eigenvector')).toBe('eigenvector');
    });
    test('a vCard has no text preview — the drive hero would render its base64 photo wall', () => {
        expect(getTextPreviewMode('text/vcard', 'team.vcf')).toBeNull();
        expect(getTextPreviewMode('text/x-vcard', 'team.vcf')).toBeNull();
        expect(getTextPreviewMode('application/octet-stream', 'team.vcf')).toBeNull();
    });
});
