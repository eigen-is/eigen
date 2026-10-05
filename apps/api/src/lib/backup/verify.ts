import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupEntry, BackupVerifyRecord, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { isCollabType } from '@workspace/lib/types/drive';
import { parseBackupManifest, parseServerArchiveManifest } from '@workspace/lib/validation';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { SERVER_DATABASES } from '../config/paths';
import { PATHS } from '../core/constants';
import { ApiError } from '../core/errors';
import { hashFile } from '../storage/deadline';
import { type ArchiveMember, readArchiveMember, readArchiveMembers } from './archive';
import {
    archivePath,
    checkArchivedPathRows,
    HOME_DATABASE_PATHS,
    listManagedDatabases,
    managedDbContainer,
    readMountPathRows,
} from './archive-layout';
import { describeError } from './errors';
import {
    ARCHIVE_HOME_DIR,
    ARCHIVE_MANIFEST_FILE,
    archiveHomePath,
    archiveMountPath,
    archiveServerPath,
    resolveInside,
} from './paths';
import type { SnapshotProgress } from './snapshot-home';

// Stage 3 samples rather than decodes everything: the ten heaviest documents plus ten of the rest.
const SAMPLE_LARGEST = 10;
const SAMPLE_REST = 10;
// A wrecked archive can fail on every entry; the record is a sidecar and an SSE payload, not a log.
const MAX_FAILURES = 100;
// And how many of them a one-line message quotes: the record carries the whole list.
const FAILURES_IN_MESSAGE = 3;

export function describeFailures(verify: Pick<BackupVerifyRecord, 'failures'>): string {
    return verify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ');
}

// The refusal of what does not verify, `name` being what was judged.
export function requireVerified(verified: BackupVerifyRecord, name: string): void {
    if (verified.status === 'verified') return;
    throw new ApiError(400, `${name} did not verify: ${describeFailures(verified)}`);
}

// An Eigen-owned database inside the archive: the path the manifest speaks of, and the resolved
// one that survived the containment check. `isYjsDocument` marks the data.db of a collab container
// — the only kind stage 3 can decode (chat's data.db is plain SQLite).
type ArchiveDatabase = { path: string; abs: string; isYjsDocument: boolean };

