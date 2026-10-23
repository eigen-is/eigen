import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
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
import { peakRss } from '../../lib/core/peak-rss';
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

// A whole zip after 16 bytes of a stored entry, its offsets counted from its own start.
function hiding(): RawPart {
    return stored('docProps/custom.bin', Buffer.concat([Buffer.alloc(16, 0x20), build([TYPES, EVIL])]));
}

// A ZIP64 archive whose plain end record fields name a central directory of EVIL's stored in an entry, up to the record.
function hiddenDirectory(): Buffer {
    const inner = build([EVIL]);
    const innerEnd = inner.length - 22;
    const local = inner.subarray(0, inner.readUInt32LE(innerEnd + 16));
    const central = Buffer.from(inner.subarray(local.length, local.length + inner.readUInt32LE(innerEnd + 12)));
    const make = () =>
        build([TYPES, REAL, stored('docProps/custom.bin', Buffer.concat([local, central]))], { zip64End: true });
    const sized = make();
    const localAt = sized.indexOf(local);
    const centralAt = localAt + local.length;
    const end = sized.length - 22;
    central.writeUInt32LE(localAt, 42);
    // The header's comment runs up to the end record.
    central.writeUInt16LE(end - (centralAt + 46 + central.readUInt16LE(28)), 32);
    const zip = make();
    zip.writeUInt16LE(1, end + 8);
    zip.writeUInt16LE(1, end + 10);
    zip.writeUInt32LE(end - centralAt, end + 12);
    zip.writeUInt32LE(centralAt, end + 16);
    return zip;
}

// A ZIP64 archive whose plain record has the right count and size and the sentinel offset. A reader taking the plain
// record seeks to 0xFFFFFFFF and counts the bytes it misses as a prefix to subtract, which lands on a directory hidden
// in an extra field, naming EVIL's entry stored in another. `skip` makes Info-ZIP take the plain record.
function infoZipFallback(skip: (zip: Buffer, end: number) => void): Buffer {
    const inner = build([EVIL]);
    const innerEnd = inner.length - 22;
    const evilLocal = inner.subarray(0, inner.readUInt32LE(innerEnd + 16));
    const evilCentral = Buffer.from(
        inner.subarray(evilLocal.length, evilLocal.length + inner.readUInt32LE(innerEnd + 12)),
    );
    const room = 400;
    const make = (blob: Buffer) =>
        build([{ ...TYPES, extra: blob }, REAL, stored('docProps/custom.bin', evilLocal)], { zip64End: true });
    const sized = make(Buffer.alloc(room, 0x20));
    const end = sized.length - 22;
    const end64 = end - 20 - 56;
    const directorySize = Number(sized.readBigUInt64LE(end64 + 40));
    const directoryStart = Number(sized.readBigUInt64LE(end64 + 48));
    const shift = 0xffffffff + directorySize - end;
    const headers: Buffer[] = [];
    for (let at = directoryStart, index = 0; index < 3; index++) {
        const length = 46 + sized.readUInt16LE(at + 28) + sized.readUInt16LE(at + 30) + sized.readUInt16LE(at + 32);
        headers.push(Buffer.from(sized.subarray(at, at + length)));
        at += length;
    }
    // A header without its extras and comment, at a shifted offset.
    const fake = (header: Buffer, offset: number) => {
        const out = Buffer.from(header.subarray(0, 46 + header.readUInt16LE(28)));
        out.writeUInt16LE(0, 30);
        out.writeUInt16LE(0, 32);
        out.writeUInt32LE(offset + shift, 42);
        return out;
    };
    const evil = Buffer.from(evilCentral);
    evil.writeUInt32LE(sized.indexOf(evilLocal) + shift, 42);
    const directory = Buffer.concat([fake(headers[0], 0), evil, fake(headers[2], headers[2].readUInt32LE(42))]);
    const blob = Buffer.alloc(room, 0x20);
    directory.copy(blob, end - directorySize - (directoryStart + 46 + TYPES.name.length));
    const zip = make(blob);
    zip.writeUInt16LE(3, end + 8);
    zip.writeUInt16LE(3, end + 10);
    zip.writeUInt32LE(directorySize, end + 12);
    zip.writeUInt32LE(0xffffffff, end + 16);
    skip(zip, end);
    return zip;
}

