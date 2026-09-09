import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { writeTempWithHash } from '../drive/streaming';
import { isSqliteFile } from '../mount/helpers';
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

// A WAL-mode database cannot be opened at all — not even read-only — without the `-wal` beside it,
// and an archive carries main files only: the journals belong to the running server. Rewrite the
// copy's journal mode so every database in the archive stands alone. The copied bytes are already
// whole (ManagedDatabase.close checkpoints TRUNCATE, and a db with a live handle is captured with
// VACUUM INTO instead of read as a file), and a WAL db copied without its -wal was equally
// truncated before this ran — this only makes the result readable.
export function normalizeArchiveDatabase(destPath: string): void {
    if (!isSqliteFile(destPath)) return;
    const db = new Database(destPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA journal_mode = DELETE');
    } finally {
        db.close();
    }
    fs.rmSync(`${destPath}-wal`, { force: true });
    fs.rmSync(`${destPath}-shm`, { force: true });
}

// The entry for a file already sitting in the archive — a VACUUM INTO copy, which SQLite writes
// itself, so hashing it means one read of the copy.
export async function captureWrittenFile(destPath: string, relPath: string): Promise<BackupEntry> {
    const hasher = new Bun.CryptoHasher('sha256');
    const reader = Bun.file(destPath).stream().getReader();
    let bytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        bytes += value.byteLength;
    }
    return { path: relPath, bytes, sha256: hasher.digest('hex') };
}
