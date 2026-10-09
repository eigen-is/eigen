import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
    ApiError,
    MAX_DECOMPRESSED_BYTES,
    MAX_ZIP_ENTRIES,
    openZip,
    writeZip,
    ZipError,
    type ZipErrorCode,
} from '../../lib/core';
import { build, deflated, deflatedZeros, type RawPart, stored } from '../fixtures/raw-zip';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const TYPES = stored('[Content_Types].xml', '<Types/>');
const REAL = deflated('word/document.xml', '<w:document>REAL</w:document>');
const EVIL = deflated('word/document.xml', '<w:document>EVIL</w:document>');
const CENTRAL_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const utf8 = new TextDecoder();

const zeros = new Map<number, Uint8Array>();
function zeroStream(bytes: number): Uint8Array {
    const stream = zeros.get(bytes) ?? deflatedZeros(bytes);
    zeros.set(bytes, stream);
    return stream;
}

// A deflate stream of `real` zeros, declaring `declared`.
function bomb(name: string, real: number, declared: number, crc = 0): RawPart {
    return { name, body: zeroStream(real), method: 8, size: declared, crc };
}

function patched(bytes: Uint8Array, at: number, value: number, width: 2 | 4): Buffer {
    const out = Buffer.from(bytes);
    if (width === 2) out.writeUInt16LE(value, at);
    else out.writeUInt32LE(value, at);
    return out;
}

// Every entry read, the most a caller can ask of an archive.
function readAll(bytes: Uint8Array): Map<string, string> {
    const zip = openZip(bytes);
    return new Map(zip.names().map((name) => [name, utf8.decode(zip.read(name))]));
}

function refusal(bytes: Uint8Array): ZipError {
    try {
        readAll(bytes);
    } catch (error) {
        if (error instanceof ZipError) return error;
        throw error;
    }
    throw new Error('expected a ZipError');
}

const bombs: Record<string, () => Uint8Array> = {
    'an honest 1 GiB bomb': () => build([TYPES, bomb('word/document.xml', GiB, GiB)]),
    'a 1 GiB bomb declaring 1 KB': () => build([TYPES, bomb('word/document.xml', GiB, 1000)]),
    // 300 MiB real against 300 KB declared.
    '300 parts of 1 MiB declaring 1 KB each': () =>
        build([TYPES, REAL, ...Array.from({ length: 300 }, (_, i) => bomb(`word/media/image${i}.png`, MiB, 1000))]),
    // Fifield's overlap: 40 central entries, each an honest 5 MiB, on one local header.
    '40 central entries on one local header': () => {
        const first = bomb('word/media/a.bin', 5 * MiB, 5 * MiB, Bun.hash.crc32(new Uint8Array(5 * MiB)));
        return build([
            first,
            ...Array.from({ length: 40 }, (_, i) => ({ ...first, name: `word/media/b${i}.bin`, offset: 0 })),
        ]);
    },
};

