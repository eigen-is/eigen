// Checks that an unpacked backup can be restored before anyone relies on it. It compares the folder's sizes and hashes
// with its manifest, asks SQLite about every database and reads its schema stamp, and decodes a sample of the
// documents. The result is a record of failures, which a restore refuses on and the backup pane shows. A backup job runs
// it on its staging folder, and a restore on the archive it just unpacked.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupEntry, BackupProgress, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { isCollabType } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { PATHS, SERVER_DATABASES } from '../config/paths';
import { ApiError } from '../core/errors';
import type { DatabaseConfig, SchemaType } from '../core/managed-database';
import { eventLoopTurn } from '../core/stream';
import { MOUNT_DB_CONFIG } from '../mount/db-config';
import { hashFile } from '../storage/deadline';
import { readManifestFile } from './archive';
import {
    archivePaths,
    HOME_DATABASES,
    listManagedDatabases,
    managedDbContainer,
    readMountPathRows,
} from './archive-layout';
import { describeError } from './errors';
import { DATABASES_PER_YIELD, newerSchema } from './materialize-mount';
import { ARCHIVE_HOME_DIR, ARCHIVE_MANIFEST_FILE, archiveHomePath, archiveMountPath, archiveServerPath } from './paths';

// Stage 3 samples rather than decodes everything: the ten heaviest documents plus ten of the rest.
const SAMPLE_LARGEST = 10;
const SAMPLE_REST = 10;
// A wrecked archive can fail on every entry. The record is a sidecar and an SSE payload, not a log, so it keeps this
// many lines.
const MAX_LINES = 100;
// How many failures a one-line message quotes. The record carries the whole list.
const FAILURES_IN_MESSAGE = 3;

export function describeFailures(verify: Pick<BackupVerifyRecord, 'failures'>): string {
    return verify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ');
}

// The refusal of what does not verify, `name` being what was judged.
export function requireVerified(verified: BackupVerifyRecord, name: string): void {
    if (verified.status === 'verified') return;
    throw new ApiError(400, `${name} did not verify: ${describeFailures(verified)}`);
}

// `isYjsDocument` marks the data.db of a collab container, the only kind stage 3 can decode. A server database has no
// `config`: the stage refuses an archive of a newer Eigen as a whole.
type ArchiveDatabase = { path: string; isYjsDocument: boolean; config?: DatabaseConfig<SchemaType> };

// Three stages: transport (files match the manifest), structure (databases are sound), content (a sample of collab
// documents decodes). Databases open read-only: a verify never changes a byte.
export async function verifyFolder(dir: string, onProgress?: BackupProgress): Promise<BackupVerifyRecord> {
    const checkedAt = new Date();
    const manifest = readManifestFile(dir);
    if (!manifest) {
        return {
            status: 'failed',
            checkedAt,
            failures: [`${ARCHIVE_MANIFEST_FILE} is missing or not a version 1 backup manifest`],
        };
    }
    const failures = cappedFailures();
    const fail = failures.add;

    // Stage 1, transport: the manifest and the folder describe the same set of bytes.
    const present = new Set<string>();
    await listFolderFiles(dir, '', present);
    present.delete(ARCHIVE_MANIFEST_FILE);
    for (const [index, entry] of manifest.entries.entries()) {
        if (!present.delete(entry.path)) {
            fail(`${entry.path}: missing from the folder`);
        } else {
            const { size, hash } = await hashFile(path.join(dir, entry.path));
            const mismatch = entryMismatch(entry, size, hash);
            if (mismatch) fail(mismatch);
        }
        onProgress?.('verify files', index + 1, manifest.entries.length);
    }
    for (const extra of present) fail(`${extra}: not in the manifest`);

    // Stage 2, structure: SQLite's own verdict on every database the archive owns. A file already
    // reported missing by stage 1 is skipped rather than reported twice.
    const databases = listArchiveDatabases(dir, new Map(manifest.entries.map((entry) => [entry.path, entry])), fail);
    for (const [index, database] of databases.entries()) {
        // Each check blocks the thread, and a restore runs this in the API.
        if (index > 0 && index % DATABASES_PER_YIELD === 0) await eventLoopTurn();
        const abs = path.join(dir, database.path);
        if (fs.existsSync(abs)) {
            try {
                const db = new Database(abs, { readonly: true });
                try {
                    const row = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
                    if (row?.quick_check !== 'ok') {
                        fail(`${database.path}: quick_check says ${row?.quick_check ?? 'nothing'}`);
                    }
                    const newer = database.config && newerSchema(db, database.config);
                    if (newer) fail(`${database.path}: ${newer}`);
                } finally {
                    db.close();
                }
            } catch (error) {
                // SQLite raises on a badly broken file rather than returning a quick_check row; both
                // answers mean the same thing here.
                fail(`${database.path}: quick_check could not complete (${describeError(error)})`);
            }
        }
        onProgress?.('verify databases', index + 1, databases.length);
    }

    // Stage 3, content: the bytes are a document, not just a well-formed database. The sample is
    // deterministic, largest first and then by hashed path, so two verifies of a folder agree.
    const collab = databases.flatMap((database) => {
        const abs = path.join(dir, database.path);
        if (!database.isYjsDocument || !fs.existsSync(abs)) return [];
        const order = new Bun.CryptoHasher('sha256').update(database.path).digest('hex');
        return [{ path: database.path, abs, bytes: fs.statSync(abs).size, order }];
    });
    collab.sort((a, b) => b.bytes - a.bytes);
    const rest = collab.slice(SAMPLE_LARGEST).sort((a, b) => a.order.localeCompare(b.order));
    const targets = [...collab.slice(0, SAMPLE_LARGEST), ...rest.slice(0, SAMPLE_REST)];
    for (const [index, target] of targets.entries()) {
        try {
            // A document nobody has typed in holds no blobs, and its backup must not fail. With blobs, each must decode
            // into a document with shared types; what is in them is not verify's business.
            if (countYjsBlobs(target.abs) > 0) {
                const doc = new Y.Doc();
                Y.applyUpdate(doc, readYjsStateFromFile(target.abs, { readonly: true }));
                if (doc.share.size === 0) fail(`${target.path}: its Yjs blobs decode to an empty document`);
            }
        } catch (error) {
            fail(`${target.path}: the Yjs state could not be read (${describeError(error)})`);
        }
        onProgress?.('verify documents', index + 1, targets.length);
    }

    const failed = failures.lines();
    return { status: failed.length === 0 ? 'verified' : 'failed', checkedAt, failures: failed };
}

