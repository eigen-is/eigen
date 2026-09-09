import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { type DrivePathType, getEigenDocInfoByType, isCollabType } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { PATHS } from '../core';
import { hashFile } from '../drive/streaming';
import { HOME_DATABASE_PATHS, type SnapshotProgress } from './snapshot-home';
import { listManagedDatabases, type MountPathRow } from './snapshot-mount';

// Stage 3 samples rather than decodes everything: the ten heaviest documents plus ten of the rest.
const SAMPLE_LARGEST = 10;
const SAMPLE_RANDOM = 10;
// A wrecked archive can fail on every entry; the record is a sidecar and an SSE payload, not a log.
const MAX_FAILURES = 100;

// An Eigen-owned database inside the archive. `collabType` is set only for the data.db of a
// Yjs container, the one thing stage 3 can decode (chat's data.db is plain SQLite).
type ArchiveDatabase = { path: string; collabType: DrivePathType | null };

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function listArchiveDatabases(dir: string, fail: (message: string) => void): ArchiveDatabase[] {
    const found: ArchiveDatabase[] = [];
    for (const relPath of HOME_DATABASE_PATHS) {
        if (fs.existsSync(path.join(dir, 'home', relPath))) found.push({ path: `home/${relPath}`, collabType: null });
    }

    const mountsDir = path.join(dir, 'home', PATHS.DRIVE.ROOT);
    if (!fs.existsSync(mountsDir)) return found;
    for (const entry of fs.readdirSync(mountsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relMetadata = `home/${PATHS.DRIVE.ROOT}/${entry.name}/${PATHS.DRIVE.METADATA_DB}`;
        if (!fs.existsSync(path.join(dir, relMetadata))) continue;
        found.push({ path: relMetadata, collabType: null });

        // Which of a mount's files are Eigen's own databases follows from its tree, so the archived
        // metadata.db is read back for it. One too broken to read is a failure of its own; stage 2
        // opens the same file right after and says the same thing in SQLite's words.
        try {
            const db = new Database(path.join(dir, relMetadata), { readonly: true });
            try {
                const rows = db
                    .query<MountPathRow, []>('SELECT id, file, name, type, parentId, trashedFrom FROM paths')
                    .all();
                for (const managed of listManagedDatabases(rows)) {
                    found.push({
                        path: `home/${PATHS.DRIVE.ROOT}/${entry.name}/${PATHS.DRIVE.DATA_DIR}/${managed.path}`,
                        collabType:
                            managed.role === 'data' && isCollabType(managed.containerType)
                                ? managed.containerType
                                : null,
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

// Y.applyUpdate hydrates roots as AbstractType, so the declared roots are re-typed here before they
// are read — the same trick restoreYjsDoc uses before walking a snapshot.
function hasContent(doc: Y.Doc, type: DrivePathType): boolean {
    const roots = getEigenDocInfoByType(type)?.yjsRoots;
    if (!roots) return false;
    for (const [name, kind] of Object.entries(roots)) {
        switch (kind) {
            case 'map':
                if (doc.getMap(name).size > 0) return true;
                break;
            case 'array':
                if (doc.getArray(name).length > 0) return true;
                break;
            case 'text':
                if (doc.getText(name).length > 0) return true;
                break;
            case 'xmlfragment':
                if (doc.getXmlFragment(name).length > 0) return true;
                break;
        }
    }
    return false;
}

// Decides whether an unpacked backup folder counts as good: every file is the one the manifest
// describes (transport), every Eigen database is structurally sound (structure), and a sample of
// the collab documents still decodes into a document with content (content). Works on any folder
// with a manifest — a staging folder straight after a backup, or a fresh extract before a restore.
export async function verifyFolder(dir: string, onProgress?: SnapshotProgress): Promise<BackupVerifyRecord> {
    const checkedAt = new Date().toISOString();
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return { status: 'failed', checkedAt, failures: ['manifest.json is missing'] };
    }
    const manifest: BackupManifest = await Bun.file(manifestPath).json();

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
        if (!present.delete(entry.path)) {
            fail(`${entry.path}: missing from the folder`);
        } else {
            const { size, hash } = await hashFile(path.join(dir, entry.path));
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
                fail(`${database.path}: could not be opened (${describeError(error)})`);
            }
        }
        onProgress?.('verify databases', index + 1, databases.length);
    }

    // Stage 3 — content: the bytes are a document, not just a well-formed database.
    const collab = databases.flatMap((database) => {
        const abs = path.join(dir, database.path);
        if (!database.collabType || !fs.existsSync(abs)) return [];
        return [{ path: database.path, collabType: database.collabType, bytes: fs.statSync(abs).size }];
    });
    collab.sort((a, b) => b.bytes - a.bytes);
    const sampled = collab
        .slice(SAMPLE_LARGEST)
        .map((database) => ({ database, order: Math.random() }))
        .sort((a, b) => a.order - b.order)
        .slice(0, SAMPLE_RANDOM)
        .map((entry) => entry.database);
    const targets = [...collab.slice(0, SAMPLE_LARGEST), ...sampled];
    for (const [index, target] of targets.entries()) {
        const abs = path.join(dir, target.path);
        try {
            // A document nobody has typed in holds no blobs at all, and a backup of one must not
            // come out failed; with blobs present, they have to decode into actual content.
            if (countYjsBlobs(abs) > 0) {
                const doc = new Y.Doc();
                Y.applyUpdate(doc, readYjsStateFromFile(abs));
                if (!hasContent(doc, target.collabType)) fail(`${target.path}: decodes to an empty document`);
            }
        } catch (error) {
            fail(`${target.path}: the Yjs state could not be read (${describeError(error)})`);
        }
        onProgress?.('verify documents', index + 1, targets.length);
    }

    if (suppressed > 0) failures.push(`…and ${suppressed} more failures`);
    return { status: failures.length === 0 ? 'verified' : 'failed', checkedAt, failures };
}
