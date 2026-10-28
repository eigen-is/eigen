// Writes and reads Eigen's archive files. A home archive is a tar of one home folder through zstd, so
// `tar --zstd -xf` unpacks one anywhere. A whole-server archive is a plain tar of compressed members with
// its manifest last. This file packs, extracts and lists them and keeps their sidecars, on top of the tar
// format of headerChunks and tarEntries. Backups, verifies and restores go through it, ./eigen restore too.

/// <reference path="./node-zstd.d.ts" />
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import type {
    BackupEntry,
    BackupManifest,
    BackupProgress,
    BackupVerifyRecord,
    ServerArchiveManifest,
} from '@workspace/lib/types/backup';
import { parseBackupManifest, parseBackupSidecar } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';
import { ARCHIVE_MANIFEST_FILE, buildHomeFolderName, getBackupTempPath, sidecarPath } from './paths';
import { archiveEnd, BLOCK, collect, fileChunks, headerChunks, padding, tarEntries } from './tar';

// An archive holds password hashes, keys and every file of a home, so only the API's own user may read it. A
// whole-server archive gives its members this mode too, so `tar -xf` hands them to the user alone.
export const ARCHIVE_MODE = 0o600;

// Packs `dir` into a `.tar.zst` whose single root folder is `dir`'s basename. Memory stays flat:
// the tar is generated entry by entry into the zstd stream, and the compressed bytes go straight to
// disk. It is built in the staging folder and renamed into place, so an interrupted pack never
// leaves a short archive under a name the artifact list would offer for restore.
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

async function* tarChunks(dir: string, rootName: string, onProgress?: BackupProgress): AsyncGenerator<Uint8Array> {
    const relPaths = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: false, dot: true }));
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
        // Packing dominates a large home's wall clock, so it reports per entry.
        onProgress?.('pack', index + 1, relPaths.length);
        const abs = path.join(dir, rel);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            yield* directory(`${rootName}/${rel}/`, stat.mtimeMs);
            continue;
        }
        for await (const chunk of fileEntryChunks(
            `${rootName}/${rel}`,
            abs,
            stat.size,
            Math.floor(stat.mtimeMs / 1000),
        )) {
            if (chunk.length === 0) continue;
            written += chunk.length;
            yield chunk;
        }
    }
    yield* archiveEnd(written);
}

async function* fileEntryChunks(
    name: string,
    absPath: string,
    size: number,
    mtime: number,
): AsyncGenerator<Uint8Array> {
    yield* headerChunks(name, size, mtime, '0', 0o644);
    yield* fileChunks(name, absPath, size);
    yield padding(size);
}

export type ServerArchiveWriter = {
    appendFile(name: string, sourcePath: string): Promise<void>;
    finish(manifest: Omit<ServerArchiveManifest, 'entries'>): Promise<ServerArchiveManifest>;
    abort(): Promise<void>;
};

// A whole-server archive is a plain tar: its members are compressed already, and a plain tar can be
// read member by member. Each member is hashed as it is copied in, and finish() closes the archive
// with manifest.json listing them all, so the manifest is always the last member. The file is
// written where the caller says; the caller writes to a temp name and renames it into place, and
// calls abort() in a finally, which takes back an archive finish() never closed.
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
            for (const chunk of headerChunks(name, size, Math.floor(mtimeMs / 1000), '0', ARCHIVE_MODE)) {
                await put(chunk);
            }
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
            const mtime = Math.floor(Date.now() / 1000);
            for (const chunk of headerChunks(ARCHIVE_MANIFEST_FILE, body.length, mtime, '0', ARCHIVE_MODE)) {
                await put(chunk);
            }
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

// One member of a whole-server archive: where its bytes sit in the outer tar, and their sha256 once read through.
export type ArchiveMemberAt = { archivePath: string; name: string; offset: number; bytes: number };
export type ArchiveMember = ArchiveMemberAt & { sha256: string };

// Where an artifact's compressed bytes are read from: a file of its own, or a member of a
// whole-server archive, read in place.
type ArtifactSource = string | ArchiveMemberAt;

// The artifact's bytes, decompressed. The two streams are wired by hand rather than through
// `pipeline`, because a read that stops at the entry it wanted ends as an AbortError there.
async function* artifactBytes(source: ArtifactSource): AsyncGenerator<Uint8Array> {
    const file =
        typeof source === 'string'
            ? fs.createReadStream(source)
            : fs.createReadStream(source.archivePath, { start: source.offset, end: source.offset + source.bytes - 1 });
    const decompressed = createZstdDecompress();
    file.on('error', (error) => decompressed.destroy(error));
    file.pipe(decompressed);
    try {
        yield* decompressed;
    } finally {
        file.destroy();
    }
}