const refused: [string, () => Uint8Array, ZipErrorCode][] = [
    ['an honest 1 GiB bomb', bombs['an honest 1 GiB bomb'], 'too-large'],
    ['a 1 GiB bomb declaring 1 KB', bombs['a 1 GiB bomb declaring 1 KB'], 'bad-size'],
    ['300 parts of 1 MiB declaring 1 KB each', bombs['300 parts of 1 MiB declaring 1 KB each'], 'bad-size'],
    ['40 central entries on one local header', bombs['40 central entries on one local header'], 'local-name-differs'],
    [
        `${MAX_ZIP_ENTRIES + 1} entries`,
        () => build(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => stored(`customXml/item${i}.xml`, 'x'))),
        'too-many-entries',
    ],
    [
        'a count past the cap over a two-entry directory',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(patched(zip, zip.length - 22 + 8, 20_000, 2), zip.length - 22 + 10, 20_000, 2);
        },
        'misplaced',
    ],
    [
        '100,000 entries',
        () => build(Array.from({ length: 100_000 }, (_, i) => stored(`customXml/item${i}.xml`, 'x'))),
        'too-many-entries',
    ],
    [
        'parts declaring one byte over the cap together',
        () => build([TYPES, bomb('a.bin', 1, MAX_DECOMPRESSED_BYTES - TYPES.size), bomb('b.bin', 1, 1)]),
        'too-large',
    ],
    [
        'a ZIP64 entry declaring 1 TiB',
        () => build([TYPES, { ...REAL, zip64: true, size: 2 ** 40 }], { zip64End: true }),
        'too-large',
    ],
    [
        'the first half of an archive',
        () => {
            const whole = build([TYPES, REAL, deflated('word/styles.xml', '<w:styles/>'.repeat(500))]);
            return whole.subarray(0, whole.length >> 1);
        },
        'no-end',
    ],
    ['all but the last 10 bytes', () => build([TYPES, REAL]).subarray(0, -10), 'no-end'],
    ['bytes after the end record', () => Buffer.concat([build([TYPES, REAL]), Buffer.from('trailing')]), 'no-end'],
    ['text', () => Buffer.from('<w:document/>'), 'no-end'],
    ['nothing', () => new Uint8Array(0), 'no-end'],
    [
        'a second end record in the comment',
        () => {
            const real = build([TYPES, REAL]);
            return build([TYPES, REAL], { comment: build([TYPES, EVIL], { base: real.length }) });
        },
        'ambiguous-end',
    ],
    [
        'a second disk',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.length - 22 + 4, 1, 2);
        },
        'multi-disk',
    ],
    [
        'a ZIP64 sentinel without a ZIP64 record',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.length - 22 + 16, 0xffffffff, 4);
        },
        'missing-zip64',
    ],
    [
        'a ZIP64 size without its extra field',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.indexOf(CENTRAL_HEADER) + 24, 0xffffffff, 4);
        },
        'missing-zip64',
    ],
    [
        'a ZIP64 extra field shorter than its values',
        () => {
            const zip = build([{ ...REAL, zip64: true }], { zip64End: true });
            const extra = zip.indexOf(CENTRAL_HEADER) + 46 + REAL.name.length;
            return patched(zip, extra + 2, 8, 2);
        },
        'missing-zip64',
    ],
    [
        "a ZIP64 extra field past its header's extras",
        () => {
            const zip = build([{ ...REAL, zip64: true }], { zip64End: true });
            return patched(zip, zip.indexOf(CENTRAL_HEADER) + 30, 12, 2);
        },
        'missing-zip64',
    ],
    [
        'no ZIP64 end record where its locator points',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 - 20 - 56, 0x06054b50, 4);
        },
        'corrupt',
    ],
    [
        'a second disk in the ZIP64 end record',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 - 20 - 56 + 16, 1, 4);
        },
        'multi-disk',
    ],
    [
        'bytes between the ZIP64 end record and its locator',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            const end64 = zip.length - 22 - 20 - 56;
            return patched(zip, end64 + 4, 43, 4);
        },
        'misplaced',
    ],
    ['a prefix the offsets ignore', () => Buffer.concat([new Uint8Array(1024), build([TYPES, REAL])]), 'misplaced'],
    [
        'a prefix the offsets count',
        () => Buffer.concat([new Uint8Array(1024), build([TYPES, REAL], { base: 1024 })]),
        'misplaced',
    ],
    [
        'a count beyond the directory',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(patched(zip, zip.length - 22 + 8, 3, 2), zip.length - 22 + 10, 3, 2);
        },
        'misplaced',
    ],
    [
        'a count short of the directory',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(patched(zip, zip.length - 22 + 8, 1, 2), zip.length - 22 + 10, 1, 2);
        },
        'misplaced',
    ],
    [
        'a header straddling the end of the directory',
        () => {
            // The central name is 4 bytes short, so the next header starts on its last 4: a header signature.
            const name = `word/${'x'.repeat(41)}PK\u0001\u0002`;
            const zip = build([{ ...stored(name, 'x'), localName: name.slice(0, -4) }]);
            const central = zip.indexOf(CENTRAL_HEADER);
            return patched(patched(zip, central + 28, name.length - 4, 2), zip.length - 22 + 8, 2 * 0x10001, 4);
        },
        'corrupt',
    ],
    [
        'a header running past the directory',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.lastIndexOf(CENTRAL_HEADER) + 32, 10, 2);
        },
        'corrupt',
    ],
    ['an encrypted entry', () => build([TYPES, { ...REAL, flags: 0x0001 }]), 'encrypted'],
    ['a strongly encrypted entry', () => build([TYPES, { ...REAL, flags: 0x0041 }]), 'encrypted'],
    [
        'an entry encrypted in its local header only',
        () => patched(build([TYPES, REAL]), 30 + TYPES.name.length + TYPES.body.length + 6, 1, 2),
        'encrypted',
    ],
    [
        'an entry encrypted in its central header only',
        () => patched(build([TYPES, REAL]), build([TYPES, REAL]).lastIndexOf(CENTRAL_HEADER) + 8, 1, 2),
        'encrypted',
    ],
    ['method 12 (bzip2)', () => build([TYPES, { ...REAL, method: 12 }]), 'unsupported-method'],
    [
        'a local name differing from the central one',
        () => build([TYPES, { ...REAL, localName: 'word/evil.xml' }]),
        'local-name-differs',
    ],
    ['a name twice', () => build([TYPES, REAL, EVIL]), 'duplicate-name'],
    [
        "an entry inside another's data",
        () => {
            const styles = deflated('word/styles.xml', '<w:styles/>');
            const stylesLocal = build([styles]).subarray(0, 30 + styles.name.length + styles.body.length);
            const document = stored('word/document.xml', stylesLocal);
            return build([document, { ...styles, offset: 30 + document.name.length }, TYPES]);
        },
        'overlap',
    ],
    [
        'an entry whose data runs past the entries',
        () => {
            const zip = build([TYPES, REAL]);
            const second = zip.lastIndexOf(CENTRAL_HEADER);
            return patched(zip, second + 20, REAL.body.length + 1000, 4);
        },
        'out-of-range',
    ],
    ['an entry starting past the entries', () => build([TYPES, { ...REAL, offset: 1_000_000 }]), 'out-of-range'],
    ['a stored entry with two sizes', () => build([TYPES, { ...stored('a.xml', 'abc'), size: 4 }]), 'bad-size'],
    ['an entry inflating short of its size', () => build([TYPES, { ...REAL, size: REAL.size + 1 }]), 'bad-size'],
    ['a bad CRC-32', () => build([TYPES, { ...REAL, crc: 0xdeadbeef }]), 'bad-crc'],
    ['no deflate stream', () => build([TYPES, { ...REAL, body: new Uint8Array([0xff, 0xff, 0xff]) }]), 'corrupt'],
    ['a truncated deflate stream', () => build([TYPES, { ...REAL, body: REAL.body.subarray(0, 5) }]), 'corrupt'],
];

