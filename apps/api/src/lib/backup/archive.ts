// Packs, lists and unpacks Eigen's backup archives. A home archive is one home folder as a tar through zstd,
// so `tar --zstd -xf` unpacks it anywhere. A whole-server archive is a plain tar of members that are compressed
// already, and its manifest is always the last member. An unpack stops at the bound its manifest declares, so an
// archive that holds more cannot write more. The backup, verify and restore code calls it, ./eigen restore included.
// The tar bytes themselves come from headerChunks and tarEntries.

/// <reference path="./node-zstd.d.ts" />
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { formatFileSize } from '@workspace/lib/format';
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

// An archive holds password hashes, keys and every file of a home, so only the API's own user may read it.
// The files inside an archive get the same mode and its folders get ARCHIVE_FOLDER_MODE. A `tar -xf` by hand
// then unpacks them for that user alone too.
export const ARCHIVE_MODE = 0o600;
const ARCHIVE_FOLDER_MODE = 0o700;

// Packs `dir` into a `.tar.zst` with `dir`'s name as its one root folder. The tar is made entry by entry and
// streamed through zstd to disk, so memory use stays flat. The archive is written in the staging folder and then
// renamed into place, so an interrupted pack never leaves a short archive that the list would offer for restore.
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

// Writes a whole-server archive. It is a plain tar because its members are compressed already, and a plain tar
// can be read one member at a time. Each member is hashed while it is copied in. finish() then adds the manifest
// that lists them all, so the manifest is always the last member. The caller writes to a temp name and renames
// the file into place. It calls abort() in a finally, which removes an archive that finish() never closed.
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

// What the disk spends on one entry beyond its bytes, such as a block a small file rounds up to, or a folder's own
// block. A million empty files or folders declare no bytes and still take gigabytes, so every entry is charged it.
export const ENTRY_ALLOWANCE_BYTES = 4096;
// What a restore's room check and its unpack allow beyond what the manifest declares: a tenth more for the empty
// folders a manifest cannot list, such as a Maildir's `new/`, and a fixed reserve, so a small home is not unpacked
// onto the disk's last free bytes.
const UNPACK_SLACK = 1.1;
const UNPACK_RESERVE_BYTES = 64 * 1024 * 1024;

// The text of an archive's manifest.json. The snapshots write it, and declaredUnpackBytes measures it.
export function serializeManifest(manifest: BackupManifest): string {
    return JSON.stringify(manifest, null, 2);
}

// What extractArtifact counts for an archive that holds exactly what its manifest lists: the bytes of every entry and
// of the manifest itself, and an allowance for each of them, for every folder above them and for the root folder.
export function declaredUnpackBytes(manifest: BackupManifest): number {
    const manifestBytes = Buffer.byteLength(serializeManifest(manifest));
    const entries = manifest.entries.length + 1 + countFolders(manifest.entries) + 1;
    return manifest.counts.bytes + manifestBytes + entries * ENTRY_ALLOWANCE_BYTES;
}

// The most an unpack of the archive may write. A restore checks the disk for it first, and every unpack stops there.
export function unpackBound(manifest: BackupManifest): number {
    return Math.ceil(declaredUnpackBytes(manifest) * UNPACK_SLACK) + UNPACK_RESERVE_BYTES;
}

// The folders above the listed files, each once. The archive holds each as an entry of its own.
function countFolders(entries: readonly BackupEntry[]): number {
    const folders = new Set<string>();
    for (const entry of entries) {
        let folder = path.posix.dirname(entry.path);
        while (folder !== '.' && !folders.has(folder)) {
            folders.add(folder);
            folder = path.posix.dirname(folder);
        }
    }
    return folders.size;
}

// An artifact's compressed bytes are a file of their own, or a member read in place from a whole-server archive.
type ArtifactSource = string | ArchiveMemberLocation;

// Unpacks an artifact into `targetDir`. Every folder it makes is 0700 and every file 0600, whatever the header
// says. Only the API's user reads a restored home, so an older archive with 0644 files restores as private as a
// new one. A crafted archive cannot ask for a setuid bit, which root would then move into data/. It cannot ask
// for a folder that its own extract cannot enter either. With `maxBytes`, it refuses an archive whose entries add
// up to more, each with its ENTRY_ALLOWANCE_BYTES, before it writes the entry that would pass it.
export async function extractArtifact(
    source: ArtifactSource,
    targetDir: string,
    maxBytes = Number.POSITIVE_INFINITY,
): Promise<void> {
    const makeFolder = (folder: string) => fs.mkdirSync(folder, { recursive: true, mode: ARCHIVE_FOLDER_MODE });
    const existed = fs.existsSync(targetDir);
    makeFolder(targetDir);
    let bytes = 0;
    try {
        for await (const entry of tarEntries(artifactBytes(source))) {
            const target = path.join(targetDir, entry.path);
            bytes += entry.size + ENTRY_ALLOWANCE_BYTES;
            if (bytes > maxBytes) {
                throw new ApiError(
                    400,
                    `The archive unpacks past ${formatFileSize(maxBytes)}, more than its manifest declares`,
                );
            }
            if (entry.typeflag === DIRECTORY_TYPEFLAG) {
                makeFolder(target);
                continue;
            }
            // A foreign archive may name a file before the directory entry it sits in.
            makeFolder(path.dirname(target));
            await pipeline(Readable.from(entry.body), fs.createWriteStream(target, { mode: ARCHIVE_MODE }));
            // Keep the mtime, as `tar -x` does, because Dovecot dates a Maildir message by its file's mtime.
            await fsp.utimes(target, entry.mtime, entry.mtime);
        }
    } catch (error) {
        // Half an unpacked archive is worse than none, because nothing downstream can tell the two apart.
        // Only a folder this call made is removed. A folder the caller already had is left alone.
        if (!existed) await fsp.rm(targetDir, { recursive: true, force: true });
        throw error;
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
    if (!manifest) {
        const name = typeof source === 'string' ? path.basename(source) : source.name;
        throw new ApiError(400, `${name} is not an Eigen backup archive`);
    }
    return manifest;
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
    const manifestPath = path.join(folder, ARCHIVE_MANIFEST_FILE);
    const manifest = fs.existsSync(manifestPath) ? parseBackupManifest(fs.readFileSync(manifestPath, 'utf8')) : null;
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
    yield* headerChunks(`${rootName}/`, 0, fs.statSync(dir).mtimeMs, DIRECTORY_TYPEFLAG, ARCHIVE_FOLDER_MODE);
    for (const [index, rel] of relPaths.entries()) {
        // Packing takes most of a large home's backup time, so it reports progress for every entry.
        onProgress?.('pack', index + 1, relPaths.length);
        const name = `${rootName}/${rel}`;
        const abs = path.join(dir, rel);
        const stat = fs.statSync(abs);
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
