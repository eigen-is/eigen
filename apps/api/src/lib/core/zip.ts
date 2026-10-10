import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ApiError } from './errors';

// What OOXML packages use: stored and deflated entries, ZIP64, one disk. The directory's sizes are capped
// when the archive opens and every inflate stops at its entry's declared size, so a lying entry can't grow
// past it. Inflating is synchronous: callers run in a transform Worker.

// The bytes an archive may declare in total, for docx and xlsx: room for a dense sheet at the importer's cell cap.
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
// Far past the parts a real document holds.
export const MAX_ZIP_ENTRIES = 10_000;

export type ZipErrorCode =
    | 'no-end'
    | 'ambiguous-end'
    | 'multi-disk'
    | 'missing-zip64'
    | 'misplaced'
    | 'encrypted'
    | 'unsupported-method'
    | 'local-name-differs'
    | 'duplicate-name'
    | 'overlap'
    | 'out-of-range'
    | 'bad-size'
    | 'bad-crc'
    | 'too-many-entries'
    | 'too-large'
    | 'corrupt';

// Every refusal of openZip and of a read: 413 for an archive past the caps, 400 for any other. The message
// reaches the user, so it names no entry: those are the archive's own bytes.
export class ZipError extends ApiError {
    constructor(
        readonly code: ZipErrorCode,
        options?: ErrorOptions,
    ) {
        const tooLarge = code === 'too-many-entries' || code === 'too-large';
        super(tooLarge ? 413 : 400, tooLarge ? 'Archive too large' : 'Not a valid zip file', options);
    }
}

type ZipEntry = {
    name: string;
    method: 0 | 8;
    crc32: number;
    compressedSize: number;
    // As declared: a read checks it.
    size: number;
};

type Located = { entry: ZipEntry; dataStart: number };

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
// Traditional and strong encryption.
const ENCRYPTED_FLAGS = 0x0001 | 0x0040;
const UTF8_FLAG = 0x0800;

// Names are kept verbatim and found only by their exact name: a BOM stays, so it can't alias another name.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

export class ZipReader {
    readonly #bytes: Uint8Array;
    readonly #entries: Map<string, Located>;

    constructor(bytes: Uint8Array, entries: Map<string, Located>) {
        this.#bytes = bytes;
        this.#entries = entries;
    }

