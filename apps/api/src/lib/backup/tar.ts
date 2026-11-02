// The tar format of Eigen's backup archives: the headers and padding a writer emits, and a reader that walks any
// tar entry by entry with each body streamed. Home archives and whole-server archives are both built on it. It
// writes no file itself, and it reads only the file bodies a writer copies in. It exists because Bun.Archive's
// writer holds the whole archive in memory, and its reader stops at or crashes on the first non-ASCII name.

import * as path from 'node:path';

export const BLOCK = 512;
export const FILE_TYPEFLAG = '0';
export const DIRECTORY_TYPEFLAG = '5';
const NAME_FIELD = 100;
// The biggest size that a header's 11 octal digits hold, 8 GiB. A bigger size is written in base-256.
const MAX_OCTAL_SIZE = 0o77777777777;
// tar's traditional blocking factor. `tar` reads a shorter archive fine, but every tar writer pads to it.
const BLOCKING_FACTOR = 20 * BLOCK;

// The biggest extended header the reader accepts. One path record fits many times over, and the size comes from
// the untrusted archive itself.
const MAX_LONG_HEADER_BYTES = 64 * 1024;

// The typeflags of a hard link, a symlink, a character device, a block device and a fifo.
const LINKS_AND_DEVICES = new Set(['1', '2', '3', '4', '6']);

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// A path over 100 bytes goes in a pax header in front of the entry. The ustar header after it carries a
// shortened name, for a reader that ignores pax.
export function* headerChunks(
    name: string,
    size: number,
    mtimeMs: number,
    typeflag: string,
    mode: number,
): Generator<Uint8Array> {
    const mtime = Math.floor(mtimeMs / 1000);
    if (ENCODER.encode(name).length > NAME_FIELD) {
        const payload = ENCODER.encode(paxRecord('path', name));
        yield tarHeader(`PaxHeader/${truncateUtf8(path.basename(name), 80)}`, payload.length, mtime, 'x', mode);
        yield payload;
        yield padding(payload.length);
    }
    yield tarHeader(truncateUtf8(name, NAME_FIELD), size, mtime, typeflag, mode);
}

export async function* fileChunks(name: string, absPath: string, size: number): AsyncGenerator<Uint8Array> {
    const reader = Bun.file(absPath).stream().getReader();
    let copied = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            copied += value.length;
            yield value;
        }
        // The header already declared `size`. A file that changed size would leave the rest of the archive unreadable.
        if (copied !== size) {
            throw new Error(`backup archive: ${name} changed size while packing (${copied} of ${size})`);
        }
    } finally {
        // This also runs when the pipeline is destroyed, and then nothing else would close the file.
        await reader.cancel();
    }
}

export function padding(size: number): Uint8Array {
    return new Uint8Array(padLength(size));
}

// Two zero blocks close a tar, and the whole archive is padded to the blocking factor.
export function* archiveEnd(written: number): Generator<Uint8Array> {
    yield new Uint8Array(BLOCK * 2);
    const tail = (BLOCKING_FACTOR - ((written + BLOCK * 2) % BLOCKING_FACTOR)) % BLOCKING_FACTOR;
    if (tail > 0) yield new Uint8Array(tail);
}

type TarEntry = {
    path: string;
    typeflag: string;
    // Seconds since the epoch.
    mtime: number;
    size: number;
    // Where the body starts in the tar stream. In a plain tar on disk, that is its offset in the file.
    offset: number;
    body: AsyncGenerator<Uint8Array>;
};

