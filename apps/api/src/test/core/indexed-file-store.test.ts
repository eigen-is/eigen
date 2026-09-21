import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFilesystem } from '../../lib/core';
import {
    cleanupTempFiles,
    computeResourceEtag,
    dedupeByUid,
    diffFileStats,
    listResourceUris,
    sanitizeResourceUri,
    uriKeyOf,
    WriteGate,
    writeResourceFile,
} from '../../lib/core/indexed-file-store';

// One resource directory per case, so a sweep or a listing never sees another test's files.
const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-indexed-file-store-${Date.now()}`);
const DIR = 'cards';
const SUFFIX = '.vcf';
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

// Warnings are the skip channel here, so a test that provokes one swallows it and keeps the run quiet.
const captureWarnings = async (fn: () => Promise<void>): Promise<string[]> => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
        await fn();
    } finally {
        console.warn = origWarn;
    }
    return warnings;
};

// Turns a self-deadlock (a promise that never settles) into a failing assertion instead of a hung run.
const completesWithin = async <T>(p: Promise<T>, ms: number, msg: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        clearTimeout(timer);
    }
};

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

describe('uriKeyOf', () => {
    test('lowercases the uri', () => {
        expect(uriKeyOf('AbC.vcf')).toBe('abc.vcf');
    });

    test('NFC-normalizes before lowercasing', () => {
        // Decomposed A + combining ring above and composed Å collapse to one key.
        expect(uriKeyOf('Å.vcf')).toBe(uriKeyOf('Å.vcf'));
    });
});

describe('computeResourceEtag', () => {
    test('is the sha256 hex of the bytes', () => {
        expect(computeResourceEtag(new TextEncoder().encode('x'))).toBe(
            '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
        );
    });
});

describe('resource file helpers', () => {
    test('writeResourceFile persists the bytes and reports size', async () => {
        const { store } = nextStore();
        const bytes = new TextEncoder().encode('BEGIN:VCARD\r\nUID:1\r\nEND:VCARD\r\n');
        const { mtime, size } = await writeResourceFile(store, `${DIR}/card.vcf`, bytes);

        expect(size).toBe(bytes.byteLength);
        expect(mtime).toBeGreaterThan(0);
        expect(Number.isInteger(mtime)).toBe(true);
        expect(new Uint8Array(await store.file(`${DIR}/card.vcf`).arrayBuffer())).toEqual(bytes);
    });

    test('cleanupTempFiles removes only the dot-prefixed .tmp- leftovers', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        const cardsDir = join(base, DIR);
        writeFileSync(join(cardsDir, 'real.vcf'), 'x');
        writeFileSync(join(cardsDir, '.real.vcf.tmp-abc'), 'x');
        // A stray non-`.vcf` (README, csv, a mixed-case .VCF) is NOT temp debris — it survives the sweep and is
        // warn-skipped by reconcile/rebuild instead of being silently deleted. A hand-placed dotfile without
        // the `.tmp-` infix (a `.backup.vcf`) is not writeAtomic debris either and must survive.
        writeFileSync(join(cardsDir, 'stray.txt'), 'x');
        writeFileSync(join(cardsDir, 'x.VCF'), 'x');
        writeFileSync(join(cardsDir, '.backup.vcf'), 'x');

        await cleanupTempFiles(store, DIR);

        expect(readdirSync(cardsDir).sort()).toEqual(['.backup.vcf', 'real.vcf', 'stray.txt', 'x.VCF']);
    });

    test('a resource directory holding nothing but temp debris survives the sweep', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        writeFileSync(join(base, DIR, `.x.vcf.tmp-${randomUUID()}`), 'x');

        await cleanupTempFiles(store, DIR);

        // Emptying the directory must not take it with it: the very same init enumerates it next.
        expect(existsSync(join(base, DIR))).toBe(true);
        expect(await listResourceUris(store, DIR, SUFFIX)).toEqual([]);
    });

    test('listResourceUris sorts, keys and warn-skips a non-conforming name', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        for (const name of ['b.vcf', 'A.vcf', 'stray.txt']) {
            writeFileSync(join(base, DIR, name), 'x');
        }

        let entries: { uri: string; key: string }[] = [];
        const warnings = await captureWarnings(async () => {
            entries = await listResourceUris(store, DIR, SUFFIX);
        });

        // Sorted, so a tie-break over the listing resolves the same way every pass.
        expect(entries).toEqual([
            { uri: 'A.vcf', key: 'a.vcf' },
            { uri: 'b.vcf', key: 'b.vcf' },
        ]);
        expect(warnings.some((w) => w.includes('stray.txt'))).toBe(true);
    });
});

describe('diffFileStats', () => {
    test('splits a listing against the index into changed, added and vanished', () => {
        const files = new Map([
            ['same', { mtime: 10, size: 1 }],
            ['drifted', { mtime: 20, size: 2 }],
            ['new', { mtime: 30, size: 3 }],
        ]);
        const rows = new Map([
            ['same', { mtime: 10, size: 1, id: 'same' }],
            ['drifted', { mtime: 19, size: 2, id: 'drifted' }],
            ['gone', { mtime: 40, size: 4, id: 'gone' }],
        ]);

        const diff = diffFileStats(files, rows);

        expect(diff.changed).toEqual([{ file: { mtime: 20, size: 2 }, row: { mtime: 19, size: 2, id: 'drifted' } }]);
        expect(diff.added).toEqual([{ mtime: 30, size: 3 }]);
        expect(diff.vanished).toEqual([{ mtime: 40, size: 4, id: 'gone' }]);
    });

    test('a size-only drift is changed too', () => {
        const diff = diffFileStats(new Map([['a', { mtime: 10, size: 9 }]]), new Map([['a', { mtime: 10, size: 1 }]]));

        expect(diff.changed).toHaveLength(1);
        expect(diff.added).toEqual([]);
        expect(diff.vanished).toEqual([]);
    });

    test('a same-stat pair is none of the three', () => {
        const diff = diffFileStats(new Map([['a', { mtime: 10, size: 1 }]]), new Map([['a', { mtime: 10, size: 1 }]]));

        expect(diff).toEqual({ changed: [], added: [], vanished: [] });
    });

    test('a same-stat pair the domain calls stale is changed', () => {
        const diff = diffFileStats(
            new Map([['a', { mtime: 10, size: 1 }]]),
            new Map([['a', { mtime: 10, size: 1 }]]),
            () => true,
        );

        expect(diff.changed).toHaveLength(1);
    });
});

describe('dedupeByUid', () => {
    const identify = (item: { uid: string; calendarId: string; id: string; uri: string }) => ({
        scope: `${item.calendarId}/${item.uid}`,
        id: item.id,
        uri: item.uri,
    });

    test('a composite scope keeps the same uid in two collections', async () => {
        const items = [
            { uid: 'u1', calendarId: 'work', id: 'a', uri: 'a.ics' },
            { uid: 'u1', calendarId: 'home', id: 'b', uri: 'b.ics' },
        ];

        const warnings = await captureWarnings(async () => {
            expect(dedupeByUid(items, new Map(), identify)).toEqual(items);
        });

        expect(warnings).toEqual([]);
    });

    test('the first item wins its scope and a later claimant is skipped and warned', async () => {
        const items = [
            { uid: 'u1', calendarId: 'work', id: 'a', uri: 'a.ics' },
            { uid: 'u1', calendarId: 'work', id: 'b', uri: 'b.ics' },
        ];

        let kept: typeof items = [];
        const warnings = await captureWarnings(async () => {
            kept = dedupeByUid(items, new Map(), identify);
        });

        expect(kept).toEqual([items[0]]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('b.ics');
        expect(warnings[0].toUpperCase()).toContain('UID');
    });

    test('an incumbent owner keeps its slot, and a stranger claiming it loses', async () => {
        const items = [
            { uid: 'u1', calendarId: 'work', id: 'mine', uri: 'mine.ics' },
            { uid: 'u2', calendarId: 'work', id: 'other', uri: 'other.ics' },
        ];
        const owners = new Map([
            ['work/u1', 'mine'],
            ['work/u2', 'incumbent'],
        ]);

        let kept: typeof items = [];
        await captureWarnings(async () => {
            kept = dedupeByUid(items, owners, identify);
        });

        expect(kept).toEqual([items[0]]);
    });
});

describe('WriteGate', () => {
    test('run drains the whole dirty key list before it runs the body', async () => {
        const order: string[] = [];
        const gate = new WriteGate(async (keys, settled) => {
            order.push(`recover ${keys.join(',')}`);
            for (const key of keys) settled(key);
        });
        gate.markDirty('a');
        gate.markDirty('b');

        await gate.run(async () => {
            order.push('body');
        });

        expect(order).toEqual(['recover a,b', 'body']);
    });

    test('a clean gate never calls the recovery and takes no lock', async () => {
        let calls = 0;
        const gate = new WriteGate(async () => {
            calls++;
        });

        await gate.ensureDrained();
        await gate.run(async () => {});

        expect(calls).toBe(0);
    });

    test('a failed recovery keeps the key dirty and the next ensureDrained retries it', async () => {
        const seen: string[][] = [];
        let fail = true;
        const gate = new WriteGate(async (keys, settled) => {
            seen.push(keys);
            if (fail) throw new Error('recover boom');
            for (const key of keys) settled(key);
        });
        gate.markDirty('a');

        await expect(gate.ensureDrained()).rejects.toThrow('recover boom');

        fail = false;
        await gate.ensureDrained();
        await gate.ensureDrained();

        expect(seen).toEqual([['a'], ['a']]);
    });

    test('a key settled before the recovery throws is not recovered again', async () => {
        const seen: string[][] = [];
        const gate = new WriteGate(async (keys, settled) => {
            seen.push(keys);
            settled('good');
            throw new Error('recover boom');
        });
        gate.markDirty('good');
        gate.markDirty('bad');

        await expect(gate.ensureDrained()).rejects.toThrow('recover boom');
        await expect(gate.ensureDrained()).rejects.toThrow('recover boom');
        await expect(gate.ensureDrained()).rejects.toThrow('recover boom');

        // Re-committing a settled key on every later drain would bump the domain's ctag each time.
        expect(seen).toEqual([['good', 'bad'], ['bad'], ['bad']]);
    });

    test('recoverPending drops a key it cannot recover and keeps going', async () => {
        const seen: string[][] = [];
        const gate = new WriteGate(async (keys, settled) => {
            seen.push(keys);
            if (keys.includes('bad')) throw new Error('recover boom');
            for (const key of keys) settled(key);
        });

        const warnings = await captureWarnings(() => gate.recoverPending(['bad', 'good']));

        expect(seen).toEqual([['bad'], ['good']]);
        expect(warnings.some((w) => w.includes('bad'))).toBe(true);

        // The failed key is forgotten in memory — its durable journal row is what brings it back.
        await gate.ensureDrained();
        expect(seen).toHaveLength(2);
    });

    test('ensureDrained called by the body that holds the lock returns instead of re-entering it', async () => {
        let calls = 0;
        const gate = new WriteGate(async (keys, settled) => {
            calls++;
            for (const key of keys) settled(key);
        });

        await completesWithin(
            gate.run(async () => {
                // readResourceFile marks a key dirty and returns null, so a body really can reach a non-empty set.
                gate.markDirty('a');
                await gate.ensureDrained();
            }),
            2000,
            'ensureDrained() self-deadlocked inside run()',
        );

        expect(calls).toBe(0);
    });

    test('a nested run is refused and the outer run still releases the lock', async () => {
        const gate = new WriteGate(async () => {});
        let nested: unknown;

        await completesWithin(
            gate.run(async () => {
                nested = await gate.run(async () => 'inner').catch((e) => e);
            }),
            2000,
            'a nested run() deadlocked its own outer run()',
        );

        expect(nested).toBeInstanceOf(Error);
        expect((nested as Error).message).toContain('not reentrant');
        await completesWithin(
            gate.run(async () => {}),
            2000,
            'the refused nested run() left the lock held',
        );
    });

    test('work that outlives its run takes the gate as an outside caller', async () => {
        const gate = new WriteGate(async () => {});
        let detached!: Promise<void>;
        let release!: () => void;
        const afterRun = new Promise<void>((resolve) => {
            release = resolve;
        });

        await gate.run(async () => {
            detached = afterRun.then(() => gate.run(async () => {}));
        });
        release();

        await completesWithin(detached, 2000, 'a continuation that outlived its run() was refused the gate');
    });

    test('run serializes bodies through one slot, each draining from its own context', async () => {
        const seen: string[][] = [];
        const gate = new WriteGate(async (keys, settled) => {
            seen.push(keys);
            for (const key of keys) settled(key);
        });
        const order: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        const first = gate.run(async () => {
            order.push('first in');
            gate.markDirty('a');
            await held;
            order.push('first out');
        });
        const second = gate.run(async () => {
            order.push('second in');
        });
        release();
        await completesWithin(Promise.all([first, second]), 2000, 'two independent run() calls deadlocked');

        expect(order).toEqual(['first in', 'first out', 'second in']);
        // The queued caller is an outside caller: it drains what the first body left behind.
        expect(seen).toEqual([['a']]);
    });
});