describe('openZip refuses', () => {
    test.each(refused)('%s', (_, make, code) => {
        const error = refusal(make());
        expect(error).toBeInstanceOf(ApiError);
        expect(error.code).toBe(code);
        expect(error.status).toBe(code === 'too-large' || code === 'too-many-entries' ? 413 : 400);
        expect(error.message).toBe(error.status === 413 ? 'Archive too large' : 'Not a valid zip file');
    });

    test('with a message that holds no entry name', () => {
        const name = `word/${'\u0001'.repeat(100)}${'x'.repeat(60_000)}.xml`;
        const named = { ...REAL, name };
        const archives = [
            build([TYPES, { ...named, flags: 0x0001 }]),
            build([TYPES, { ...named, method: 12 }]),
            build([TYPES, { ...named, localName: 'word/evil.xml' }]),
            build([TYPES, named, named]),
            build([TYPES, { ...named, crc: 0xdeadbeef }]),
            build([TYPES, { ...named, size: named.size + 1 }]),
            build([TYPES, { ...named, body: new Uint8Array([0xff, 0xff, 0xff]) }]),
            build([TYPES, { ...named, offset: 1_000_000 }]),
            build([TYPES, bomb(name, MiB, 1000)]),
            build([TYPES, bomb(name, 1, MAX_DECOMPRESSED_BYTES)]),
        ];
        const codes = new Set<ZipErrorCode>();
        for (const archive of archives) {
            const error = refusal(archive);
            codes.add(error.code);
            expect(error.message).not.toContain('xxxx');
            expect(error.message).not.toContain('\u0001');
            expect(error.message).not.toMatch(/\d/);
        }
        expect(codes.size).toBe(archives.length - 1);
    });
});

