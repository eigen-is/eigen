/// <reference path="./node-zstd.d.ts" />
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupManifest, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { parseBackupManifest, parseBackupSidecar } from '@workspace/lib/validation';
import { ApiError } from '../core';
import { ARCHIVE_MANIFEST_FILE, buildHomeFolderName, getBackupTempPath } from './paths';
import type { SnapshotProgress } from './snapshot-home';

// An artifact is a plain POSIX tar (pax for long paths) piped through zstd, so `tar --zstd -xf`
// unpacks one on any machine. The tar is generated entry by entry into the compressor rather than
// built with Bun.Archive.write, which holds the whole archive in memory (measured on Bun 1.3.14: a
// 1.2 GB folder peaked at 3.9 GB RSS, against 0.1 GB for the stream below). Reading is this file's
// own parser for a reason of its own: Bun.Archive (libarchive on Bun 1.3.14) stops at the first
// entry name that is not ASCII, and segfaults on a ustar one, so every home holding an accented
// file name would read back as a folder without a manifest, or take the process down.
const BLOCK = 512;
const NAME_FIELD = 100;
// The biggest size a header's 11 octal digits hold (8 GiB); above it the size goes in base-256.
const MAX_OCTAL_SIZE = 0o77777777777;
// tar's traditional blocking factor. `tar` reads a short archive fine, but every writer pads.
const BLOCKING_FACTOR = 20 * BLOCK;
const SIDECAR_SUFFIX = '.manifest.json';

export function sidecarPath(artifactPath: string): string {
    return `${artifactPath}${SIDECAR_SUFFIX}`;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function octalField(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
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

function truncateUtf8(text: string, maxBytes: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= maxBytes) return text;
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
    header.fill(0x20, 148, 156); // the checksum is summed with its own field blank
    put(156, typeflag);
    put(257, 'ustar');
    put(263, '00');
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    return header;
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

function padding(size: number): Uint8Array {
    return new Uint8Array(padLength(size));
}

// A path over 100 bytes rides in a pax header; the ustar header after it carries the name a reader
// that ignores pax falls back to.
function* headerChunks(
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

async function* entryChunks(name: string, absPath: string, size: number, mtime: number): AsyncGenerator<Uint8Array> {
    yield* headerChunks(name, size, mtime, '0', 0o644);

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
        if (copied !== size) throw new Error(`packFolder: ${name} changed size while packing (${copied} of ${size})`);
    } finally {
        // Reached on a destroyed pipeline too, where nobody else would ever close the file.
        await reader.cancel();
    }
    yield padding(size);
}

async function* tarChunks(dir: string, rootName: string, onProgress?: SnapshotProgress): AsyncGenerator<Uint8Array> {
    const relPaths: string[] = [];
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: false, dot: true })) {
        relPaths.push(rel.replaceAll('\\', '/'));
    }
    relPaths.sort();

    let written = 0;
    // Directories get entries of their own: an empty one (a Maildir `new/`, a container's `versions/`
    // before its first snapshot) is part of the home and has to survive the round trip.
    function* directory(name: string, mtimeMs: number): Generator<Uint8Array> {
        for (const chunk of headerChunks(name, 0, Math.floor(mtimeMs / 1000), '5', 0o755)) {
            written += chunk.length;
            yield chunk;
        }
    }

    yield* directory(`${rootName}/`, fs.statSync(dir).mtimeMs);
    for (const [index, rel] of relPaths.entries()) {
        // Packing dominates a large home's wall clock, so it reports per entry: one `pack` step for
        // the whole folder left the admin pane's bar at 0% for 38 of a 40-second job.
        onProgress?.('pack', index + 1, relPaths.length);
        const abs = path.join(dir, rel);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            yield* directory(`${rootName}/${rel}/`, stat.mtimeMs);
            continue;
        }
        for await (const chunk of entryChunks(`${rootName}/${rel}`, abs, stat.size, Math.floor(stat.mtimeMs / 1000))) {
            if (chunk.length === 0) continue;
            written += chunk.length;
            yield chunk;
        }
    }
    yield new Uint8Array(BLOCK * 2); // end-of-archive marker
    written += BLOCK * 2;
    const tail = (BLOCKING_FACTOR - (written % BLOCKING_FACTOR)) % BLOCKING_FACTOR;
    if (tail > 0) yield new Uint8Array(tail);
}

