// Content-Disposition filename parsing. The download itself is DOM work with no return value, so the
// header grammar (RFC 6266) is what a test can hold: every download names its file through this.
import { describe, expect, test } from 'bun:test';
import { filenameFromDisposition } from '../../core/download';

describe('filenameFromDisposition', () => {
    test('reads a quoted plain filename, spaces and all', () => {
        expect(filenameFromDisposition('attachment; filename="a b.vcf"', 'fallback.vcf')).toBe('a b.vcf');
    });

    test('reads an unquoted plain filename', () => {
        expect(filenameFromDisposition('attachment; filename=contacts.vcf', 'fallback.vcf')).toBe('contacts.vcf');
    });

    test('decodes the RFC 5987 filename*', () => {
        expect(filenameFromDisposition("attachment; filename*=UTF-8''a%20b.vcf", 'fallback.vcf')).toBe('a b.vcf');
    });

    test('filename* wins over the ASCII-mangled plain filename the server sends beside it', () => {
        const header = `attachment; filename="Rapport_2024.pdf"; filename*=UTF-8''${encodeURIComponent('Rapporté 2024.pdf')}`;

        expect(filenameFromDisposition(header, 'export.pdf')).toBe('Rapporté 2024.pdf');
    });

    test('a missing header falls back', () => {
        expect(filenameFromDisposition(null, 'contacts.vcf')).toBe('contacts.vcf');
    });

    test('a header without a filename parameter falls back', () => {
        expect(filenameFromDisposition('attachment', 'contacts.vcf')).toBe('contacts.vcf');
    });
});