    names(): string[] {
        return [...this.#entries.keys()];
    }

    entry(name: string): ZipEntry | undefined {
        return this.#entries.get(name)?.entry;
    }

    read(name: string): Uint8Array | undefined {
        const located = this.#entries.get(name);
        return located && this.#inflate(located);
    }

    // Every entry with its bytes, in the directory's order.
    *files(): Generator<[name: string, data: Uint8Array]> {
        for (const [name, located] of this.#entries) yield [name, this.#inflate(located)];
    }

    #inflate({ entry, dataStart }: Located): Uint8Array {
        const raw = this.#bytes.subarray(dataStart, dataStart + entry.compressedSize);
        const data = entry.method === 0 ? raw : inflate(raw, entry.size);
        if (data.length !== entry.size) throw new ZipError('bad-size');
        if (Bun.hash.crc32(data) !== entry.crc32) throw new ZipError('bad-crc');
        return data;
    }
}

function inflate(raw: Uint8Array, size: number): Uint8Array {
    try {
        // zlib stops at maxOutputLength; Bun.inflateSync has no such bound.
        return inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    } catch (error) {
        if (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ZipError('bad-size');
        }
        throw new ZipError('corrupt', { cause: error });
    }
}

export function openZip(bytes: Uint8Array): ZipReader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at: number) => view.getUint16(at, true);
    const u32 = (at: number) => view.getUint32(at, true);
    // Exact below 2^53; rounding above it keeps a value far past every cap and offset.
    const u64 = (at: number) => u32(at + 4) * 2 ** 32 + u32(at);
    const inside = (start: number, length: number, end: number) => start + length <= end;

    const end = findEnd(bytes, view);
    let count = u16(end + 10);
    let directorySize = u32(end + 12);
    let directoryStart = u32(end + 16);
    let directoryEnd = end;
    if (end >= 20 && u32(end - 20) === END64_LOCATOR) {
        const end64 = u64(end - 12);
        if (u32(end - 16) !== 0 || u32(end - 4) > 1) throw new ZipError('multi-disk');
        if (!inside(end64, 56, end - 20) || u32(end64) !== END64) throw new ZipError('corrupt');
        // The record runs up to its locator, so no bytes hide between them.
        if (end64 + 12 + u64(end64 + 4) !== end - 20) throw new ZipError('misplaced');
        if (u32(end64 + 16) !== 0 || u32(end64 + 20) !== 0 || u64(end64 + 24) !== u64(end64 + 32)) {
            throw new ZipError('multi-disk');
        }
        count = u64(end64 + 32);
        directorySize = u64(end64 + 40);
        directoryStart = u64(end64 + 48);
        directoryEnd = end64;
    } else {
        if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count) throw new ZipError('multi-disk');
        if (count === MAX16 || directorySize === MAX32 || directoryStart === MAX32) throw new ZipError('missing-zip64');
    }
    // The directory ends where the end record starts, and each entry takes at least 46 bytes of it.
    if (directoryStart + directorySize !== directoryEnd || count * 46 > directorySize) throw new ZipError('misplaced');
    if (count > MAX_ZIP_ENTRIES) throw new ZipError('too-many-entries');

    const entries = new Map<string, Located>();
    const spans: [start: number, end: number][] = [];
    let declaredTotal = 0;
    let at = directoryStart;
    for (let index = 0; index < count; index++) {
        if (!inside(at, 46, directoryEnd) || u32(at) !== CENTRAL) throw new ZipError('corrupt');
        const flags = u16(at + 8);
        const method = u16(at + 10);
        const nameLength = u16(at + 28);
        const extraStart = at + 46 + nameLength;
        const extraLength = u16(at + 30);
        const next = extraStart + extraLength + u16(at + 32);
        if (next > directoryEnd) throw new ZipError('corrupt');
        const nameBytes = bytes.subarray(at + 46, extraStart);
        // UTF-8 whatever the flag: OOXML names are ASCII, which CP437 reads alike, and a name is found only exactly.
        const name = utf8.decode(nameBytes);
        if (flags & ENCRYPTED_FLAGS) throw new ZipError('encrypted');
        if (method !== 0 && method !== 8) throw new ZipError('unsupported-method');

        let size = u32(at + 24);
        let compressedSize = u32(at + 20);
        let offset = u32(at + 42);
        if (size === MAX32 || compressedSize === MAX32 || offset === MAX32) {
            const extra = findExtra(view, extraStart, extraLength, ZIP64_EXTRA);
            let field = extra?.start ?? 0;
            const take = () => {
                if (!extra || field + 8 > extra.end) throw new ZipError('missing-zip64');
                const value = u64(field);
                field += 8;
                return value;
            };
            if (size === MAX32) size = take();
            if (compressedSize === MAX32) compressedSize = take();
            if (offset === MAX32) offset = take();
        }
        declaredTotal += size;
        if (declaredTotal > MAX_DECOMPRESSED_BYTES) throw new ZipError('too-large');

        if (!inside(offset, 30, directoryStart)) throw new ZipError('out-of-range');
        if (u32(offset) !== LOCAL) throw new ZipError('corrupt');
        if (u16(offset + 6) & ENCRYPTED_FLAGS) throw new ZipError('encrypted');
        const localNameLength = u16(offset + 26);
        const dataStart = offset + 30 + localNameLength + u16(offset + 28);
        if (!inside(dataStart, compressedSize, directoryStart)) throw new ZipError('out-of-range');
        if (Buffer.compare(bytes.subarray(offset + 30, offset + 30 + localNameLength), nameBytes) !== 0) {
            throw new ZipError('local-name-differs');
        }
        if (entries.has(name)) throw new ZipError('duplicate-name');
        entries.set(name, { entry: { name, method, crc32: u32(at + 16), compressedSize, size }, dataStart });
        spans.push([offset, dataStart + compressedSize]);
        at = next;
    }
    if (at !== directoryEnd) throw new ZipError('misplaced');

    spans.sort((a, b) => a[0] - b[0]);
    // A prefix would let the bytes read as another format too.
    if ((spans[0]?.[0] ?? directoryStart) !== 0) throw new ZipError('misplaced');
    for (let index = 1; index < spans.length; index++) {
        if (spans[index][0] < spans[index - 1][1]) throw new ZipError('overlap');
    }
    return new ZipReader(bytes, entries);
}

