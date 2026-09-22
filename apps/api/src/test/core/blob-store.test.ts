import { describe, expect, test } from 'bun:test';
import { computeResourceEtag, nextSyncGen, normalizeResourceUri, sanitizeResourceUri } from '../../lib/core/blob-store';

const SUFFIX = '.vcf';

describe('normalizeResourceUri', () => {
    test('NFC-normalizes so a macOS NFD href matches the stored name', () => {
        // Decomposed A + combining ring above, spelled in escapes so no editor can recompose it.
        expect(normalizeResourceUri('Å.vcf')).toBe('Å.vcf');
    });

    test('leaves case alone — two spellings are two resources', () => {
        expect(normalizeResourceUri('AbC.vcf')).toBe('AbC.vcf');
    });
});

describe('sanitizeResourceUri', () => {
    test('accepts well-formed .vcf resource names', () => {
        expect(sanitizeResourceUri('ABC-123.vcf', SUFFIX)).toBe('ABC-123.vcf');
        expect(sanitizeResourceUri('a.b@c.vcf', SUFFIX)).toBe('a.b@c.vcf');
    });

    test('rejects traversal, hidden, slash, trailing-space and control chars', () => {
        expect(sanitizeResourceUri('../x.vcf', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('.hidden.vcf', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('a/b.vcf', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('x.vcf ', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('a\nb.vcf', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('x .vcf', SUFFIX)).toBeNull();
    });

    test('requires the literal lowercase suffix', () => {
        expect(sanitizeResourceUri('x.VCF', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri('x.txt', SUFFIX)).toBeNull();
    });

    test('rejects empty and over-long names', () => {
        expect(sanitizeResourceUri('', SUFFIX)).toBeNull();
        expect(sanitizeResourceUri(`${'a'.repeat(256)}.vcf`, SUFFIX)).toBeNull();
        // The cap is 200 (spec § 4) so writeAtomic's `.`-prefixed temp name stays under NAME_MAX. The bound
        // lives in the length check alone (the regex owns only the charset): 200 chars pass, 201 fail.
        expect(sanitizeResourceUri(`${'a'.repeat(210)}.vcf`, SUFFIX)).toBeNull();
        expect(sanitizeResourceUri(`${'a'.repeat(196)}.vcf`, SUFFIX)).toBe(`${'a'.repeat(196)}.vcf`);
        expect(sanitizeResourceUri(`${'a'.repeat(197)}.vcf`, SUFFIX)).toBeNull();
    });
});

describe('computeResourceEtag', () => {
    test('is the sha256 hex of the bytes', () => {
        expect(computeResourceEtag(new TextEncoder().encode('x'))).toBe(
            '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
        );
    });
});

describe('nextSyncGen', () => {
    test('a rebuild that lost the stored generation starts from the wall clock, not from 1', () => {
        expect(nextSyncGen(undefined, 1_700_000_000_000)).toBe(1_700_000_000);
    });

    test('a stored generation ahead of the clock still advances by one', () => {
        expect(nextSyncGen(1_700_000_005, 1_700_000_000_000)).toBe(1_700_000_006);
    });

    test('a generation the clock has overtaken jumps to the clock', () => {
        expect(nextSyncGen(2, 1_700_000_000_000)).toBe(1_700_000_000);
    });

    test('two rebuilds inside one second never repeat while the stored generation survives', () => {
        const first = nextSyncGen(undefined, 1_700_000_000_000);
        expect(nextSyncGen(first, 1_700_000_000_500)).toBe(first + 1);
    });

    test('the one repeat left takes two lost generations inside the same second', () => {
        expect(nextSyncGen(undefined, 1_700_000_000_999)).toBe(nextSyncGen(undefined, 1_700_000_000_000));
        expect(nextSyncGen(undefined, 1_700_000_001_000)).toBe(nextSyncGen(undefined, 1_700_000_000_000) + 1);
    });
});
