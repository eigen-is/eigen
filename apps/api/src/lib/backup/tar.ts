// The tar format Eigen's archives are made of, with no file of its own to read or write: the headers and
// padding a writer emits, and a reader that walks any tar entry by entry with each body streamed. Both
// the home archive, a tar through zstd, and the plain tar of a whole-server archive are built on it. It
// does its own tar instead of Bun.Archive, whose writer holds the whole archive in memory and whose reader
// stops at the first non-ASCII name and segfaults on a ustar one.

import * as path from 'node:path';

export const BLOCK = 512;
const NAME_FIELD = 100;
// The biggest size a header's 11 octal digits hold (8 GiB); above it the size goes in base-256.
const MAX_OCTAL_SIZE = 0o77777777777;
// tar's traditional blocking factor. `tar` reads a short archive fine, but every writer pads.
const BLOCKING_FACTOR = 20 * BLOCK;

// One path record fits many times over; the size is the untrusted archive's own word.
const MAX_LONG_HEADER_BYTES = 64 * 1024;

// Hard link, symlink, character and block device, fifo.
const LINKS_AND_DEVICES = new Set(['1', '2', '3', '4', '6']);

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// A path over 100 bytes rides in a pax header; the ustar header after it carries the name a reader
// that ignores pax falls back to.
export function* headerChunks(
    name: string,
    size: number,
    mtime: number,
    typeflag: string,
    mode: number,
): Generator<Uint8Array> {
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
        // The header above already declared `size`; fewer bytes leave the archive unreadable from here on.
        if (copied !== size) {
            throw new Error(`backup archive: ${name} changed size while packing (${copied} of ${size})`);
        }
    } finally {
        // Reached on a destroyed pipeline too, where nobody else would ever close the file.
        await reader.cancel();
    }
}

export function padding(size: number): Uint8Array {
    return new Uint8Array(padLength(size));
}

// Two zero blocks close a tar; the whole is padded to the blocking factor.
export function* archiveEnd(written: number): Generator<Uint8Array> {
    yield new Uint8Array(BLOCK * 2);
    const tail = (BLOCKING_FACTOR - ((written + BLOCK * 2) % BLOCKING_FACTOR)) % BLOCKING_FACTOR;
    if (tail > 0) yield new Uint8Array(tail);
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
    header.fill(0x20, 148, 156); // the checksum is summed with its own field blank
    put(156, typeflag);
    put(257, 'ustar');
    put(263, '00');
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    return header;
}

function writeSize(header: Uint8Array, offset: number, size: number): void {
    if (size <= MAX_OCTAL_SIZE) {
        header.set(ENCODER.encode(octalField(size, 12)), offset);
        return;
    }
    // GNU base-256: high bit on the first byte, big-endian value in the rest. GNU tar, libarchive
    // and headerNumber below all read it, and it is the only shape a header has above 8 GiB.
    header[offset] = 0x80;
    let rest = size;
    for (let i = offset + 11; i > offset; i--) {
        header[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
}

function octalField(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function truncateUtf8(text: string, maxBytes: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return DECODER.decode(bytes.subarray(0, end));
}

// A pax extended header record: "{length} {key}={value}\n", where length counts itself.
function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    const bodyLength = ENCODER.encode(body).length;
    let total = bodyLength + 1;
    while (`${total}`.length + bodyLength !== total) total = `${total}`.length + bodyLength;
    return `${total}${body}`;
}

function padLength(size: number): number {
    return (BLOCK - (size % BLOCK)) % BLOCK;
}

// `offset` is where the body starts in the tar stream: in a plain tar, its offset in the file.
type TarEntry = {
    path: string;
    typeflag: string;
    mode: number;
    // Seconds since the epoch.
    mtime: number;
    size: number;
    offset: number;
    body: AsyncGenerator<Uint8Array>;
};

// A tar entry by entry, bodies streamed: an artifact's decompressed bytes, or a plain tar as it sits
// on disk. A consumer that reads part of a body or none leaves the rest to the loop below, so it can
// stop at the entry it came for. `seek`, when given, moves `bytes` past what is left unread instead.
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
        // Mostly the buffer has drained, and the chunk is taken as it is rather than copied.
        if (buffered.length === 0) {
            buffered = value;
            return true;
        }
        const merged = new Uint8Array(buffered.length + value.length);
        merged.set(buffered);
        merged.set(value, buffered.length);
        buffered = merged;
        return true;
    }
    async function take(count: number): Promise<Uint8Array | null> {
        while (buffered.length < count) {
            if (await fill()) continue;
            // Nothing at all is the end of the stream; a part of a block is a cut-off archive.
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

    let givenName: string | null = null;
    try {
        while (true) {
            const header = await take(BLOCK);
            // Two zero blocks close a tar, and one is already past everything it holds.
            if (!header || header.every((byte) => byte === 0)) return;
            const size = headerNumber(header, 124, 12);
            const typeflag = headerField(header, 156, 1);
            bodyLeft = size;

            // A name the header cannot hold rides in front of the entry it belongs to: pax records,
            // which headerChunks writes, or GNU's long-name block. A global header names nothing,
            // and taking its truncated name for the next entry's would write the wrong path.
            if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
                if (size > MAX_LONG_HEADER_BYTES) {
                    throw new Error(`backup archive: refusing a ${size}-byte extended header`);
                }
                const extra = await collect(body());
                if (typeflag === 'x') givenName = paxPath(extra);
                if (typeflag === 'L') givenName = headerField(extra, 0, extra.length);
                await skip(padLength(size));
                continue;
            }
            // headerChunks never sets `prefix`; bsdtar does, and then the name is the two joined.
            const prefix = headerField(header, 345, 155);
            const name = headerField(header, 0, NAME_FIELD);
            const entryPath = checkedEntryPath(givenName ?? (prefix === '' ? name : `${prefix}/${name}`));
            givenName = null;
            // No archive this server writes holds a link or a device, and one could point a restore anywhere.
            if (LINKS_AND_DEVICES.has(typeflag)) {
                throw new Error(`backup archive: refusing tar entry "${entryPath}", a link or a device`);
            }
            if (typeflag === '' || typeflag === '0' || typeflag === '5') {
                const mode = headerNumber(header, 100, 8);
                const mtime = headerNumber(header, 136, 12);
                yield { path: entryPath, typeflag, mode, mtime, size, offset: position, body: body() };
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

function headerField(header: Uint8Array, offset: number, length: number): string {
    const field = header.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return DECODER.decode(end === -1 ? field : field.subarray(0, end));
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

// A record's length counts bytes, so the records are cut out of the bytes: one holding a non-ASCII
// path is longer than the string it decodes to.
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

// An artifact is a file somebody uploaded, so the paths inside it are untrusted input.
function checkedEntryPath(name: string): string {
    if (name === '' || name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error(`backup archive: refusing tar entry "${name}"`);
    }
    return name;
}
