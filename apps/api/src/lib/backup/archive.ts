// Packs, lists and unpacks Eigen's backup archives. A home archive is one home folder as a tar through zstd,
// so `tar --zstd -xf` unpacks it anywhere. A whole-server archive is a plain tar of members that are compressed
// already, and its manifest is always the last member. The backup, verify and restore code calls it, ./eigen restore
// included. The tar bytes themselves come from headerChunks and tarEntries.

/// <reference path="./node-zstd.d.ts" />
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupEntry, BackupManifest, BackupProgress, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { parseBackupManifest } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';
import { ARCHIVE_MANIFEST_FILE, buildHomeFolderName, getBackupTempPath } from './paths';
import {
    archiveEnd,
    BLOCK,
    collect,
    DIRECTORY_TYPEFLAG,
    FILE_TYPEFLAG,
    fileChunks,
    headerChunks,
    padding,
    tarEntries,
} from './tar';

// Only the API's own user may read an archive, since it holds password hashes and keys. Files inside get the same mode.
export const ARCHIVE_MODE = 0o600;
export const ARCHIVE_FOLDER_MODE = 0o700;

// Entry by entry through zstd keeps memory flat. It is written in staging and renamed into place, so an interrupted
// pack never leaves a short archive that the list would offer for restore.
export async function packFolder(dir: string, artifactPath: string, onProgress?: BackupProgress): Promise<void> {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const tempPath = getBackupTempPath('.tar.zst');
    try {
        const chunks = Readable.from(tarChunks(dir, path.basename(dir), onProgress));
        await pipeline(chunks, createZstdCompress(), fs.createWriteStream(tempPath, { mode: ARCHIVE_MODE }));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, artifactPath);
}

export type ServerArchiveWriter = {
    appendFile(name: string, sourcePath: string): Promise<void>;
    finish(fields: Omit<ServerArchiveManifest, 'entries'>): Promise<ServerArchiveManifest>;
    abort(): Promise<void>;
};

// A plain tar, since its members are compressed already and can be read one at a time. finish() writes the manifest
// last. The caller runs abort() in a finally, which removes an archive finish() never closed.
export async function createServerArchiveWriter(archivePath: string): Promise<ServerArchiveWriter> {
    const handle = await fsp.open(archivePath, 'w', ARCHIVE_MODE);
    const entries: BackupEntry[] = [];
    let written = 0;
    let closed = false;
    async function put(chunk: Uint8Array): Promise<void> {
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
        written += chunk.length;
    }
    return {
        async appendFile(name, sourcePath) {
            const { size, mtimeMs } = fs.statSync(sourcePath);
            for (const chunk of headerChunks(name, size, mtimeMs, FILE_TYPEFLAG, ARCHIVE_MODE)) await put(chunk);
            const hasher = new Bun.CryptoHasher('sha256');
            for await (const chunk of fileChunks(name, sourcePath, size)) {
                hasher.update(chunk);
                await put(chunk);
            }
            await put(padding(size));
            entries.push({ path: name, bytes: size, sha256: hasher.digest('hex') });
        },
        async finish(fields) {
            const manifest: ServerArchiveManifest = { ...fields, entries };
            const body = Buffer.from(JSON.stringify(manifest, null, 2));
            const header = headerChunks(ARCHIVE_MANIFEST_FILE, body.length, Date.now(), FILE_TYPEFLAG, ARCHIVE_MODE);
            for (const chunk of header) await put(chunk);
            await put(body);
            await put(padding(body.length));
            for (const chunk of archiveEnd(written)) await put(chunk);
            closed = true;
            await handle.close();
            return manifest;
        },
        async abort() {
            if (closed) return;
            closed = true;
            await handle.close();
            fs.rmSync(archivePath, { force: true });
        },
    };
}

// Where one member's bytes sit inside a whole-server archive. HashedArchiveMember adds their sha256 once read.
export type ArchiveMemberLocation = { archivePath: string; name: string; offset: number; bytes: number };
export type HashedArchiveMember = ArchiveMemberLocation & { sha256: string };

// Every file member of a whole-server archive in order, each hashed as it streams past. One read tells what
// the archive holds, where each member sits and what its bytes hash to.
export async function hashArchiveMembers(archivePath: string): Promise<HashedArchiveMember[]> {
    const members: HashedArchiveMember[] = [];
    for await (const entry of tarEntries(fs.createReadStream(archivePath))) {
        if (entry.typeflag === DIRECTORY_TYPEFLAG) continue;
        const hasher = new Bun.CryptoHasher('sha256');
        for await (const chunk of entry.body) hasher.update(chunk);
        members.push({
            archivePath,
            name: entry.path,
            offset: entry.offset,
            bytes: entry.size,
            sha256: hasher.digest('hex'),
        });
    }
    return members;
}