describe('openZip reads', () => {
    test('stored and deflated entries, with their sizes and dates', () => {
        const zip = openZip(build([TYPES, REAL]));
        expect(zip.names()).toEqual(['[Content_Types].xml', 'word/document.xml']);
        expect(utf8.decode(zip.read('word/document.xml'))).toBe('<w:document>REAL</w:document>');
        expect(zip.entry('word/document.xml')?.size).toBe(REAL.size);
        // raw-zip writes DOS date 0x21: 1 January 1980.
        expect(zip.entry('word/document.xml')?.date.toISOString()).toBe('1980-01-01T00:00:00.000Z');
        expect(zip.read('word/missing.xml')).toBeUndefined();
        expect(Object.keys(zip.entry('word/document.xml') ?? {}).sort()).toEqual([
            'compressedSize',
            'crc32',
            'date',
            'method',
            'name',
            'size',
        ]);
    });

    test('up to the caps', () => {
        const entries = Array.from({ length: MAX_ZIP_ENTRIES }, (_, i) => stored(`customXml/item${i}.xml`, 'x'));
        expect(openZip(build(entries)).names()).toHaveLength(MAX_ZIP_ENTRIES);
        expect(openZip(build([TYPES, bomb('a.bin', 1, MAX_DECOMPRESSED_BYTES - TYPES.size)])).names()).toHaveLength(2);
    });

    test('an empty archive', () => {
        expect(openZip(build([])).names()).toEqual([]);
    });

    test('ZIP64 end records and entries', () => {
        const zip = build(
            [
                { ...TYPES, zip64: true },
                { ...REAL, zip64: true },
            ],
            { zip64End: true },
        );
        expect(readAll(zip).get('word/document.xml')).toBe('<w:document>REAL</w:document>');
    });

    test('an entry only when it is read', () => {
        const zip = openZip(build([TYPES, REAL, bomb('word/media/image1.png', GiB, 1000)]));
        expect(utf8.decode(zip.read('word/document.xml'))).toBe('<w:document>REAL</w:document>');
        expect(() => zip.read('word/media/image1.png')).toThrow(ZipError);
    });

    test('a zip inside a zip as its stored bytes', () => {
        const inner = build([bomb('bomb.bin', GiB, GiB)]);
        const zip = openZip(build([TYPES, REAL, stored('word/embeddings/package.zip', inner)]));
        expect(Buffer.from(zip.read('word/embeddings/package.zip') ?? [])).toEqual(Buffer.from(inner));
    });

    test('names verbatim, each found only by its exact name', () => {
        const aliases = [
            '../word/document.xml',
            'word\\document.xml',
            '/word/document.xml',
            './word/document.xml',
            'Word/Document.xml',
            '\uFEFFword/document.xml',
        ];
        for (const alias of aliases) {
            const zip = openZip(build([TYPES, { ...EVIL, name: alias }]));
            expect(zip.names()).toEqual(['[Content_Types].xml', alias]);
            expect(zip.read('word/document.xml')).toBeUndefined();
        }
        const zip = openZip(build([TYPES, REAL, ...aliases.map((name) => ({ ...EVIL, name }))]));
        expect(utf8.decode(zip.read('word/document.xml'))).toBe('<w:document>REAL</w:document>');
        expect(utf8.decode(zip.read('\uFEFFword/document.xml'))).toBe('<w:document>EVIL</w:document>');
    });

    test('what JSZip writes, as JSZip reads it: deflate, store, data descriptors, folders, a comment, a non-ASCII name', async () => {
        const date = new Date(Date.UTC(2024, 4, 17, 13, 45, 58));
        for (const streamFiles of [false, true]) {
            const source = new JSZip();
            source.file('[Content_Types].xml', '<Types/>', { date });
            source.file('word/document.xml', '<w:document>Ünïcode — text</w:document>'.repeat(50), { date });
            source.file(
                'word/media/image1.png',
                new Uint8Array(4000).map((_, i) => i % 251),
                { date, compression: 'STORE' },
            );
            source.file('word/media/café.png', new Uint8Array(0), { date });
            const bytes = await source.generateAsync({
                type: 'uint8array',
                compression: 'DEFLATE',
                streamFiles,
                comment: 'a comment',
            });
            const theirs = await JSZip.loadAsync(bytes);
            const ours = openZip(bytes);
            expect(ours.names().sort()).toEqual(Object.keys(theirs.files).sort());
            for (const file of Object.values(theirs.files)) {
                expect(Buffer.from(ours.read(file.name) ?? [])).toEqual(Buffer.from(await file.async('uint8array')));
                expect(ours.entry(file.name)?.date).toEqual(file.date);
            }
        }
    });
});

