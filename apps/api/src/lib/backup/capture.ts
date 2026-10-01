import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import { hashFile, isMissingObjectCause, type StorageFile, writeTempWithHash } from '../storage';

// Copy one file into the archive folder and return its manifest entry. The sha256 is taken on the
// bytes as they stream through, so nothing is read a second time to hash it.
export async function captureFile(
    source: Buffer | Uint8Array | StorageFile | ReadableStream<Uint8Array>,
    destPath: string,
    relPath: string,
): Promise<BackupEntry> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const { size, hash } = await writeTempWithHash(destPath, source);
    return { path: relPath, bytes: size, sha256: hash };
}

// captureFile for a live file something may legitimately remove between the listing and the copy:
// one gone by then is left out, with the partial copy, rather than failing the whole snapshot.
export async function captureUnlessGone(
    source: StorageFile,
    destPath: string,
    relPath: string,
): Promise<BackupEntry | null> {
    return captureFile(source, destPath, relPath).catch((error: unknown) => {
        // A local file's ENOENT arrives as the cause of a storage error (consumeStream).
        if (!isMissingObjectCause(error)) throw error;
        fs.rmSync(destPath, { force: true });
        return null;
    });
}

// A manifest's counts: its databases and files are disjoint, so the two add up to its entries.
export function countEntries(entries: BackupEntry[], databases: number): BackupManifest['counts'] {
    return {
        databases,
        files: entries.length - databases,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    };
}

// The entry for a file already sitting in the archive — a VACUUM INTO copy, which SQLite writes
// itself, so hashing it means one read of the copy.
export async function captureWrittenFile(destPath: string, relPath: string): Promise<BackupEntry> {
    const { size, hash } = await hashFile(destPath);
    return { path: relPath, bytes: size, sha256: hash };
}
