import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { hashFile, writeTempWithHash } from '../drive/streaming';
import type { StorageFile } from '../storage';

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

// The entry for a file already sitting in the archive — a VACUUM INTO copy, which SQLite writes
// itself, so hashing it means one read of the copy.
export async function captureWrittenFile(destPath: string, relPath: string): Promise<BackupEntry> {
    const { size, hash } = await hashFile(destPath);
    return { path: relPath, bytes: size, sha256: hash };
}