// One process per bomb, so its peak RSS is the bomb's alone.
describe('a bomb stays within its peak RSS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-bombs-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const script = `
        const { openZip, ZipError } = await import(process.env.ZIP_MODULE);
        const bytes = await Bun.file(process.env.ZIP_PATH).bytes();
        let outcome = 'ok';
        try {
            const zip = openZip(bytes);
            for (const name of zip.names()) zip.read(name);
        } catch (error) {
            outcome = error instanceof ZipError ? error.code : String(error);
        }
        console.log(JSON.stringify({ outcome, maxRss: process.resourceUsage().maxRSS * 1024 }));
    `;
    type Case = [name: string, make: () => Uint8Array, outcome: string, maxRss: number];
    const cases: Case[] = [
        ...refused.filter(([name]) => name in bombs).map(([name, make, code]): Case => [name, make, code, 64 * MiB]),
        [
            'a bomb zipped in a zip',
            () => build([TYPES, REAL, stored('word/embeddings/package.zip', build([bomb('bomb.bin', GiB, GiB)]))]),
            'ok',
            64 * MiB,
        ],
        // The one inflate that may fill the cap.
        [
            'a 1 GiB bomb declaring the whole cap',
            () => build([bomb('word/media/image1.png', GiB, MAX_DECOMPRESSED_BYTES)]),
            'bad-size',
            MAX_DECOMPRESSED_BYTES + 64 * MiB,
        ],
    ];

    test.each(cases)('%s', (name, make, outcome, maxRss) => {
        const path = join(dir, `${name}.zip`);
        writeFileSync(path, make());
        const run = Bun.spawnSync([process.execPath, '-e', script], {
            env: { ...process.env, ZIP_MODULE: Bun.resolveSync('../../lib/core/zip', import.meta.dir), ZIP_PATH: path },
        });
        const result: { outcome: string; maxRss: number } = JSON.parse(run.stdout.toString());
        expect(result.outcome).toBe(outcome);
        expect(result.maxRss).toBeLessThan(maxRss);
    });
});

// mulberry32
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('openZip under fuzzing', () => {
    test('2,000 seeded mutations of a docx and its ZIP64 twin open, read or throw a ZipError, within the memory bound', () => {
        const files = [
            { name: '[Content_Types].xml', data: '<Types><Default Extension="xml"/></Types>' },
            { name: '_rels/.rels', data: '<Relationships><Relationship Target="word/document.xml"/></Relationships>' },
            {
                name: 'word/document.xml',
                data: `<w:document>${'<w:p><w:r><w:t>Text</w:t></w:r></w:p>'.repeat(200)}</w:document>`,
            },
            { name: 'word/styles.xml', data: '<w:styles/>' },
            { name: 'word/media/image1.png', data: new Uint8Array(512).map((_, i) => (i * 7) % 256), store: true },
            { name: 'word/media/', data: '', store: true },
        ];
        const zip64 = build(
            files.map((file) => ({ ...(file.store ? stored : deflated)(file.name, file.data), zip64: true })),
            { zip64End: true },
        );
        // Header starts, so most mutations hit a field rather than deflate data.
        const sources = [Buffer.from(writeZip(files)), zip64].map((source) => ({
            source,
            headers: [0x02014b50, 0x04034b50, 0x06054b50, 0x06064b50, 0x07064b50].flatMap((signature) => {
                const found: number[] = [];
                for (let at = 0; at + 4 <= source.length; at++) {
                    if (source.readUInt32LE(at) === signature) found.push(at);
                }
                return found;
            }),
            values: [0, 1, 2, 30, 46, 0x7f, 0xff, 0x7fff, 0xffff, 0x10000, 0x7fffffff, 0xffffffff, source.length],
        }));
        const outcomes = new Map<string, number>();
        const peakBefore = process.resourceUsage().maxRSS * 1024;
        for (let round = 0; round < 2000; round++) {
            const { source, headers, values } = sources[round % 2];
            const next = random(round + 1);
            const pick = (n: number) => Math.floor(next() * n);
            let bytes = Buffer.from(source);
            for (let step = 0, steps = 1 + pick(3); step < steps; step++) {
                const kind = pick(6);
                if (kind === 0 && bytes.length > 0) bytes[pick(bytes.length)] ^= 1 << pick(8);
                else if (kind <= 2) {
                    const at = headers[pick(headers.length)] + 2 * pick(23);
                    const width = next() < 0.5 ? 2 : 4;
                    const value = next() < 0.8 ? values[pick(values.length)] : pick(2 ** (8 * width));
                    if (at + width <= bytes.length) {
                        if (width === 2) bytes.writeUInt16LE(value & 0xffff, at);
                        else bytes.writeUInt32LE(value >>> 0, at);
                    }
                } else if (kind === 3) bytes = bytes.subarray(0, pick(bytes.length + 1));
                else if (kind === 4) {
                    const at = pick(bytes.length + 1);
                    bytes = Buffer.concat([
                        bytes.subarray(0, at),
                        Buffer.from(Array.from({ length: 1 + pick(64) }, () => pick(256))),
                        bytes.subarray(at),
                    ]);
                } else {
                    const at = pick(bytes.length + 1);
                    bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 1 + pick(64))]);
                }
            }
            let outcome = 'ok';
            try {
                const zip = openZip(bytes);
                for (const name of zip.names()) {
                    const data = zip.read(name);
                    expect(data?.length).toBe(zip.entry(name)?.size);
                }
            } catch (error) {
                if (!(error instanceof ZipError)) throw new Error(`round ${round}: ${error}`);
                outcome = error.code;
            }
            outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        }
        // Not vacuous: the mutations reach both reading and many refusals.
        expect(outcomes.get('ok')).toBeGreaterThan(20);
        expect(outcomes.size).toBeGreaterThanOrEqual(10);
        expect(process.resourceUsage().maxRSS * 1024 - peakBefore).toBeLessThan(64 * MiB);
    });
});

describe('writeZip', () => {
    const files = [
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: `<w:document>${'Ünïcode — text '.repeat(100)}</w:document>` },
        { name: 'word/media/image1.png', data: new Uint8Array(3000).map((_, i) => i % 251), store: true },
        { name: 'word/media/café.png', data: new Uint8Array(0) },
    ];
    const bytesOf = (data: Uint8Array | string) =>
        Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data);

    test('round-trips through openZip: names, bytes, methods and the DOS epoch', () => {
        const zip = openZip(writeZip(files));
        expect(zip.names()).toEqual(files.map((file) => file.name));
        for (const file of files) {
            expect(Buffer.from(zip.read(file.name) ?? [])).toEqual(bytesOf(file.data));
            expect(zip.entry(file.name)?.method).toBe(file.store ? 0 : 8);
            expect(zip.entry(file.name)?.date.toISOString()).toBe('1980-01-01T00:00:00.000Z');
        }
    });

    test('round-trips through JSZip, a date to the even second', async () => {
        const date = new Date(Date.UTC(2026, 9, 9, 12, 34, 57));
        const zip = await JSZip.loadAsync(writeZip(files, date));
        for (const file of files) {
            const entry = zip.file(file.name);
            expect(Buffer.from((await entry?.async('uint8array')) ?? [])).toEqual(bytesOf(file.data));
            expect(entry?.date.toISOString()).toBe('2026-10-09T12:34:56.000Z');
        }
    });

    test('flags a non-ASCII name as UTF-8', () => {
        expect(Buffer.from(writeZip([{ name: 'café.png', data: '' }])).readUInt16LE(6)).toBe(0x0800);
        expect(Buffer.from(writeZip([{ name: 'cafe.png', data: '' }])).readUInt16LE(6)).toBe(0);
    });

    test('writes one input to the same bytes', () => {
        expect(Buffer.from(writeZip(files))).toEqual(Buffer.from(writeZip(files)));
    });

    test('refuses a name twice, a date DOS cannot hold and the ZIP64 entry count', () => {
        expect(() => writeZip([files[0], files[0]])).toThrow('zipped twice');
        expect(() => writeZip(files, new Date(Date.UTC(1979, 11, 31)))).toThrow('1980 to 2107');
        expect(() => writeZip(files, new Date(Number.NaN))).toThrow('1980 to 2107');
        const many = Array.from({ length: 0xffff }, (_, i) => ({ name: `${i}`, data: '', store: true }));
        expect(() => writeZip(many)).toThrow('ZIP64');
        const most = Buffer.from(writeZip(many.slice(1)));
        expect(most.readUInt16LE(most.length - 22 + 10)).toBe(0xfffe);
    });
});