// Every file member of a whole-server archive in order, each hashed as it streams past: one read
// says what the archive holds, where each member sits, and whether its bytes are the ones named.
export async function hashArchiveMembers(archivePath: string): Promise<ArchiveMember[]> {
    const members: ArchiveMember[] = [];
    for await (const entry of tarEntries(fs.createReadStream(archivePath))) {
        if (entry.typeflag === '5') continue;
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

// Every file member of a whole-server archive in order, from the headers alone: a body is seeked past, not read.
export async function listArchiveMembers(archivePath: string): Promise<ArchiveMemberAt[]> {
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
        const members: ArchiveMemberAt[] = [];
        for await (const entry of tarEntries(blocks(), seek)) {
            if (entry.typeflag === '5') continue;
            members.push({ archivePath, name: entry.path, offset: entry.offset, bytes: entry.size });
        }
        return members;
    } finally {
        await handle.close();
    }
}

// What readArchiveMember holds in memory at most: a manifest fits many times over, a home does not.
const MAX_MEMBER_READ_BYTES = 16 * 1024 * 1024;

// A member's bytes in memory, for the manifest and .env.production. A member that has to land on disk goes through
// copyArchiveMember, and a home member is unpacked in place by extractArtifact.
export async function readArchiveMember(member: ArchiveMemberAt): Promise<Uint8Array> {
    if (member.bytes > MAX_MEMBER_READ_BYTES) {
        throw new Error(`backup archive: ${member.name} is ${member.bytes} bytes, too big to read into memory`);
    }
    return Bun.file(member.archivePath)
        .slice(member.offset, member.offset + member.bytes)
        .bytes();
}

// Not Bun.write(dest, a sliced BunFile): Bun 1.4.2 ignores the slice there and writes the whole archive.
export async function copyArchiveMember(member: ArchiveMemberAt, destPath: string): Promise<void> {
    // A read stream refuses an `end` before its `start`, which is what an empty member's range is.
    if (member.bytes === 0) {
        fs.writeFileSync(destPath, '');
        return;
    }
    try {
        await pipeline(
            fs.createReadStream(member.archivePath, { start: member.offset, end: member.offset + member.bytes - 1 }),
            fs.createWriteStream(destPath),
        );
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

// No setuid, setgid or sticky bit: root swaps what a restore unpacked into data/.
const PERMISSION_BITS = 0o777;

export async function extractArtifact(source: ArtifactSource, targetDir: string): Promise<void> {
    const existed = fs.existsSync(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    try {
        for await (const entry of tarEntries(artifactBytes(source))) {
            const target = path.join(targetDir, entry.path);
            if (entry.typeflag === '5') {
                fs.mkdirSync(target, { recursive: true });
                continue;
            }
            // A foreign archive may name a file before the directory entry it sits in.
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await pipeline(
                Readable.from(entry.body),
                fs.createWriteStream(target, { mode: entry.mode & PERMISSION_BITS }),
            );
            // As `tar -x` does: Dovecot dates a Maildir message by its file's mtime.
            await fsp.utimes(target, entry.mtime, entry.mtime);
        }
    } catch (error) {
        // Half an unpacked archive is worse than none, because nothing downstream can tell the two apart.
        // A folder the caller already had is left alone; only the tree this call made is taken back.
        if (!existed) await fsp.rm(targetDir, { recursive: true, force: true });
        throw error;
    }
}

// The manifest of the archive's single home folder, without unpacking its files.
export async function readArtifactManifest(artifactPath: string): Promise<BackupManifest> {
    const filter = new Bun.Glob(`*/${ARCHIVE_MANIFEST_FILE}`);
    let text: string | null = null;
    for await (const entry of tarEntries(artifactBytes(artifactPath))) {
        if (!filter.match(entry.path)) continue;
        text = new TextDecoder().decode(await collect(entry.body));
        break;
    }
    const manifest = text === null ? null : parseBackupManifest(text);
    if (!manifest) throw new ApiError(400, `${path.basename(artifactPath)} is not an Eigen backup archive`);
    return manifest;
}

// The home folder inside an unpacked archive, with the manifest that describes it. Every caller judges
// an extract it just made, and says the same thing about an archive that turns out to be another
// home's or to carry no manifest this build reads.
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

// A sidecar is written in the staging folder and renamed into place, so a reader never sees half of one.
// The JSON is indented by two spaces: ./eigen finds a server sidecar's top-level "state" line by that indent.
export async function writeRecord(target: string, value: unknown): Promise<void> {
    const tempPath = getBackupTempPath('.json');
    try {
        await Bun.write(tempPath, JSON.stringify(value, null, 2));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, target);
}

export async function writeSidecar(
    artifactPath: string,
    manifest: BackupManifest,
    verify: BackupVerifyRecord,
): Promise<void> {
    await writeRecord(sidecarPath(artifactPath), { manifest, verify });
}

// Null when there is no sidecar or it does not read. An artifact copied in by hand has none, and the list shows
// it as unverified until a verify job writes one.
export async function readSidecar(
    artifactPath: string,
): Promise<{ manifest: BackupManifest; verify: BackupVerifyRecord } | null> {
    const text = await Bun.file(sidecarPath(artifactPath))
        .text()
        .catch(() => null);
    return text === null ? null : parseBackupSidecar(text);
}