// Packs `dir` into a `.tar.zst` whose single root folder is `dir`'s basename. Memory stays flat:
// the tar is generated entry by entry into the zstd stream, and the compressed bytes go straight to
// disk. It is built in the staging folder and renamed into place, so an interrupted pack never
// leaves a short archive under a name the artifact list would offer for restore.
export async function packFolder(dir: string, artifactPath: string, onProgress?: SnapshotProgress): Promise<void> {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const tempPath = getBackupTempPath('.tar.zst');
    try {
        const chunks = Readable.from(tarChunks(dir, path.basename(dir), onProgress));
        await pipeline(chunks, createZstdCompress(), fs.createWriteStream(tempPath));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, artifactPath);
}

// The artifact's bytes, decompressed. The two streams are wired by hand rather than through
// `pipeline`, because a read that stops at the entry it wanted ends as an AbortError there.
async function* artifactBytes(artifactPath: string): AsyncGenerator<Uint8Array> {
    const source = fs.createReadStream(artifactPath);
    const decompressed = createZstdDecompress();
    source.on('error', (error) => decompressed.destroy(error));
    source.pipe(decompressed);
    try {
        yield* decompressed;
    } finally {
        source.destroy();
    }
}

type TarEntry = { path: string; typeflag: string; mode: number; size: number; body: AsyncGenerator<Uint8Array> };

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

async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    return Buffer.concat(parts);
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

// The archive entry by entry, bodies streamed. A consumer that reads part of a body or none leaves
// the rest to the loop below, so it can stop at the entry it came for.
async function* tarEntries(artifactPath: string): AsyncGenerator<TarEntry> {
    const source = artifactBytes(artifactPath);
    let buffered = new Uint8Array(0);
    let bodyLeft = 0;

    async function fill(): Promise<boolean> {
        const { done, value } = await source.next();
        if (done) return false;
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
        return taken;
    }
    async function skip(count: number): Promise<void> {
        let left = count;
        while (left > 0) {
            if (buffered.length === 0 && !(await fill())) throw new Error('backup archive: the tar ends mid-entry');
            const step = Math.min(left, buffered.length);
            buffered = buffered.subarray(step);
            left -= step;
        }
    }
    async function* body(): AsyncGenerator<Uint8Array> {
        while (bodyLeft > 0) {
            if (buffered.length === 0 && !(await fill())) throw new Error('backup archive: the tar ends mid-entry');
            const chunk = buffered.subarray(0, Math.min(bodyLeft, buffered.length));
            buffered = buffered.subarray(chunk.length);
            bodyLeft -= chunk.length;
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

            // A name the header cannot hold rides in front of the entry it belongs to: pax records
            // (what the writer above emits) or GNU's long-name block. A global header names nothing,
            // and taking its truncated name for the next entry's would write the wrong path.
            if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
                const extra = await collect(body());
                if (typeflag === 'x') givenName = paxPath(extra);
                if (typeflag === 'L') givenName = headerField(extra, 0, extra.length);
                await skip(padLength(size));
                continue;
            }
            // The writer never sets `prefix`; bsdtar does, and then the name is the two joined.
            const prefix = headerField(header, 345, 155);
            const name = headerField(header, 0, NAME_FIELD);
            const entryPath = checkedEntryPath(givenName ?? (prefix === '' ? name : `${prefix}/${name}`));
            givenName = null;
            // Nothing else (a symlink, a hard link, a device) is something a home folder holds.
            if (typeflag === '' || typeflag === '0' || typeflag === '5') {
                yield { path: entryPath, typeflag, mode: headerNumber(header, 100, 8), size, body: body() };
            }
            await skip(bodyLeft + padLength(size));
        }
    } finally {
        await source.return(undefined);
    }
}