// How a file differs from its manifest entry, or null. A null sha256 checks the size alone, for a reader that has
// not read the bytes yet.
export function entryMismatch(entry: BackupEntry, bytes: number, sha256: string | null): string | null {
    if (bytes !== entry.bytes) return `${entry.path}: ${bytes} bytes, the manifest says ${entry.bytes}`;
    if (sha256 !== null && sha256 !== entry.sha256) return `${entry.path}: sha256 does not match the manifest`;
    return null;
}

async function listFolderFiles(root: string, relDir: string, present: Set<string>): Promise<void> {
    for (const entry of await fsp.readdir(path.join(root, relDir), { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await listFolderFiles(root, rel, present);
        else if (entry.isFile()) present.add(rel);
    }
}

function listArchiveDatabases(
    root: string,
    entries: ReadonlyMap<string, BackupEntry>,
    fail: (message: string) => void,
): ArchiveDatabase[] {
    // A home folder holds the first, the server member the second; neither holds the other's.
    const fixed: ArchiveDatabase[] = [
        ...HOME_DATABASES.map(([config, relPath]) => ({
            path: archiveHomePath(relPath),
            isYjsDocument: false,
            config,
        })),
        ...Object.values(SERVER_DATABASES).map((name) => ({ path: archiveServerPath(name), isYjsDocument: false })),
    ];
    const found = fixed.filter((database) => fs.existsSync(path.join(root, database.path)));

    const mountsDir = path.join(root, ARCHIVE_HOME_DIR, PATHS.DRIVE.ROOT);
    if (!fs.existsSync(mountsDir)) return found;
    for (const entry of fs.readdirSync(mountsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relMetadata = archiveMountPath(entry.name, PATHS.DRIVE.METADATA_DB);
        const metadata = path.join(root, relMetadata);
        if (!fs.existsSync(metadata)) continue;
        found.push({ path: relMetadata, isYjsDocument: false, config: MOUNT_DB_CONFIG });

        // The archived metadata.db is read back to learn which files are Eigen's databases. One too broken to read
        // fails here.
        try {
            const db = new Database(metadata, { readonly: true });
            try {
                const rows = readMountPathRows(db);
                // A restore serves a plain file's size and ETag from its row, so the row describes the bytes the
                // manifest lists for it. Eigen's own databases are copies, and a row with no file has nothing to match.
                const byId = new Map(rows.map((row) => [row.id, row]));
                const archivePath = archivePaths(rows);
                for (const row of rows) {
                    if (row.type !== 'file' || managedDbContainer(row, byId)) continue;
                    const file = entries.get(
                        archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${archivePath(row)}`),
                    );
                    if (!file) continue;
                    if (row.size !== file.bytes) {
                        fail(`${file.path}: ${file.bytes} bytes, its row says ${row.size}`);
                    } else if (row.hash !== null && row.hash !== file.sha256) {
                        fail(`${file.path}: sha256 does not match its row`);
                    }
                }
                for (const managed of listManagedDatabases(rows)) {
                    found.push({
                        path: archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${managed.path}`),
                        isYjsDocument: managed.isContainerData && isCollabType(managed.containerType),
                        config: managed.config,
                    });
                }
            } finally {
                db.close();
            }
        } catch (error) {
            fail(`${relMetadata}: the mount tree could not be read (${describeError(error)})`);
        }
    }
    return found;
}

function countYjsBlobs(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db
            .query<{ total: number }, []>(
                'SELECT (SELECT COUNT(*) FROM doc_updates) + (SELECT COUNT(*) FROM doc_snapshots) AS total',
            )
            .get();
        return row?.total ?? 0;
    } finally {
        db.close();
    }
}

// The failures, the first MAX_LINES of them and a count of the rest.
function cappedFailures(): { add: (message: string) => void; lines: () => string[] } {
    const kept: string[] = [];
    let suppressed = 0;
    return {
        add: (message) => {
            if (kept.length < MAX_LINES) kept.push(message);
            else suppressed++;
        },
        lines: () => (suppressed > 0 ? [...kept, `…and ${suppressed} more failures`] : kept),
    };
}