// The end record is the one whose comment reaches the end of the file. A comment can hold a second such
// record, which another reader would take for the archive, so two are refused.
function findEnd(bytes: Uint8Array, view: DataView): number {
    const found: number[] = [];
    const last = bytes.length - 22;
    for (let at = last; at >= Math.max(0, last - MAX16); at--) {
        if (
            bytes[at] === 0x50 &&
            view.getUint32(at, true) === END &&
            at + 22 + view.getUint16(at + 20, true) === bytes.length
        ) {
            found.push(at);
        }
    }
    if (found.length === 0) throw new ZipError('no-end');
    if (found.length > 1) throw new ZipError('ambiguous-end');
    return found[0];
}

function findExtra(
    view: DataView,
    start: number,
    length: number,
    id: number,
): { start: number; end: number } | undefined {
    for (let at = start; at + 4 <= start + length; at += 4 + view.getUint16(at + 2, true)) {
        // An extra's declared length doesn't reach past the header's extras.
        if (view.getUint16(at, true) === id) {
            return { start: at + 4, end: Math.min(at + 4 + view.getUint16(at + 2, true), start + length) };
        }
    }
    return undefined;
}

export type ZipWriteEntry = { name: string; data: Uint8Array | string; store?: boolean };

const utf8Encoder = new TextEncoder();
// Every entry is dated the DOS epoch, 1 January 1980 at midnight, so one input always zips to the same bytes.
const DOS_TIME = 0;
const DOS_DAY = (1 << 5) | 1;

// Deflates unless `store`. No ZIP64: past 4 GB or 65,534 entries it throws, as a sentinel value would need one.
export function writeZip(files: Iterable<ZipWriteEntry>): Uint8Array {
    const names = new Set<string>();
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const file of files) {
        if (names.has(file.name)) throw new Error(`${file.name} is zipped twice`);
        names.add(file.name);
        const name = utf8Encoder.encode(file.name);
        const data = typeof file.data === 'string' ? utf8Encoder.encode(file.data) : file.data;
        const body = file.store ? data : deflateRawSync(data);
        const localSize = 30 + name.length + body.length;
        if (name.length > MAX16 || data.length >= MAX32 || offset + localSize >= MAX32 || names.size >= MAX16) {
            throw new Error('The zip needs ZIP64');
        }
        const flags = name.some((byte) => byte > 0x7f) ? UTF8_FLAG : 0;
        const shared: Field[] = [
            [20, 2],
            [flags, 2],
            [file.store ? 0 : 8, 2],
            [DOS_TIME, 2],
            [DOS_DAY, 2],
            [Bun.hash.crc32(data), 4],
            [body.length, 4],
            [data.length, 4],
            [name.length, 2],
            [0, 2],
        ];
        chunks.push(record([[LOCAL, 4], ...shared], name), body);
        central.push(record([[CENTRAL, 4], [20, 2], ...shared, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]], name));
        offset += localSize;
    }
    const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
    if (offset + directorySize >= MAX32) throw new Error('The zip needs ZIP64');
    const count = central.length;
    const end = record([
        [END, 4],
        [0, 2],
        [0, 2],
        [count, 2],
        [count, 2],
        [directorySize, 4],
        [offset, 4],
        [0, 2],
    ]);
    const out = new Uint8Array(offset + directorySize + end.length);
    let at = 0;
    for (const chunk of [...chunks, ...central, end]) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

type Field = [value: number, width: 2 | 4];

function record(fields: Field[], name = new Uint8Array(0)): Uint8Array {
    const length = fields.reduce((sum, [, width]) => sum + width, 0);
    const out = new Uint8Array(length + name.length);
    const view = new DataView(out.buffer);
    let at = 0;
    for (const [value, width] of fields) {
        if (width === 4) view.setUint32(at, value, true);
        else view.setUint16(at, value, true);
        at += width;
    }
    out.set(name, length);
    return out;
}