// Walks a tar entry by entry and streams each body. The tar can be an artifact's decompressed bytes or a plain
// tar on disk. A consumer may read part of a body or none of it, and the walk skips the rest, so a consumer can
// stop at the entry it came for. When `seek` is given, the walk skips by moving `bytes` forward instead of reading.
export async function* tarEntries(
    bytes: AsyncIterable<Uint8Array>,
    seek?: (count: number) => void,
): AsyncGenerator<TarEntry> {
    const source = bytes[Symbol.asyncIterator]();
    let buffered: Uint8Array = new Uint8Array(0);
    let bodyLeft = 0;
    let position = 0;

    async function fill(): Promise<boolean> {
        const { done, value } = await source.next();
        if (done) return false;
        // The buffer is usually empty here, and then the chunk is used as it is, without a copy.
        buffered = buffered.length === 0 ? value : Buffer.concat([buffered, value]);
        return true;
    }
    async function take(count: number): Promise<Uint8Array | null> {
        while (buffered.length < count) {
            if (await fill()) continue;
            // No bytes at all is the end of the stream. Part of a block is an archive that was cut off.
            if (buffered.length === 0) return null;
            throw new Error('backup archive: the tar ends mid-header');
        }
        const taken = buffered.subarray(0, count);
        buffered = buffered.subarray(count);
        position += count;
        return taken;
    }
    async function skip(count: number): Promise<void> {
        let left = count;
        while (left > 0) {
            if (buffered.length === 0 && seek) {
                seek(left);
                position += left;
                return;
            }
            if (buffered.length === 0 && !(await fill())) throw new Error('backup archive: the tar ends mid-entry');
            const step = Math.min(left, buffered.length);
            buffered = buffered.subarray(step);
            left -= step;
            position += step;
        }
    }
    async function* body(): AsyncGenerator<Uint8Array> {
        while (bodyLeft > 0) {
            if (buffered.length === 0 && !(await fill())) throw new Error('backup archive: the tar ends mid-entry');
            const chunk = buffered.subarray(0, Math.min(bodyLeft, buffered.length));
            buffered = buffered.subarray(chunk.length);
            bodyLeft -= chunk.length;
            position += chunk.length;
            yield chunk;
        }
    }

    let longName: string | null = null;
    try {
        while (true) {
            const header = await take(BLOCK);
            // Two zero blocks close a tar. The first one already comes after every entry, so the walk ends there.
            if (!header || header.every((byte) => byte === 0)) return;
            const size = headerNumber(header, 124, 12);
            const typeflag = headerField(header, 156, 1);
            bodyLeft = size;

            // A name too long for the header comes in a block in front of its entry. That block holds pax
            // records, as headerChunks writes, or GNU's long name. A global pax header ('g') belongs to no
            // single entry, so a path in it must not become the next entry's name.
            if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
                if (size > MAX_LONG_HEADER_BYTES) {
                    throw new Error(`backup archive: refusing a ${size}-byte extended header`);
                }
                const extra = await collect(body());
                if (typeflag === 'x') longName = paxPath(extra);
                if (typeflag === 'L') longName = headerField(extra, 0, extra.length);
                await skip(padLength(size));
                continue;
            }
            // headerChunks never sets the ustar `prefix`, but bsdtar does. The full name is then the two joined.
            const prefix = headerField(header, 345, 155);
            const name = headerField(header, 0, NAME_FIELD);
            const entryPath = checkedEntryPath(longName ?? (prefix === '' ? name : `${prefix}/${name}`));
            longName = null;
            // No archive this server writes holds a link or a device. One could point a restore anywhere.
            if (LINKS_AND_DEVICES.has(typeflag)) {
                throw new Error(`backup archive: refusing tar entry "${entryPath}", a link or a device`);
            }
            if (typeflag === '' || typeflag === FILE_TYPEFLAG || typeflag === DIRECTORY_TYPEFLAG) {
                const mtime = headerNumber(header, 136, 12);
                yield { path: entryPath, typeflag, mtime, size, offset: position, body: body() };
            }
            await skip(bodyLeft + padLength(size));
        }
    } finally {
        await source.return?.();
    }
}

export async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    return Buffer.concat(parts);
}

// A pax extended header record: "{length} {key}={value}\n", where length counts itself.
function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    const bodyLength = ENCODER.encode(body).length;
    let total = bodyLength + 1;
    while (`${total}`.length + bodyLength !== total) total = `${total}`.length + bodyLength;
    return `${total}${body}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= maxBytes) return text;
    // Back off to the start of a character, so the cut never splits one.
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return DECODER.decode(bytes.subarray(0, end));
}

function tarHeader(name: string, size: number, mtime: number, typeflag: string, mode: number): Uint8Array {
    const header = new Uint8Array(BLOCK);
    const put = (offset: number, text: string) => header.set(ENCODER.encode(text), offset);
    put(0, name);
    put(100, octalField(mode, 8));
    put(108, octalField(0, 8));
    put(116, octalField(0, 8));
    writeSize(header, 124, size);
    put(136, octalField(mtime, 12));
    // The checksum is summed while its own field holds spaces.
    header.fill(0x20, 148, 156);
    put(156, typeflag);
    put(257, 'ustar');
    put(263, '00');
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    return header;
}

function octalField(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeSize(header: Uint8Array, offset: number, size: number): void {
    if (size <= MAX_OCTAL_SIZE) {
        header.set(ENCODER.encode(octalField(size, 12)), offset);
        return;
    }
    // GNU base-256: the first byte has its high bit set, and the rest hold the value big-endian. GNU tar,
    // libarchive and headerNumber all read it. It is the only way a header can hold a size above 8 GiB.
    header[offset] = 0x80;
    let rest = size;
    for (let i = offset + 11; i > offset; i--) {
        header[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
}

function padLength(size: number): number {
    return (BLOCK - (size % BLOCK)) % BLOCK;
}

function headerNumber(header: Uint8Array, offset: number, length: number): number {
    if ((header[offset] & 0x80) !== 0) {
        let value = 0;
        for (let i = offset + 1; i < offset + length; i++) value = value * 256 + header[i];
        return value;
    }
    const value = Number.parseInt(headerField(header, offset, length).trim(), 8);
    if (!Number.isFinite(value) || value < 0) throw new Error('backup archive: unreadable tar header field');
    return value;
}

function headerField(header: Uint8Array, offset: number, length: number): string {
    const field = header.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return DECODER.decode(end === -1 ? field : field.subarray(0, end));
}

// A record's length counts bytes, so the records are cut from the bytes, not from a decoded string. A record
// with a non-ASCII path has more bytes than characters.
function paxPath(records: Uint8Array): string | null {
    let offset = 0;
    while (offset < records.length) {
        const space = records.indexOf(0x20, offset);
        if (space < 0) return null;
        const total = Number.parseInt(DECODER.decode(records.subarray(offset, space)), 10);
        if (!Number.isFinite(total) || total <= 0) return null;
        const record = DECODER.decode(records.subarray(space + 1, offset + total - 1));
        const equals = record.indexOf('=');
        if (record.slice(0, equals) === 'path') return record.slice(equals + 1);
        offset += total;
    }
    return null;
}

// An artifact may be a file somebody uploaded, so the paths inside it are untrusted input.
function checkedEntryPath(name: string): string {
    if (name === '' || name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error(`backup archive: refusing tar entry "${name}"`);
    }
    return name;
}
