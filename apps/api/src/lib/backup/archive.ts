import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupManifest, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { ApiError } from '../core';

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

function tarHeader(name: string, size: number, mtime: number, typeflag: string): Uint8Array {
    const header = new Uint8Array(BLOCK);
    const put = (offset: number, text: string) => header.set(ENCODER.encode(text), offset);
    put(0, name);
    put(100, octalField(0o644, 8));
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

async function* entryChunks(name: string, absPath: string, size: number, mtime: number): AsyncGenerator<Uint8Array> {
    if (ENCODER.encode(name).length > NAME_FIELD) {
        // A path over 100 bytes rides in a pax header; the ustar name below is what a reader that
        // ignores pax would fall back to.
        const payload = ENCODER.encode(paxRecord('path', name));
        yield tarHeader(`PaxHeader/${truncateUtf8(path.basename(name), 80)}`, payload.length, mtime, 'x');
        yield payload;
        yield padding(payload.length);
    }
    yield tarHeader(truncateUtf8(name, NAME_FIELD), size, mtime, '0');

    const reader = Bun.file(absPath).stream().getReader();
    let copied = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        copied += value.length;
        yield value;
    }
    // The header above already declared `size`; fewer bytes leave the archive unreadable from here on.
    if (copied !== size) throw new Error(`packFolder: ${name} changed size while packing (${copied} of ${size})`);
    yield padding(size);
}

async function* tarChunks(dir: string, rootName: string): AsyncGenerator<Uint8Array> {
    const relPaths: string[] = [];
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true, dot: true })) {
        relPaths.push(rel.replaceAll('\\', '/'));
    }
    relPaths.sort();

    let written = 0;
    for (const rel of relPaths) {
        const abs = path.join(dir, rel);
        const stat = fs.statSync(abs);
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
// disk. The temp name is next to the artifact so the rename is atomic — an interrupted pack never
// leaves a short archive under a name the artifact list would offer for restore.
export async function packFolder(dir: string, artifactPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const tempPath = `${artifactPath}.${randomUUID()}.part`;
    try {
        const chunks = Readable.from(tarChunks(dir, path.basename(dir)));
        await pipeline(chunks, createZstdCompress(), fs.createWriteStream(tempPath));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, artifactPath);
}

async function decompressToTar(artifactPath: string, tarPath: string): Promise<void> {
    await pipeline(fs.createReadStream(artifactPath), createZstdDecompress(), fs.createWriteStream(tarPath));
}

// Bun.Archive reads bytes, not a lazy BunFile (a BunFile input reads as an empty archive), so the
// tar is mapped rather than read: the pages stay file-backed instead of landing on the heap.
function openTar(tarPath: string): Bun.Archive {
    return new Bun.Archive(Bun.mmap(tarPath));
}

export async function extractArtifact(artifactPath: string, targetDir: string, glob?: string): Promise<void> {
    fs.mkdirSync(targetDir, { recursive: true });
    const tarPath = path.join(path.dirname(targetDir), `.${randomUUID()}.tar`);
    try {
        await decompressToTar(artifactPath, tarPath);
        await openTar(tarPath).extract(targetDir, glob ? { glob } : undefined);
    } finally {
        fs.rmSync(tarPath, { force: true });
    }
}

// The manifest of the archive's single home folder, without unpacking its files.
export async function readArtifactManifest(artifactPath: string): Promise<BackupManifest> {
    const tarPath = path.join(path.dirname(artifactPath), `.${randomUUID()}.tar`);
    try {
        await decompressToTar(artifactPath, tarPath);
        const [entry] = [...(await openTar(tarPath).files('*/manifest.json')).values()];
        if (!entry) throw new ApiError(422, `${path.basename(artifactPath)} has no manifest.json`);
        return JSON.parse(await entry.text());
    } finally {
        fs.rmSync(tarPath, { force: true });
    }
}

export async function writeSidecar(
    artifactPath: string,
    manifest: BackupManifest,
    verify: BackupVerifyRecord,
): Promise<void> {
    const sidecarPath = `${artifactPath}${SIDECAR_SUFFIX}`;
    const tempPath = `${sidecarPath}.${randomUUID()}.tmp`;
    try {
        await Bun.write(tempPath, JSON.stringify({ manifest, verify }, null, 2));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, sidecarPath);
}

// Null when there is no readable sidecar — an artifact copied in by hand has none, and the caller
// shows it as unverified until a verify job writes one.
export async function readSidecar(
    artifactPath: string,
): Promise<{ manifest: BackupManifest; verify: BackupVerifyRecord } | null> {
    const sidecarPath = `${artifactPath}${SIDECAR_SUFFIX}`;
    if (!fs.existsSync(sidecarPath)) return null;
    try {
        const parsed = await Bun.file(sidecarPath).json();
        if (parsed?.manifest?.formatVersion !== 1 || !parsed?.verify?.status) return null;
        return { manifest: parsed.manifest, verify: parsed.verify };
    } catch {
        return null;
    }
}