// `glob` is unused today and reserved by the design for phase ③, where one home is extracted out of
// a whole-server archive with a `homes/home-{ownerId}/**` filter.
export async function extractArtifact(artifactPath: string, targetDir: string, glob?: string): Promise<void> {
    const existed = fs.existsSync(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const filter = glob ? new Bun.Glob(glob) : null;
    try {
        for await (const entry of tarEntries(artifactPath)) {
            if (filter && !filter.match(entry.path)) continue;
            const target = path.join(targetDir, entry.path);
            if (entry.typeflag === '5') {
                fs.mkdirSync(target, { recursive: true });
                continue;
            }
            // A foreign archive may name a file before the directory entry it sits in.
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await pipeline(Readable.from(entry.body), fs.createWriteStream(target, { mode: entry.mode }));
        }
    } catch (error) {
        // Half an unpacked archive is worse than none — nothing downstream can tell the two apart.
        // A folder the caller already had is left alone; only the tree this call made is taken back.
        if (!existed) fs.rmSync(targetDir, { recursive: true, force: true });
        throw error;
    }
}

// The manifest of the archive's single home folder, without unpacking its files.
export async function readArtifactManifest(artifactPath: string): Promise<BackupManifest> {
    const filter = new Bun.Glob(`*/${ARCHIVE_MANIFEST_FILE}`);
    let text: string | null = null;
    for await (const entry of tarEntries(artifactPath)) {
        if (!filter.match(entry.path)) continue;
        text = DECODER.decode(await collect(entry.body));
        break;
    }
    const manifest = text === null ? null : parseBackupManifest(text);
    if (!manifest) throw new ApiError(400, `${path.basename(artifactPath)} is not an Eigen backup archive`);
    return manifest;
}

// The home folder inside an unpacked archive, with the manifest that describes it. Both callers
// judge an extract they just made, and both say the same thing about an archive that turns out to
// be another home's or to carry no manifest this build reads.
export function readUnpackedHome(
    unpackDir: string,
    ownerId: string,
    artifactName: string,
): { folder: string; manifest: BackupManifest } {
    const folder = path.join(unpackDir, buildHomeFolderName(ownerId));
    if (!fs.existsSync(folder)) throw new ApiError(400, `${artifactName} is a backup of another home`);
    const manifestPath = path.join(folder, ARCHIVE_MANIFEST_FILE);
    const manifest = fs.existsSync(manifestPath) ? parseBackupManifest(fs.readFileSync(manifestPath, 'utf8')) : null;
    if (!manifest) throw new ApiError(400, `${artifactName} carries no version 1 backup manifest`);
    if (manifest.ownerId !== ownerId) {
        throw new ApiError(400, `${artifactName} is a backup of another home (${manifest.ownerId})`);
    }
    return { folder, manifest };
}

export async function writeSidecar(
    artifactPath: string,
    manifest: BackupManifest,
    verify: BackupVerifyRecord,
): Promise<void> {
    const tempPath = getBackupTempPath(SIDECAR_SUFFIX);
    try {
        await Bun.write(tempPath, JSON.stringify({ manifest, verify }, null, 2));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, sidecarPath(artifactPath));
}

// Null when there is no sidecar at all — an artifact copied in by hand has none, and the caller
// shows it as unverified until a verify job writes one. A file that is there but is not a sidecar
// is an error instead: treating it as absent would hide a half-written one behind a plausible screen.
export async function readSidecar(
    artifactPath: string,
): Promise<{ manifest: BackupManifest; verify: BackupVerifyRecord } | null> {
    const filePath = sidecarPath(artifactPath);
    if (!fs.existsSync(filePath)) return null;
    const sidecar = parseBackupSidecar(await Bun.file(filePath).text());
    if (!sidecar) throw new ApiError(400, `${path.basename(filePath)} is not a backup manifest sidecar`);
    return sidecar;
}
