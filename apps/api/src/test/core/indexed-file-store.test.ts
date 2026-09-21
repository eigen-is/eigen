import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFilesystem } from '../../lib/core';
import {
    computeResourceEtag,
    dedupeByUid,
    diffFileStats,
    listResourceUris,
    nextSyncGen,
    type ResourceScan,
    type ResourceStat,
    sanitizeResourceUri,
    statResourceDir,
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

describe('statResourceDir', () => {
    test('keys every listed resource by its folded uri and carries the rounded stat', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        writeFileSync(join(base, DIR, 'A.vcf'), 'xx');
        writeFileSync(join(base, DIR, 'b.vcf'), 'xxxx');

        const scan = await statResourceDir(store, DIR, SUFFIX);

        expect([...scan.files.keys()]).toEqual(['a.vcf', 'b.vcf']);
        expect(scan.files.get('a.vcf')?.uri).toBe('A.vcf');
        expect(scan.files.get('a.vcf')?.size).toBe(2);
        expect(Number.isInteger(scan.files.get('a.vcf')?.mtime)).toBe(true);
        expect(scan.skipped.size).toBe(0);
    });

    // The stats go out in flight together, and a caller tie-breaks a key collision on this order.
    test('more files than the scan keeps in flight still come back in listing order', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        const names = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, '0')}.vcf`);
        for (const name of names) writeFileSync(join(base, DIR, name), 'x');

        const scan = await statResourceDir(store, DIR, SUFFIX);

        expect([...scan.files.keys()]).toEqual(names);
    });

    test('a listed resource whose stat fails is skipped, not absent', async () => {
        const { store, base } = nextStore();
        await store.mkdir(DIR);
        writeFileSync(join(base, DIR, 'a.vcf'), 'x');
        writeFileSync(join(base, DIR, 'b.vcf'), 'x');
        // A stat that raises anything but "the file is gone" is transient IO, so pin the general case.
        const realStat = store.stat.bind(store);
        store.stat = (filePath: string) => {
            if (filePath.endsWith('b.vcf')) throw new Error('EIO: could not stat');
            return realStat(filePath);
        };

        let scan: ResourceScan = { files: new Map(), skipped: new Set() };
        const warnings = await captureWarnings(async () => {
            scan = await statResourceDir(store, DIR, SUFFIX);
        });

        expect([...scan.files.keys()]).toEqual(['a.vcf']);
        expect([...scan.skipped]).toEqual(['b.vcf']);
        expect(warnings.some((w) => w.includes('b.vcf'))).toBe(true);
    });
});

describe('diffFileStats', () => {
    const scanOf = (files: Record<string, ResourceStat>, skipped: string[] = []): ResourceScan => ({
        files: new Map(Object.entries(files).map(([key, stat]) => [key, { uri: key, ...stat }])),
        skipped: new Set(skipped),
    });

    test('splits a listing against the index into changed, added and vanished', () => {
        const rows = new Map([
            ['same', { mtime: 10, size: 1, id: 'same' }],
            ['drifted', { mtime: 19, size: 2, id: 'drifted' }],
            ['gone', { mtime: 40, size: 4, id: 'gone' }],
        ]);

        const diff = diffFileStats(
            scanOf({ same: { mtime: 10, size: 1 }, drifted: { mtime: 20, size: 2 }, new: { mtime: 30, size: 3 } }),
            rows,
        );

        expect(diff.changed).toEqual([
            { file: { uri: 'drifted', mtime: 20, size: 2 }, row: { mtime: 19, size: 2, id: 'drifted' } },
        ]);
        expect(diff.added).toEqual([{ uri: 'new', mtime: 30, size: 3 }]);
        expect(diff.vanished).toEqual([{ mtime: 40, size: 4, id: 'gone' }]);
    });

    test('a size-only drift is changed too', () => {
        const diff = diffFileStats(scanOf({ a: { mtime: 10, size: 9 } }), new Map([['a', { mtime: 10, size: 1 }]]));

        expect(diff.changed).toHaveLength(1);
        expect(diff.added).toEqual([]);
        expect(diff.vanished).toEqual([]);
    });

    test('a same-stat pair is none of the three', () => {
        const diff = diffFileStats(scanOf({ a: { mtime: 10, size: 1 } }), new Map([['a', { mtime: 10, size: 1 }]]));

        expect(diff).toEqual({ changed: [], added: [], vanished: [] });
    });

    test('a same-stat pair the domain calls stale is changed', () => {
        const diff = diffFileStats(
            scanOf({ a: { mtime: 10, size: 1 } }),
            new Map([['a', { mtime: 10, size: 1 }]]),
            () => true,
        );

        expect(diff.changed).toHaveLength(1);
    });

    test('a row whose file was only skipped has not vanished', () => {
        const rows = new Map([['a', { mtime: 10, size: 1, id: 'a' }]]);

        expect(diffFileStats(scanOf({}, ['a']), rows).vanished).toEqual([]);
        expect(diffFileStats(scanOf({}), rows).vanished).toHaveLength(1);
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
