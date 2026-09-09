/// <reference path="./node-zstd.d.ts" />
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupManifest, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { parseBackupManifest, parseBackupSidecar } from '@workspace/lib/validation';
import { ApiError } from '../core';
import { getBackupTempPath } from './paths';

// An artifact is a plain POSIX tar (pax for long paths) piped through zstd, so `tar --zstd -xf`
// unpacks one on any machine. The tar is generated entry by entry into the compressor rather than
// built with Bun.Archive.write, which holds the whole archive in memory (measured on Bun 1.3.14: a
// 1.2 GB folder peaked at 3.9 GB RSS, against 0.1 GB for the stream below). Reading stays on
// Bun.Archive, which takes bytes and gets a memory-mapped tar.
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

function octalField(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeSize(header: Uint8Array, offset: number, size: number): void {
    if (size <= MAX_OCTAL_SIZE) {
        header.set(ENCODER.encode(octalField(size, 12)), offset);
        return;
    }
    // GNU base-256: high bit on the first byte, big-endian value in the rest. Both GNU tar and
    // libarchive (Bun.Archive) read it, and it is the only shape a header has for a file over 8 GiB.
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
    return new TextDecoder().decode(bytes.subarray(0, end));
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

function padding(size: number): Uint8Array {
    return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
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

async function* tarChunks(dir: string, rootName: string): AsyncGenerator<Uint8Array> {
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
    for (const rel of relPaths) {
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
export async function packFolder(dir: string, artifactPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const tempPath = getBackupTempPath('.tar.zst');
    try {
        const chunks = Readable.from(tarChunks(dir, path.basename(dir)));
        await pipeline(chunks, createZstdCompress(), fs.createWriteStream(tempPath));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, artifactPath);
}

// Bun.Archive reads bytes, not a lazy BunFile (a BunFile input reads as an empty archive), so the
// artifact is decompressed into the staging folder and the tar is mapped: the pages stay
// file-backed instead of landing on the heap.
async function withArchive<T>(artifactPath: string, read: (archive: Bun.Archive) => Promise<T>): Promise<T> {
    const tarPath = getBackupTempPath('.tar');
    try {
        await pipeline(fs.createReadStream(artifactPath), createZstdDecompress(), fs.createWriteStream(tarPath));
        return await read(new Bun.Archive(Bun.mmap(tarPath)));
    } finally {
        fs.rmSync(tarPath, { force: true });
    }
}

export async function extractArtifact(artifactPath: string, targetDir: string, glob?: string): Promise<void> {
    const existed = fs.existsSync(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    try {
        await withArchive(artifactPath, async (archive) => {
            await archive.extract(targetDir, glob ? { glob } : undefined);
        });
    } catch (error) {
        // Half an unpacked archive is worse than none — nothing downstream can tell the two apart.
        // A folder the caller already had is left alone; only the tree this call made is taken back.
        if (!existed) fs.rmSync(targetDir, { recursive: true, force: true });
        throw error;
    }
}

// The manifest of the archive's single home folder, without unpacking its files.
export async function readArtifactManifest(artifactPath: string): Promise<BackupManifest> {
    const text = await withArchive(artifactPath, async (archive) => {
        const [entry] = [...(await archive.files('*/manifest.json')).values()];
        return entry ? await entry.text() : null;
    });
    const manifest = text === null ? null : parseBackupManifest(text);
    if (!manifest) throw new ApiError(400, `${path.basename(artifactPath)} is not an Eigen backup archive`);
    return manifest;
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