// A ZIP64 end record whose extensible data holds a directory naming EVIL's entry, stored in another, and a ZIP64 record
// naming that directory, last before the locator.
function extensibleData(): Buffer {
    const inner = build([EVIL]);
    const innerEnd = inner.length - 22;
    const evilLocal = inner.subarray(0, inner.readUInt32LE(innerEnd + 16));
    const evilCentral = Buffer.from(
        inner.subarray(evilLocal.length, evilLocal.length + inner.readUInt32LE(innerEnd + 12)),
    );
    const zip = build([TYPES, REAL, stored('docProps/custom.bin', evilLocal)], { zip64End: true });
    const end64 = zip.length - 22 - 20 - 56;
    const directoryStart = Number(zip.readBigUInt64LE(end64 + 48));
    evilCentral.writeUInt32LE(zip.indexOf(evilLocal), 42);
    const directory = Buffer.concat([
        zip.subarray(directoryStart, directoryStart + 46 + TYPES.name.length),
        evilCentral,
    ]);
    const fake64 = Buffer.from(zip.subarray(end64, end64 + 56));
    fake64.writeBigUInt64LE(2n, 24);
    fake64.writeBigUInt64LE(2n, 32);
    fake64.writeBigUInt64LE(BigInt(directory.length), 40);
    fake64.writeBigUInt64LE(BigInt(end64 + 56), 48);
    const data = Buffer.concat([directory, fake64]);
    const out = Buffer.concat([zip.subarray(0, end64 + 56), data, zip.subarray(end64 + 56)]);
    out.writeBigUInt64LE(BigInt(44 + data.length), end64 + 4);
    return out;
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
    [
        'bytes after an end record whose directory ends elsewhere',
        () => {
            const zip = build([TYPES, REAL]);
            return Buffer.concat([patched(zip, zip.length - 22 + 16, 0, 4), Buffer.from([0])]);
        },
        'no-end',
    ],
    ['an empty archive with a byte after its end record', () => Buffer.concat([build([]), Buffer.from([0])]), 'no-end'],
    [
        'a ZIP64 archive with a byte after its end record',
        () => Buffer.concat([build([TYPES, REAL], { zip64End: true }), Buffer.from([0])]),
        'no-end',
    ],
    [
        'a comment past the end of the file',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.length - 2, 1, 2);
        },
        'no-end',
    ],
    [
        'a comment far past the end of the file',
        () => {
            const zip = build([TYPES, REAL]);
            return patched(zip, zip.length - 2, 0xffff, 2);
        },
        'no-end',
    ],
    // java.util.zip skips these end records for the hidden one, which reads as an archive at its own start.
    [
        'a ZIP64 archive with a byte after its end record, hiding a zip in an entry',
        () => Buffer.concat([build([TYPES, REAL, hiding()], { zip64End: true }), Buffer.from([0])]),
        'no-end',
    ],
    [
        'a ZIP64 archive with a comment past the end, hiding a zip in an entry',
        () => {
            const zip = build([TYPES, REAL, hiding()], { zip64End: true });
            return patched(zip, zip.length - 2, 5, 2);
        },
        'no-end',
    ],
    [
        'a comment past the end, hiding a zip in an entry',
        () => {
            const zip = build([TYPES, REAL, hiding()]);
            return patched(zip, zip.length - 2, 5, 2);
        },
        'no-end',
    ],
    // Only java.util.zip's check on the plain fields would take this record: they name a directory up to it.
    [
        'a ZIP64 archive with a byte after its end record, whose plain fields name a directory up to it',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            const end = zip.length - 22;
            const directoryStart = zip.indexOf(CENTRAL_HEADER);
            const plain = patched(patched(patched(zip, end + 8, 2, 2), end + 10, 2, 2), end + 16, directoryStart, 4);
            return Buffer.concat([patched(plain, end + 12, end - directoryStart, 4), Buffer.from([0])]);
        },
        'no-end',
    ],
    [
        'a byte after an end record whose directory starts on no central header',
        () => {
            const zip = build([TYPES, REAL]);
            const end = zip.length - 22;
            const shifted = patched(zip, end + 16, zip.readUInt32LE(end + 16) + 4, 4);
            return Buffer.concat([patched(shifted, end + 12, zip.readUInt32LE(end + 12) - 4, 4), Buffer.from([0])]);
        },
        'no-end',
    ],
    // Python reads the last signature and refuses the record it can't read whole.
    [
        'part of a record in the last 21 bytes',
        () => Buffer.concat([build([TYPES, REAL]), Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])]),
        'ambiguous-end',
    ],
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
        'a second end record in the comment, then a byte',
        () => {
            const real = build([TYPES, REAL]);
            const comment = build([TYPES, EVIL], { base: real.length });
            return Buffer.concat([build([TYPES, REAL], { comment }), Buffer.from([0])]);
        },
        'ambiguous-end',
    ],
    [
        'a second end record after the end record',
        () => Buffer.concat([build([TYPES, REAL]), build([TYPES, EVIL]).subarray(-22)]),
        'ambiguous-end',
    ],
    // A reader taking the last record would read this one, whatever directory it names.
    [
        'a record after the end record whose directory ends elsewhere',
        () => Buffer.concat([build([TYPES, REAL]), build([TYPES, EVIL]).subarray(-22), Buffer.from([0])]),
        'ambiguous-end',
    ],
    ...(
        [
            ['entry count on this disk', 8, 2],
            ['entry count', 10, 2],
            ['directory size', 12, 4],
            ['directory offset', 16, 4],
        ] as const
    ).map(([field, at, width]): [string, () => Uint8Array, ZipErrorCode] => [
        `a plain ${field} differing from the ZIP64 one`,
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 + at, 1, width);
        },
        'ambiguous-end',
    ]),
    // Info-ZIP, Java and Go read the plain fields, which name a directory hidden in an entry.
    ['plain end record fields naming a hidden directory', hiddenDirectory, 'ambiguous-end'],
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
        'no disk in the ZIP64 locator',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 - 4, 0, 4);
        },
        'multi-disk',
    ],
    [
        'a plain disk number beside a ZIP64 end record',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 + 4, 5, 2);
        },
        'multi-disk',
    ],
    [
        'a plain start disk beside a ZIP64 end record',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            return patched(zip, zip.length - 22 + 6, 7, 2);
        },
        'multi-disk',
    ],
    // Info-ZIP reads the plain record instead of these, and so a directory hidden in an extra field.
    [
        'no disk in the ZIP64 locator, over a plain record leading to a hidden directory',
        () => infoZipFallback((zip, end) => zip.writeUInt32LE(0, end - 4)),
        'multi-disk',
    ],
    [
        'a plain disk number over a plain record leading to a hidden directory',
        () => infoZipFallback((zip, end) => zip.writeUInt16LE(5, end + 4)),
        'multi-disk',
    ],
    [
        'a second disk in the ZIP64 locator, over a plain record leading to a hidden directory',
        () => infoZipFallback((zip, end) => zip.writeUInt32LE(1, end - 16)),
        'multi-disk',
    ],
    [
        'a second directory disk in the ZIP64 end record, over a plain record leading to a hidden directory',
        () => infoZipFallback((zip, end) => zip.writeUInt32LE(1, end - 20 - 56 + 20)),
        'multi-disk',
    ],
    [
        "a ZIP64 end record's entries on this disk short of its total, over a plain record leading to a hidden directory",
        () => infoZipFallback((zip, end) => zip.writeBigUInt64LE(5n, end - 20 - 56 + 24)),
        'multi-disk',
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
    [
        'bytes between the ZIP64 end record and its locator, its size unchanged',
        () => {
            const zip = build([TYPES, REAL], { zip64End: true });
            const after64 = zip.length - 22 - 20;
            return Buffer.concat([zip.subarray(0, after64), new Uint8Array(4), zip.subarray(after64)]);
        },
        'misplaced',
    ],
    // Python reads the 56 bytes before the locator: here a ZIP64 record naming a directory of EVIL's.
    ['a ZIP64 end record with extensible data', extensibleData, 'misplaced'],
    [
        'a prefix and a byte after the end record',
        () => Buffer.concat([new Uint8Array(1024), build([TYPES, REAL], { base: 1024 }), Buffer.from([0])]),
        'no-end',
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
    // The entry was fine; the memory ran out, which the transform process answers itself.
    test('an out-of-memory inflating an entry is thrown as it is, not as a corrupt archive', () => {
        const outOfMemory = new RangeError('Out of memory');
        const inflate = spyOn(zlib, 'inflateRawSync').mockImplementationOnce(() => {
            throw outOfMemory;
        });
        try {
            expect(() => openZip(build([TYPES, REAL])).read('word/document.xml')).toThrow(outOfMemory);
        } finally {
            inflate.mockRestore();
        }
    });

    test('every entry with its bytes, in the order of the directory', () => {
        const zip = openZip(build([TYPES, REAL]));
        expect([...zip.files()].map(([name, read]) => [name, utf8.decode(read())])).toEqual(
            zip.names().map((name) => [name, utf8.decode(zip.read(name))]),
        );
    });

    test('an entry walked past unread is never inflated', () => {
        const zip = openZip(build([{ ...REAL, crc: 0xdeadbeef }, TYPES]));
        expect([...zip.files()].flatMap(([name, read]) => (name === TYPES.name ? [utf8.decode(read())] : []))).toEqual([
            '<Types/>',
        ]);
    });

    test('stored and deflated entries, with their sizes', () => {
        const zip = openZip(build([TYPES, REAL]));
        expect(zip.names()).toEqual(['[Content_Types].xml', 'word/document.xml']);
        expect(utf8.decode(zip.read('word/document.xml'))).toBe('<w:document>REAL</w:document>');
        expect(zip.entry('word/document.xml')?.size).toBe(REAL.size);
        expect(zip.read('word/missing.xml')).toBeUndefined();
        expect(Object.keys(zip.entry('word/document.xml') ?? {}).sort()).toEqual([
            'compressedSize',
            'crc32',
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

    // As Info-ZIP, LibreOffice, PowerPoint and java.util.zip read them: POI's HowWeRefactor.pptx has a byte after its end record.
    test('bytes after the end record', () => {
        const zip = build([TYPES, REAL]);
        const shapes = [
            Buffer.concat([zip, Buffer.from([0])]),
            Buffer.concat([zip, Buffer.from('trailing')]),
            Buffer.concat([build([TYPES, REAL], { comment: Buffer.from('a comment') }), Buffer.from([0])]),
        ];
        for (const shape of shapes) expect(readAll(shape)).toEqual(readAll(zip));
    });

    test('a ZIP64 archive whose plain record has its count and size and the sentinel offset', () => {
        expect(readAll(infoZipFallback(() => {})).get('word/document.xml')).toBe('<w:document>REAL</w:document>');
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
        for (const streamFiles of [false, true]) {
            const source = new JSZip();
            source.file('[Content_Types].xml', '<Types/>');
            source.file('word/document.xml', '<w:document>Ünïcode — text</w:document>'.repeat(50));
            source.file(
                'word/media/image1.png',
                new Uint8Array(4000).map((_, i) => i % 251),
                { compression: 'STORE' },
            );
            source.file('word/media/café.png', new Uint8Array(0));
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
        const { peakRss } = await import(process.env.PEAK_RSS);
        const bytes = await Bun.file(process.env.ZIP_PATH).bytes();
        let outcome = 'ok';
        try {
            const zip = openZip(bytes);
            for (const name of zip.names()) zip.read(name);
        } catch (error) {
            outcome = error instanceof ZipError ? error.code : String(error);
        }
        console.log(JSON.stringify({ outcome, maxRss: peakRss() }));
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
            env: {
                ...process.env,
                ZIP_MODULE: Bun.resolveSync('../../lib/core/zip', import.meta.dir),
                PEAK_RSS: Bun.resolveSync('../../lib/core/peak-rss', import.meta.dir),
                ZIP_PATH: path,
            },
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
        const peakBefore = peakRss();
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
                    // Bytes after the end record a quarter of the time: a shape real files have.
                    const at = next() < 0.25 ? bytes.length : pick(bytes.length + 1);
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
        expect(peakRss() - peakBefore).toBeLessThan(64 * MiB);
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

    test('round-trips through openZip: names, bytes and methods', () => {
        const zip = openZip(writeZip(files));
        expect(zip.names()).toEqual(files.map((file) => file.name));
        for (const file of files) {
            expect(Buffer.from(zip.read(file.name) ?? [])).toEqual(bytesOf(file.data));
            expect(zip.entry(file.name)?.method).toBe(file.store ? 0 : 8);
        }
    });

    test('round-trips through JSZip, every entry dated the DOS epoch', async () => {
        const zip = await JSZip.loadAsync(writeZip(files));
        for (const file of files) {
            const entry = zip.file(file.name);
            expect(Buffer.from((await entry?.async('uint8array')) ?? [])).toEqual(bytesOf(file.data));
            expect(entry?.date.toISOString()).toBe('1980-01-01T00:00:00.000Z');
        }
    });

    test('deflates a whole entry with libdeflate', () => {
        const data = bytesOf(`<sheetData>${'<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(2000)}</sheetData>`);
        const entry = openZip(writeZip([{ name: 'sheet.xml', data }])).entry('sheet.xml');
        expect(entry?.compressedSize).toBe(Bun.deflateSync(data, { library: 'libdeflate' }).length);
    });

    test('deflates an entry given as chunks one at a time, its CRC carried across them', async () => {
        const chunks = ['<sheetData>', bytesOf('<row r="1"/>'.repeat(5000)), '', 'Ünïcode — text', '</sheetData>'];
        const whole = Buffer.concat(chunks.map(bytesOf));
        const chunked = [
            { name: 'sheet.xml', data: () => chunks },
            { name: 'stored.xml', data: () => chunks, store: true },
            { name: 'empty.xml', data: () => [] },
        ];
        const bytes = writeZip(chunked);
        const zip = openZip(bytes);
        const jszip = await JSZip.loadAsync(bytes);
        for (const [name, data] of [
            ['sheet.xml', whole],
            ['stored.xml', whole],
            ['empty.xml', Buffer.alloc(0)],
        ] as const) {
            expect(Buffer.from(zip.read(name) ?? [])).toEqual(data);
            expect(Buffer.from((await jszip.file(name)?.async('uint8array')) ?? [])).toEqual(data);
        }
        expect(zip.entry('sheet.xml')?.method).toBe(8);
        expect(zip.entry('stored.xml')?.method).toBe(0);
    });

    test('flags a non-ASCII name as UTF-8', () => {
        expect(Buffer.from(writeZip([{ name: 'café.png', data: '' }])).readUInt16LE(6)).toBe(0x0800);
        expect(Buffer.from(writeZip([{ name: 'cafe.png', data: '' }])).readUInt16LE(6)).toBe(0);
    });

    test('writes one input to the same bytes', () => {
        expect(Buffer.from(writeZip(files))).toEqual(Buffer.from(writeZip(files)));
    });

    test('refuses a name twice and the ZIP64 entry count', () => {
        expect(() => writeZip([files[0], files[0]])).toThrow('zipped twice');
        const many = Array.from({ length: 0xffff }, (_, i) => ({ name: `${i}`, data: '', store: true }));
        expect(() => writeZip(many)).toThrow('ZIP64');
        const most = Buffer.from(writeZip(many.slice(1)));
        expect(most.readUInt16LE(most.length - 22 + 10)).toBe(0xfffe);
    });
});
