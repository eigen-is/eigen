import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    computeResourceEtag,
    newSyncGen,
    normalizeResourceUri,
    readBlobTableSize,
    sanitizeResourceUri,
} from '../../lib/core/blob-store';

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

    test('accepts an accented name and hands back the one composed spelling', () => {
        expect(sanitizeResourceUri('café.vcf', SUFFIX)).toBe('café.vcf');
        expect(sanitizeResourceUri('café.vcf'.normalize('NFD'), SUFFIX)).toBe('café.vcf');
        expect(sanitizeResourceUri('会議.vcf', SUFFIX)).toBe('会議.vcf');
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
        // The cap is 200 bytes (spec § 4) so writeAtomic's `.`-prefixed temp name stays under NAME_MAX. The
        // bound lives in the length check alone (the regex owns only the charset): 200 bytes pass, 201 fail.
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

describe('newSyncGen', () => {
    test('is the wall clock in seconds, so a recreated database cannot reissue a low generation', () => {
        const before = Math.floor(Date.now() / 1000);
        const gen = newSyncGen();
        expect(gen).toBeGreaterThanOrEqual(before);
        expect(gen).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });
});

describe('readBlobTableSize', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-blob-size-${Date.now()}`);
    let counter = 0;

    // A database stamped `version`, or none at all when it is null, holding one two-byte blob.
    function makeDb(version: number | null): string {
        const dbPath = join(TEST_DIR, `blobs-${counter++}.db`);
        const db = new Database(dbPath, { create: true });
        if (version !== null) {
            db.run('CREATE TABLE __schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
            db.run('INSERT INTO __schema_version (id, version) VALUES (1, ?)', [version]);
        }
        db.run('CREATE TABLE resources (ics BLOB NOT NULL)');
        db.run("INSERT INTO resources (ics) VALUES (x'0102')");
        db.close();
        return dbPath;
    }

    beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    test('sums the blob column of a database this build recognises', () => {
        expect(readBlobTableSize(makeDb(5), 'resources', 'ics', 5)).toBe(2);
    });

    test('is 0 for a database nobody wrote', () => {
        expect(readBlobTableSize(join(TEST_DIR, 'absent.db'), 'resources', 'ics', 5)).toBe(0);
    });

    test('is 0 at any stamp but the current one: the column may mean other bytes, or none yet', () => {
        expect(readBlobTableSize(makeDb(4), 'resources', 'ics', 5)).toBe(0);
        expect(readBlobTableSize(makeDb(6), 'resources', 'ics', 5)).toBe(0);
    });

    test('is 0 when the stamp table is missing, rather than throwing on the read', () => {
        expect(readBlobTableSize(makeDb(null), 'resources', 'ics', 5)).toBe(0);
    });
});
