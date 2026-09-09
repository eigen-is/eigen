import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupVerifyRecord } from '@workspace/lib/types/backup';
import { isCollabType } from '@workspace/lib/types/drive';
import { parseBackupManifest } from '@workspace/lib/validation';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { PATHS } from '../core';
import { hashFile } from '../drive/streaming';
import { ARCHIVE_HOME_DIR, archiveHomePath, archiveMountPath } from './paths';
import { HOME_DATABASE_PATHS, type SnapshotProgress } from './snapshot-home';
import { listManagedDatabases, type MountPathRow } from './snapshot-mount';

// Stage 3 samples rather than decodes everything: the ten heaviest documents plus ten of the rest.
const SAMPLE_LARGEST = 10;
const SAMPLE_REST = 10;
// A wrecked archive can fail on every entry; the record is a sidecar and an SSE payload, not a log.
const MAX_FAILURES = 100;

// An Eigen-owned database inside the archive. `isYjsDocument` marks the data.db of a collab
// container — the only kind stage 3 can decode (chat's data.db is plain SQLite).
type ArchiveDatabase = { path: string; isYjsDocument: boolean };

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasControlCharacter(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

// An archive comes from outside: its manifest and its mount trees name the paths this reads and
// opens. Anything that would leave the folder — absolute, a `..` hop, a control character — is
// refused before it reaches the filesystem.
function resolveInside(dir: string, relPath: string): string | null {
    if (relPath === '' || path.isAbsolute(relPath) || hasControlCharacter(relPath)) return null;
    if (relPath.split(/[\\/]/).includes('..')) return null;
    const abs = path.resolve(dir, relPath);
    return abs.startsWith(`${path.resolve(dir)}${path.sep}`) ? abs : null;
}

function listArchiveDatabases(dir: string, fail: (message: string) => void): ArchiveDatabase[] {
    const found: ArchiveDatabase[] = [];
    for (const relPath of HOME_DATABASE_PATHS) {
        const archivePath = archiveHomePath(relPath);
        if (fs.existsSync(path.join(dir, archivePath))) found.push({ path: archivePath, isYjsDocument: false });
    }

    const mountsDir = path.join(dir, ARCHIVE_HOME_DIR, PATHS.DRIVE.ROOT);
    if (!fs.existsSync(mountsDir)) return found;
    for (const entry of fs.readdirSync(mountsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relMetadata = archiveMountPath(entry.name, PATHS.DRIVE.METADATA_DB);
        const metadata = resolveInside(dir, relMetadata);
        if (!metadata || !fs.existsSync(metadata)) continue;
        found.push({ path: relMetadata, isYjsDocument: false });

        // Which of a mount's files are Eigen's own databases follows from its tree, so the archived
        // metadata.db is read back for it. One too broken to read is a failure of its own; stage 2
        // opens the same file right after and says the same thing in SQLite's words.
        try {
            const db = new Database(metadata, { readonly: true });
            try {
                const rows = db
                    .query<MountPathRow, []>('SELECT id, file, name, type, parentId, trashedFrom FROM paths')
                    .all();
                for (const managed of listManagedDatabases(rows)) {
                    const archivePath = archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${managed.path}`);
                    if (!resolveInside(dir, archivePath)) {
                        fail(`${archivePath}: leaves the backup folder`);
                        continue;
                    }
                    found.push({
                        path: archivePath,
                        isYjsDocument: managed.isContainerData && isCollabType(managed.containerType),
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

// Decides whether an unpacked backup folder counts as good: every file is the one the manifest
// describes (transport), every Eigen database is structurally sound (structure), and a sample of
// the collab documents still decodes into a document with content (content). Works on any folder
// with a manifest — a staging folder straight after a backup, or a fresh extract before a restore.
// Every database is opened read-only: a verify never changes a byte of what it is checking.
export async function verifyFolder(dir: string, onProgress?: SnapshotProgress): Promise<BackupVerifyRecord> {
    const checkedAt = new Date().toISOString();
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return { status: 'failed', checkedAt, failures: ['manifest.json is missing'] };
    }
    const manifest = parseBackupManifest(await Bun.file(manifestPath).text());
    if (!manifest) {
        return { status: 'failed', checkedAt, failures: ['manifest.json is not a version 1 backup manifest'] };
    }

    const failures: string[] = [];
    let suppressed = 0;
    const fail = (message: string): void => {
        if (failures.length < MAX_FAILURES) failures.push(message);
        else suppressed++;
    };

    // Stage 1 — transport: the manifest and the folder describe the same set of bytes.
    const present = new Set<string>();
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true, dot: true })) {
        present.add(rel.replaceAll('\\', '/'));
    }
    present.delete('manifest.json');
    for (const [index, entry] of manifest.entries.entries()) {
        const abs = resolveInside(dir, entry.path);
        if (!abs) {
            fail(`${entry.path}: leaves the backup folder`);
        } else if (!present.delete(entry.path)) {
            fail(`${entry.path}: missing from the folder`);
        } else {
            const { size, hash } = await hashFile(abs);
            if (size !== entry.bytes) fail(`${entry.path}: ${size} bytes, the manifest says ${entry.bytes}`);
            else if (hash !== entry.sha256) fail(`${entry.path}: sha256 does not match the manifest`);
        }
        onProgress?.('verify files', index + 1, manifest.entries.length);
    }
    for (const extra of present) fail(`${extra}: not in the manifest`);

    // Stage 2 — structure: SQLite's own verdict on every database the archive owns. A file already
    // reported missing by stage 1 is skipped rather than reported twice.
    const databases = listArchiveDatabases(dir, fail);
    for (const [index, database] of databases.entries()) {
        const abs = path.join(dir, database.path);
        if (fs.existsSync(abs)) {
            try {
                const db = new Database(abs, { readonly: true });
                try {
                    const row = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
                    if (row?.quick_check !== 'ok') {
                        fail(`${database.path}: quick_check says ${row?.quick_check ?? 'nothing'}`);
                    }
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

    // Stage 3 — content: the bytes are a document, not just a well-formed database. The sample is
    // deterministic — largest first, then by hashed path — so two verifies of a folder agree.
    const collab = databases.flatMap((database) => {
        const abs = path.join(dir, database.path);
        if (!database.isYjsDocument || !fs.existsSync(abs)) return [];
        const order = new Bun.CryptoHasher('sha256').update(database.path).digest('hex');
        return [{ path: database.path, bytes: fs.statSync(abs).size, order }];
    });
    collab.sort((a, b) => b.bytes - a.bytes);
    const rest = collab.slice(SAMPLE_LARGEST).sort((a, b) => a.order.localeCompare(b.order));
    const targets = [...collab.slice(0, SAMPLE_LARGEST), ...rest.slice(0, SAMPLE_REST)];
    for (const [index, target] of targets.entries()) {
        const abs = path.join(dir, target.path);
        try {
            // A document nobody has typed in holds no blobs at all, and a backup of one must not come
            // out failed. With blobs present, every one of them has to decode (the loader throws
            // otherwise) into a document that has shared types. Which types, and what is in them, is
            // not verify's business: a document written by an older app version keeps its content
            // under names this build no longer knows, and that is not corruption.
            if (countYjsBlobs(abs) > 0) {
                const doc = new Y.Doc();
                Y.applyUpdate(doc, readYjsStateFromFile(abs, { readonly: true }));
                if (doc.share.size === 0) fail(`${target.path}: its Yjs blobs decode to an empty document`);
            }
        } catch (error) {
            fail(`${target.path}: the Yjs state could not be read (${describeError(error)})`);
        }
        onProgress?.('verify documents', index + 1, targets.length);
    }

    if (suppressed > 0) failures.push(`…and ${suppressed} more failures`);
    return { status: failures.length === 0 ? 'verified' : 'failed', checkedAt, failures };
}