// The folder's own files, walked with readdir's lstat-level types so a symlink is seen rather than
// followed. packFolder writes files and directories only, so a link in an unpacked archive came
// from somewhere else and has no business being read.
async function listFolderFiles(
    root: string,
    relDir: string,
    present: Set<string>,
    fail: (message: string) => void,
): Promise<void> {
    for (const entry of await fsp.readdir(path.join(root, relDir), { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) fail(`${rel}: is a symbolic link`);
        else if (entry.isDirectory()) await listFolderFiles(root, rel, present, fail);
        else if (entry.isFile()) present.add(rel);
    }
}

function listArchiveDatabases(
    root: string,
    entries: ReadonlyMap<string, BackupEntry>,
    fail: (message: string) => void,
): ArchiveDatabase[] {
    const found: ArchiveDatabase[] = [];
    // A home folder holds the first, the server member the second; neither holds the other's.
    const fixed = [
        ...[...HOME_DATABASE_PATHS].map(archiveHomePath),
        ...Object.values(SERVER_DATABASES).map(archiveServerPath),
    ];
    for (const relDatabase of fixed) {
        const abs = resolveInside(root, relDatabase);
        if (abs && fs.existsSync(abs)) found.push({ path: relDatabase, abs, isYjsDocument: false });
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
                const rows = readMountPathRows(db);
                // Before a path is derived from them: every path a restore builds is a join of these
                // rows' two name columns, and the table came in inside a file somebody uploaded.
                for (const failure of checkArchivedPathRows(rows)) fail(`${relMetadata}: ${failure}`);
                // A restore serves a plain file's size and ETag from its row, so the row describes the bytes the
                // manifest lists for it. Eigen's own databases are copies, and a row with no file has nothing to match.
                // A warning, not a failure: an archive written before captures rewrote the row must still restore.
                const byId = new Map(rows.map((row) => [row.id, row]));
                for (const row of rows) {
                    if (row.type !== 'file' || managedDbContainer(row, byId)) continue;
                    const file = entries.get(
                        archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${archivePath(row, byId)}`),
                    );
                    if (!file) continue;
                    if (row.size !== file.bytes) {
                        console.warn(`[backup] ${file.path}: ${file.bytes} bytes, its row says ${row.size}`);
                    } else if (row.hash !== null && row.hash !== file.sha256) {
                        console.warn(`[backup] ${file.path}: sha256 does not match its row`);
                    }
                }
                for (const managed of listManagedDatabases(rows)) {
                    const relDatabase = archiveMountPath(entry.name, `${PATHS.DRIVE.DATA_DIR}/${managed.path}`);
                    const abs = resolveInside(root, relDatabase);
                    if (!abs) {
                        fail(`${relDatabase}: leaves the backup folder`);
                        continue;
                    }
                    found.push({
                        path: relDatabase,
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
    const manifestPath = path.join(dir, ARCHIVE_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
        return { status: 'failed', checkedAt, failures: [`${ARCHIVE_MANIFEST_FILE} is missing`] };
    }
    const manifest = parseBackupManifest(await Bun.file(manifestPath).text());
    if (!manifest) {
        return {
            status: 'failed',
            checkedAt,
            failures: [`${ARCHIVE_MANIFEST_FILE} is not a version 1 backup manifest`],
        };
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
    await listFolderFiles(root, '', present, fail);
    present.delete(ARCHIVE_MANIFEST_FILE);
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
    const databases = listArchiveDatabases(root, new Map(manifest.entries.map((entry) => [entry.path, entry])), fail);
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

// A whole-server archive as one read finds it: every member hashed, the manifest it closes with,
// and the transport verdict. The manifest is null unless it parses; the members are what the read
// got through before it failed.
type ReadServerArchive = {
    verify: BackupVerifyRecord;
    members: ArchiveMember[];
    manifest: ServerArchiveManifest | null;
};

// The transport check of a whole-server archive: its last member is the manifest, and every other
// member is there with the bytes and sha256 the manifest names. No member is unpacked; each one
// verifies on its own when it is extracted.
export async function readServerArchive(archivePath: string): Promise<ReadServerArchive> {
    const checkedAt = new Date();
    const failed = (
        failures: string[],
        members: ArchiveMember[] = [],
        manifest: ServerArchiveManifest | null = null,
    ) => ({
        verify: { status: 'failed' as const, checkedAt, failures },
        members,
        manifest,
    });
    let members: ArchiveMember[];
    try {
        members = await readArchiveMembers(archivePath);
    } catch (error) {
        // A cut-off or foreign tar is a verdict on the archive, not an error of the check.
        return failed([describeError(error)]);
    }
    const last = members.at(-1);
    if (last?.name !== ARCHIVE_MANIFEST_FILE)
        return failed([`${ARCHIVE_MANIFEST_FILE} is not the last member`], members);
    let text: string;
    try {
        text = new TextDecoder().decode(await readArchiveMember(last));
    } catch (error) {
        return failed([describeError(error)], members);
    }
    const manifest = parseServerArchiveManifest(text);
    if (!manifest) {
        return failed([`${ARCHIVE_MANIFEST_FILE} is not a version 1 server archive manifest`], members);
    }

    // A reader takes one of two same-named members and the manifest cannot say which, so their bytes do not matter.
    const present = new Map<string, ArchiveMember>();
    const duplicates = new Set<string>();
    for (const member of members.slice(0, -1)) {
        if (present.has(member.name)) duplicates.add(member.name);
        present.set(member.name, member);
    }
    if (duplicates.size > 0) {
        const failures = [...duplicates].map((name) => `${name}: appears more than once in the archive`);
        return failed(failures, members, manifest);
    }

    const failures: string[] = [];
    for (const entry of manifest.entries) {
        const member = present.get(entry.path);
        present.delete(entry.path);
        if (!member) {
            failures.push(`${entry.path}: missing from the archive`);
        } else if (member.bytes !== entry.bytes) {
            failures.push(`${entry.path}: ${member.bytes} bytes, the manifest says ${entry.bytes}`);
        } else if (member.sha256 !== entry.sha256) {
            failures.push(`${entry.path}: sha256 does not match the manifest`);
        }
    }
    for (const extra of present.keys()) failures.push(`${extra}: not in the manifest`);
    const status = failures.length === 0 ? 'verified' : 'failed';
    return { verify: { status, checkedAt, failures }, members, manifest };
}