// The same members without their hashes, from the headers alone. It seeks past each body instead of reading it.
export async function listArchiveMembers(archivePath: string): Promise<ArchiveMemberLocation[]> {
    const handle = await fsp.open(archivePath, 'r');
    try {
        const { size } = await handle.stat();
        let at = 0;
        async function* blocks(): AsyncGenerator<Uint8Array> {
            while (at < size) {
                const { bytesRead, buffer } = await handle.read(new Uint8Array(BLOCK), 0, BLOCK, at);
                if (bytesRead === 0) return;
                at += bytesRead;
                yield buffer.subarray(0, bytesRead);
            }
        }
        const seek = (count: number) => {
            if (at + count > size) throw new Error('backup archive: the tar ends mid-entry');
            at += count;
        };
        const members: ArchiveMemberLocation[] = [];
        for await (const entry of tarEntries(blocks(), seek)) {
            if (entry.typeflag === DIRECTORY_TYPEFLAG) continue;
            members.push({ archivePath, name: entry.path, offset: entry.offset, bytes: entry.size });
        }
        return members;
    } finally {
        await handle.close();
    }
}

// The most readArchiveMember holds in memory. A manifest fits many times over, but a home member does not.
const MAX_MEMBER_READ_BYTES = 16 * 1024 * 1024;

// A small member's bytes in memory, such as the manifest. A member that has to land on disk goes through
// copyArchiveMember, and extractArtifact unpacks a home member in place.
export async function readArchiveMember(member: ArchiveMemberLocation): Promise<Uint8Array> {
    if (member.bytes > MAX_MEMBER_READ_BYTES) {
        throw new Error(`backup archive: ${member.name} is ${member.bytes} bytes, too big to read into memory`);
    }
    return Bun.file(member.archivePath)
        .slice(member.offset, member.offset + member.bytes)
        .bytes();
}

// This streams the byte range rather than passing a sliced BunFile to Bun.write. Bun ignores the slice there and
// writes the whole archive, still in Bun 1.4.4.
export async function copyArchiveMember(member: ArchiveMemberLocation, destPath: string): Promise<void> {
    // A read stream refuses an `end` before its `start`, and an empty member's range is exactly that.
    if (member.bytes === 0) {
        fs.writeFileSync(destPath, '');
        return;
    }
    try {
        await pipeline(memberStream(member), fs.createWriteStream(destPath));
        // A range past the end of the file reads short without an error.
        const { size } = fs.statSync(destPath);
        if (size !== member.bytes) {
            throw new Error(`backup archive: ${member.name} copied ${size} of its ${member.bytes} bytes`);
        }
    } catch (error) {
        fs.rmSync(destPath, { force: true });
        throw error;
    }
}

// What an unpack asks the disk for beyond the bytes a manifest counts: a tenth more for what the disk spends on files
// and folders, and a fixed reserve, so a small home is not unpacked onto the disk's last free bytes.
const UNPACK_SLACK = 1.1;
const UNPACK_RESERVE_BYTES = 64 * 1024 * 1024;

// A whole-server stage adds them once over all its members.
export function withUnpackSlack(bytes: number): number {
    return Math.ceil(bytes * UNPACK_SLACK) + UNPACK_RESERVE_BYTES;
}

// An artifact's compressed bytes are a file of their own, or a member read in place from a whole-server archive.
type ArtifactSource = string | ArchiveMemberLocation;

// Folders are 0700 and files 0600 whatever the header says, so an archive packed elsewhere restores as private as ours
// and no entry can carry a setuid bit.
export async function extractArtifact(source: ArtifactSource, targetDir: string): Promise<void> {
    fs.mkdirSync(targetDir, { recursive: true, mode: ARCHIVE_FOLDER_MODE });
    for await (const entry of tarEntries(artifactBytes(source))) {
        const target = path.join(targetDir, entry.path);
        if (entry.typeflag === DIRECTORY_TYPEFLAG) {
            fs.mkdirSync(target, { mode: ARCHIVE_FOLDER_MODE });
            continue;
        }
        await pipeline(Readable.from(entry.body), fs.createWriteStream(target, { mode: ARCHIVE_MODE }));
        // Keep the mtime, as `tar -x` does, because Dovecot dates a Maildir message by its file's mtime.
        await fsp.utimes(target, entry.mtime, entry.mtime);
    }
}

