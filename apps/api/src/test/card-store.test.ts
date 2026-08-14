import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import {
    CARDS_DIR,
    cardPath,
    cleanupTempCardFiles,
    computeCardEtag,
    labelColorFor,
    normalizeLabelName,
    sanitizeCardUri,
    uriKeyOf,
    writeCardFile,
} from '../lib/contacts/card-store';
import { LocalFilesystem } from '../lib/core';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-card-store-${Date.now()}`);
let counter = 0;
const nextStore = () => {
    const base = join(TEST_DIR, `store-${counter++}`);
    return { store: new LocalFilesystem(base), base };
};

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('writeAtomic', () => {
    test('writes the exact bytes and leaves no temp file behind', async () => {
        const { store, base } = nextStore();
        const bytes = new TextEncoder().encode('BEGIN:VCARD\r\nEND:VCARD\r\n');
        await store.writeAtomic('cards/a.vcf', bytes);

        expect(new Uint8Array(await store.file('cards/a.vcf').arrayBuffer())).toEqual(bytes);
        expect(readdirSync(join(base, 'cards'))).toEqual(['a.vcf']);
    });

    test('overwrites an existing target atomically', async () => {
        const { store, base } = nextStore();
        await store.writeAtomic('cards/b.vcf', 'first');
        await store.writeAtomic('cards/b.vcf', 'second');

        expect(await store.file('cards/b.vcf').text()).toBe('second');
        expect(readdirSync(join(base, 'cards'))).toEqual(['b.vcf']);
    });
});

describe('sanitizeCardUri', () => {
    test('accepts well-formed .vcf resource names', () => {
        expect(sanitizeCardUri('ABC-123.vcf')).toBe('ABC-123.vcf');
        expect(sanitizeCardUri('a.b@c.vcf')).toBe('a.b@c.vcf');
    });

    test('rejects traversal, hidden, slash, trailing-space and control chars', () => {
        expect(sanitizeCardUri('../x.vcf')).toBeNull();
        expect(sanitizeCardUri('.hidden.vcf')).toBeNull();
        expect(sanitizeCardUri('a/b.vcf')).toBeNull();
        expect(sanitizeCardUri('x.vcf ')).toBeNull();
        expect(sanitizeCardUri('a\nb.vcf')).toBeNull();
        expect(sanitizeCardUri('x .vcf')).toBeNull();
    });

    test('requires the literal lowercase .vcf suffix', () => {
        expect(sanitizeCardUri('x.VCF')).toBeNull();
        expect(sanitizeCardUri('x.txt')).toBeNull();
    });

    test('rejects empty and over-long names', () => {
        expect(sanitizeCardUri('')).toBeNull();
        expect(sanitizeCardUri(`${'a'.repeat(256)}.vcf`)).toBeNull();
    });
});

describe('uriKeyOf', () => {
    test('lowercases the uri', () => {
        expect(uriKeyOf('AbC.vcf')).toBe('abc.vcf');
    });

    test('NFC-normalizes before lowercasing', () => {
        // Decomposed A + combining ring above and composed Å collapse to one key.
        expect(uriKeyOf('Å.vcf')).toBe(uriKeyOf('Å.vcf'));
    });
});

describe('computeCardEtag', () => {
    test('is the sha256 hex of the bytes', () => {
        expect(computeCardEtag(new TextEncoder().encode('x'))).toBe(
            '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
        );
    });
});

describe('normalizeLabelName', () => {
    test('trims, lowercases and NFC-normalizes', () => {
        expect(normalizeLabelName('  Work  ')).toBe('work');
        // Decomposed "café" (e + combining acute) and composed é normalize to the same key.
        expect(normalizeLabelName('Café')).toBe(normalizeLabelName('Café'));
        expect(normalizeLabelName('Café')).toBe('café');
    });
});

describe('labelColorFor', () => {
    test('is deterministic and lands in the accent palette', () => {
        const color = labelColorFor(normalizeLabelName('Work'));
        expect(color).toBe(labelColorFor(normalizeLabelName('Work')));
        expect(EIGEN_ACCENT_COLORS.some((c) => c.value === color)).toBe(true);
    });
});

describe('card file helpers', () => {
    test('cardPath joins under the cards directory', () => {
        expect(cardPath('a.vcf')).toBe(`${CARDS_DIR}/a.vcf`);
    });

    test('writeCardFile persists the bytes and reports size', async () => {
        const { store } = nextStore();
        const bytes = new TextEncoder().encode('BEGIN:VCARD\r\nUID:1\r\nEND:VCARD\r\n');
        const { mtime, size } = await writeCardFile(store, 'card.vcf', bytes);

        expect(size).toBe(bytes.byteLength);
        expect(mtime).toBeGreaterThan(0);
        expect(new Uint8Array(await store.file('cards/card.vcf').arrayBuffer())).toEqual(bytes);
    });

    test('cleanupTempCardFiles removes temp/non-vcf leftovers but keeps real cards', async () => {
        const { store, base } = nextStore();
        await store.mkdir('cards');
        const cardsDir = join(base, 'cards');
        writeFileSync(join(cardsDir, 'real.vcf'), 'x');
        writeFileSync(join(cardsDir, '.real.vcf.tmp-abc'), 'x');
        writeFileSync(join(cardsDir, 'stray.txt'), 'x');

        await cleanupTempCardFiles(store);

        expect(readdirSync(cardsDir)).toEqual(['real.vcf']);
    });
});
