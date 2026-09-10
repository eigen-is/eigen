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
import { listManagedDatabases, readMountPathRows } from './snapshot-mount';

// Stage 3 samples rather than decodes everything: the ten heaviest documents plus ten of the rest.
const SAMPLE_LARGEST = 10;
const SAMPLE_REST = 10;
// A wrecked archive can fail on every entry; the record is a sidecar and an SSE payload, not a log.
const MAX_FAILURES = 100;

// An Eigen-owned database inside the archive: the path the manifest speaks of, and the resolved
// one that survived the containment check. `isYjsDocument` marks the data.db of a collab container
// — the only kind stage 3 can decode (chat's data.db is plain SQLite).
type ArchiveDatabase = { path: string; abs: string; isYjsDocument: boolean };

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
// opens. Anything that would leave the folder — absolute, a `..` hop, a control character, or a
// path that walks through a symlink — is refused before it reaches the filesystem. `root` is
// already a real path, so the comparison holds on a macOS /var → /private/var of a temp folder too.
function resolveInside(root: string, relPath: string): string | null {
    if (relPath === '' || path.isAbsolute(relPath) || hasControlCharacter(relPath)) return null;
    if (relPath.split(/[\\/]/).includes('..')) return null;
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(`${root}${path.sep}`)) return null;
    // Lexically inside is not enough: one symlinked directory along the way and the bytes read are
    // somebody else's. Stage 1 never reaches a link (its walk does not follow one), but the database
    // paths stages 2 and 3 open come out of an archived tree with no such walk in front of them.
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    return real.startsWith(`${root}${path.sep}`) ? abs : null;
}

// The folder's own files, walked with readdir's lstat-level types so a symlink is seen rather than
// followed. packFolder writes files and directories only, so a link in an unpacked archive came
// from somewhere else and has no business being read.
function listFolderFiles(root: string, relDir: string, present: Set<string>, fail: (message: string) => void): void {
    for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) fail(`${rel}: is a symbolic link`);
        else if (entry.isDirectory()) listFolderFiles(root, rel, present, fail);
        else if (entry.isFile()) present.add(rel);
    }
}

function listArchiveDatabases(root: string, fail: (message: string) => void): ArchiveDatabase[] {
    const found: ArchiveDatabase[] = [];
    for (const relPath of HOME_DATABASE_PATHS) {
        const archivePath = archiveHomePath(relPath);
        const abs = resolveInside(root, archivePath);
        if (abs && fs.existsSync(abs)) found.push({ path: archivePath, abs, isYjsDocument: false });
    }

    const mountsDir = path.join(root, ARCHIVE_HOME_DIR, PATHS.DRIVE.ROOT);
    if (!fs.existsSync(mountsDir)) return found;
    for (const entry of fs.readdirSync(mountsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relMetadata = archiveMountPath(entry.name, PATHS.DRIVE.METADATA_DB);
        const metadata = resolveInside(root, relMetadata);
        if (!metadata || !fs.existsSync(metadata)) continue;
        found.push({ path: relMetadata, abs: metadata, isYjsDocument: false });

        // Which of a mount's files are Eigen's own databases follows from its tree, so the archived
        // metadata.db is read back for it. One too broken to read is a failure of its own; stage 2
        // opens the same file right after and says the same thing in SQLite's words.
        try {
            const db = new Database(metadata, { readonly: true });
            try {
                for (const managed of listManagedDatabases(readMountPathRows(db))) {
                    const archivePath = archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${managed.path}`);
                    const abs = resolveInside(root, archivePath);
                    if (!abs) {
                        fail(`${archivePath}: leaves the backup folder`);
                        continue;
                    }
                    found.push({
                        path: archivePath,
                        abs,
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
    const checkedAt = new Date();
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return { status: 'failed', checkedAt, failures: ['manifest.json is missing'] };
    }
    const manifest = parseBackupManifest(await Bun.file(manifestPath).text());
    if (!manifest) {
        return { status: 'failed', checkedAt, failures: ['manifest.json is not a version 1 backup manifest'] };
    }
    // Every path below is compared against this, so the folder's own real path is the baseline.
    const root = fs.realpathSync(dir);

    const failures: string[] = [];
    let suppressed = 0;
    const fail = (message: string): void => {
        if (failures.length < MAX_FAILURES) failures.push(message);
        else suppressed++;
    };

    // Stage 1 — transport: the manifest and the folder describe the same set of bytes.
    const present = new Set<string>();
    listFolderFiles(root, '', present, fail);
    present.delete('manifest.json');
    for (const [index, entry] of manifest.entries.entries()) {
        const abs = resolveInside(root, entry.path);
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
    const databases = listArchiveDatabases(root, fail);
    for (const [index, database] of databases.entries()) {
        if (fs.existsSync(database.abs)) {
            try {
                const db = new Database(database.abs, { readonly: true });
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
        if (!database.isYjsDocument || !fs.existsSync(database.abs)) return [];
        const order = new Bun.CryptoHasher('sha256').update(database.path).digest('hex');
        return [{ path: database.path, abs: database.abs, bytes: fs.statSync(database.abs).size, order }];
    });
    collab.sort((a, b) => b.bytes - a.bytes);
    const rest = collab.slice(SAMPLE_LARGEST).sort((a, b) => a.order.localeCompare(b.order));
    const targets = [...collab.slice(0, SAMPLE_LARGEST), ...rest.slice(0, SAMPLE_REST)];
    for (const [index, target] of targets.entries()) {
        try {
            // A document nobody has typed in holds no blobs at all, and a backup of one must not come
            // out failed. With blobs present, every one of them has to decode (the loader throws
            // otherwise) into a document that has shared types. Which types, and what is in them, is
            // not verify's business: a document written by an older app version keeps its content
            // under names this build no longer knows, and that is not corruption.
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

    if (suppressed > 0) failures.push(`…and ${suppressed} more failures`);
    return { status: failures.length === 0 ? 'verified' : 'failed', checkedAt, failures };
}