// The manifest of the archive's single folder, without unpacking its files.
export async function readArtifactManifest(source: ArtifactSource): Promise<BackupManifest> {
    const manifestGlob = new Bun.Glob(`*/${ARCHIVE_MANIFEST_FILE}`);
    let manifest: BackupManifest | null = null;
    for await (const entry of tarEntries(artifactBytes(source))) {
        if (!manifestGlob.match(entry.path)) continue;
        manifest = parseBackupManifest(new TextDecoder().decode(await collect(entry.body)));
        break;
    }
    if (manifest) return manifest;
    const name = typeof source === 'string' ? path.basename(source) : source.name;
    throw new ApiError(400, `${name} is not an Eigen backup archive`);
}

// The manifest of an unpacked or staged folder, or null when it has none this build can read.
export function readManifestFile(folder: string): BackupManifest | null {
    const manifestPath = path.join(folder, ARCHIVE_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) return null;
    return parseBackupManifest(fs.readFileSync(manifestPath, 'utf8'));
}

// The home folder inside an unpacked archive, with the manifest that describes it. Every caller gets the same
// error when the archive is another home's, or has no manifest this build can read.
export function readUnpackedHome(
    unpackDir: string,
    ownerId: string,
    artifactName: string,
): { folder: string; manifest: BackupManifest } {
    const folder = path.join(unpackDir, buildHomeFolderName(ownerId));
    if (!fs.existsSync(folder)) throw new ApiError(400, `${artifactName} is a backup of another home`);
    const manifest = readManifestFile(folder);
    if (!manifest) throw new ApiError(400, `${artifactName} carries no version 1 backup manifest`);
    if (manifest.ownerId !== ownerId) {
        throw new ApiError(400, `${artifactName} is a backup of another home (${manifest.ownerId})`);
    }
    return { folder, manifest };
}

async function* tarChunks(dir: string, rootName: string, onProgress?: BackupProgress): AsyncGenerator<Uint8Array> {
    let written = 0;
    for await (const chunk of entryChunks(dir, rootName, onProgress)) {
        if (chunk.length === 0) continue;
        written += chunk.length;
        yield chunk;
    }
    yield* archiveEnd(written);
}

async function* entryChunks(dir: string, rootName: string, onProgress?: BackupProgress): AsyncGenerator<Uint8Array> {
    const relPaths = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: false, dot: true }));
    relPaths.sort();
    // Directories get entries of their own. An empty one, such as a Maildir `new/`, is part of the home and has to
    // survive the round trip.
    yield* headerChunks(`${rootName}/`, 0, (await fsp.stat(dir)).mtimeMs, DIRECTORY_TYPEFLAG, ARCHIVE_FOLDER_MODE);
    for (const [index, rel] of relPaths.entries()) {
        // Packing takes most of a large home's backup time, so it reports progress for every entry.
        onProgress?.('pack', index + 1, relPaths.length);
        const name = `${rootName}/${rel}`;
        const abs = path.join(dir, rel);
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) {
            yield* headerChunks(`${name}/`, 0, stat.mtimeMs, DIRECTORY_TYPEFLAG, ARCHIVE_FOLDER_MODE);
            continue;
        }
        yield* headerChunks(name, stat.size, stat.mtimeMs, FILE_TYPEFLAG, ARCHIVE_MODE);
        yield* fileChunks(name, abs, stat.size);
        yield padding(stat.size);
    }
}

// The artifact's bytes, decompressed. The two streams are piped by hand rather than through `pipeline`. A reader
// may stop at the entry it wanted, and `pipeline` would then fail with an AbortError.
async function* artifactBytes(source: ArtifactSource): AsyncGenerator<Uint8Array> {
    const file = typeof source === 'string' ? fs.createReadStream(source) : memberStream(source);
    const decompressed = createZstdDecompress();
    file.on('error', (error) => decompressed.destroy(error));
    file.pipe(decompressed);
    try {
        yield* decompressed;
    } finally {
        file.destroy();
    }
}

function memberStream(member: ArchiveMemberLocation): fs.ReadStream {
    return fs.createReadStream(member.archivePath, { start: member.offset, end: member.offset + member.bytes - 1 });
}
