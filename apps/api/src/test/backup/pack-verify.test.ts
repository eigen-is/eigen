import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupJob, BackupManifest, ServerArchiveManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { parseBackupArtifactName, parseServerArchiveManifest, parseServerArchiveName } from '@workspace/lib/validation';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
    copyArchiveMember,
    countPackedFolders,
    createServerArchiveWriter,
    declaredUnpackBytes,
    extractArtifact,
    hashArchiveMembers,
    packFolder,
    readArchiveMember,
    readArtifactManifest,
    readUnpackedHome,
    serializeManifest,
} from '../../lib/backup/archive';
import { listArtifacts, readSidecar, writeSidecar } from '../../lib/backup/artifacts';
import { runArtifactVerify } from '../../lib/backup/jobs';
import {
    ARCHIVE_MANIFEST_FILE,
    buildArtifactName,
    buildHomeFolderName,
    buildHomeMemberName,
    buildServerArchiveName,
    buildServerFolderName,
    getBackupsDir,
    SERVER_ARCHIVE_ENV_MEMBER,
    SERVER_ARCHIVE_SERVER_MEMBER,
} from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { appendInstallFiles, snapshotServer } from '../../lib/backup/snapshot-server';
import { DIRECTORY_TYPEFLAG, FILE_TYPEFLAG, headerChunks } from '../../lib/backup/tar';
import { verifyFolder } from '../../lib/backup/verify';
import { readServerArchive } from '../../lib/backup/verify-server-archive';
import { SERVER_DATABASES } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import {
    assertJson,
    authedRequest,
    countLoopTurns,
    createTeam,
    createTestUser,
    drivePost,
    driveUpload,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';
import { unpackWhole } from './backup-test-helpers';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const DOC_PROBE = 'pack-verify-probe';
// Snapshot, pack and extract do real SQLite, tar and zstd work, which a loaded full-suite run slows well past bun's 5 s default.
const PACK_TIMEOUT_MS = 30_000;
const EMPTY_DIR = 'home/eigen.mail/Maildir/.Empty/cur';

// Evaluated at registration time, so a machine without these tools skips the tests outright rather
// than passing them without asserting anything.
const HAS_TAR = Bun.which('tar') !== null;
const MANIFEST_CAP = 256 * 1024 * 1024;
const HAS_ZSTD = Bun.which('zstd') !== null;

function syncUpdateMessage(doc: Y.Doc): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collab-document.ts)
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
}

async function listFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    for await (const file of new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true })) {
        found.push(file.replaceAll('\\', '/'));
    }
    return found.sort();
}

async function hashTree(root: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    for (const rel of await listFiles(root)) {
        hasher.update(rel);
        hasher.update(new Uint8Array(await Bun.file(join(root, rel)).arrayBuffer()));
    }
    return hasher.digest('hex');
}

async function sha256Of(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
    return hasher.digest('hex');
}

// Every header of a plain tar, pax headers included, read off the bytes rather than through the reader under test.
function tarHeaderModes(tar: Uint8Array): { name: string; typeflag: string; mode: number }[] {
    const headers: { name: string; typeflag: string; mode: number }[] = [];
    let at = 0;
    while (at + 512 <= tar.length && tar.subarray(at, at + 512).some((byte) => byte !== 0)) {
        const field = (offset: number, length: number) =>
            new TextDecoder().decode(tar.subarray(at + offset, at + offset + length)).split('\0')[0];
        const size = Number.parseInt(field(124, 12), 8);
        headers.push({ name: field(0, 100), typeflag: field(156, 1), mode: Number.parseInt(field(100, 8), 8) });
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return headers;
}

// Stage 3 samples the ten largest data.db files plus ten more; padding a doctored one past every
// other data.db in the folder is what makes a test of it independent of what else the home holds.
function padPastEveryDataDb(db: Database, manifest: BackupManifest): void {
    const largest = Math.max(...manifest.entries.filter((e) => e.path.endsWith('/data.db')).map((e) => e.bytes));
    db.run('CREATE TABLE filler (bytes BLOB)');
    db.run(`INSERT INTO filler VALUES (zeroblob(${largest + 4096}))`);
}

// Re-states one manifest entry for the bytes now on disk, so a deliberate corruption is judged by
// the stage under test instead of by stage 1's hashes.
async function restateManifestEntry(folder: string, relPath: string): Promise<void> {
    const manifestPath = join(folder, 'manifest.json');
    const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.entries.find((e) => e.path === relPath);
    if (!entry) throw new Error(`restateManifestEntry: ${relPath} is not in the manifest`);
    entry.bytes = Bun.file(join(folder, relPath)).size;
    entry.sha256 = await sha256Of(join(folder, relPath));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

describe('Backup pack and verify', () => {
    let ctx: TestCtx;
    let ownerId: string;
    let folderName: string;
    let mountId: string;
    let artifact: string;
    let manifest: BackupManifest;
    let docDataDb: string;
    let sheetDataDb: string;
    let longPath: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const alice = ctx.alice.user;
        ownerId = alice.id;
        folderName = buildHomeFolderName(ownerId);
        const home = await getHome(ownerId);

        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(alice.sessionToken, `/drive/${ownerId}/mounts`),
        );
        mountId = mounts[0].id;
        const root = await assertJson<DrivePath>(
            await authedRequest(alice.sessionToken, `/drive/${ownerId}/${mountId}/root`),
        );

        // One container per stage-3 outcome: a doc and a sheet the verify must decode, a chat whose
        // data.db is not Yjs and must be skipped.
        const doc = await drivePost(alice.sessionToken, ownerId, mountId, `folder/${root.id}/create/doc`, {
            fileName: 'Pack Doc',
        });
        const sheet = await drivePost(alice.sessionToken, ownerId, mountId, `folder/${root.id}/create/sheets`, {
            fileName: 'Pack Sheet',
        });
        await drivePost(alice.sessionToken, ownerId, mountId, `folder/${root.id}/create/chat`, {
            fileName: 'Pack Chat',
        });
        // Never opened, so its data.db holds no Yjs blobs at all — a fresh document must still verify.
        await drivePost(alice.sessionToken, ownerId, mountId, `folder/${root.id}/create/stickies`, {
            fileName: 'Pack Untouched',
        });

        // Write through the live collab document, into the roots EIGEN_DOC_TYPE_INFO declares for
        // each type — that is what stage 3 reads back.
        const conn = { send() {}, readyState: 1 } as unknown as Parameters<
            Awaited<ReturnType<typeof home.drive.getCollabDocument>>['handleMessage']
        >[0];
        const docCollab = await home.drive.getCollabDocument(mountId, doc.id);
        const docEdit = new Y.Doc();
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(DOC_PROBE)]);
        docEdit.getXmlFragment('default').insert(0, [paragraph]);
        docCollab.handleMessage(conn, syncUpdateMessage(docEdit), true);

        const sheetCollab = await home.drive.getCollabDocument(mountId, sheet.id);
        const sheetEdit = new Y.Doc();
        sheetEdit.getMap('state').set('probe', DOC_PROBE);
        sheetCollab.handleMessage(conn, syncUpdateMessage(sheetEdit), true);

        // Content in a root the type registry does not declare — an older app version's document, or
        // a fixture like this one. Stage 3 must read it as a document, not as an empty one.
        const other = await drivePost(alice.sessionToken, ownerId, mountId, `folder/${root.id}/create/doc`, {
            fileName: 'Pack Other Roots',
        });
        const otherCollab = await home.drive.getCollabDocument(mountId, other.id);
        const otherEdit = new Y.Doc();
        otherEdit.getText('not-a-declared-root').insert(0, DOC_PROBE);
        otherCollab.handleMessage(conn, syncUpdateMessage(otherEdit), true);

        // A path past tar's 100-byte name field, so packing has to write a pax header for it.
        await driveUpload(
            alice.sessionToken,
            ownerId,
            mountId,
            root.id,
            new File([TEST_PNG_BYTES], `${'long-name-'.repeat(12)}.png`, { type: 'image/png' }),
        );

        // A non-ASCII name: on a path-based mount it is a tar entry name, and the reader has to take
        // it as UTF-8 (Bun.Archive 1.3.14 stops reading at the first one, or crashes on a ustar name).
        await driveUpload(
            alice.sessionToken,
            ownerId,
            mountId,
            root.id,
            new File([TEST_PNG_BYTES], 'café ünïcode.png', { type: 'image/png' }),
        );

        const target = mkdtempSync(join(TEST_DATA_DIR, 'pack-'));
        manifest = await snapshotHome(home, target);
        const folder = join(target, folderName);
        const files = await listFiles(folder);
        docDataDb = files.find((f) => f.includes('Pack Doc.eigendoc/') && f.endsWith('data.db'))!;
        sheetDataDb = files.find((f) => f.includes('Pack Sheet.eigensheets/') && f.endsWith('data.db'))!;
        longPath = files.find((f) => f.includes('long-name-'))!;
        expect(docDataDb).toBeTruthy();
        expect(sheetDataDb).toBeTruthy();
        expect(`${folderName}/${longPath}`.length).toBeGreaterThan(100);
        // Chat's data.db is a database the archive carries but stage 3 must not try to decode.
        expect(files.some((f) => f.includes('Pack Chat.eigenchat/') && f.endsWith('data.db'))).toBe(true);
        expect(files.some((f) => f.includes('Pack Untouched.eigenstickies/') && f.endsWith('data.db'))).toBe(true);

        // An empty directory (a Maildir folder nobody has delivered to) has to survive the round trip.
        mkdirSync(join(folder, EMPTY_DIR), { recursive: true });

        artifact = join(mkdtempSync(join(TEST_DATA_DIR, 'artifacts-')), buildArtifactName(ownerId, new Date()));
        await packFolder(folder, artifact);
    }, PACK_TIMEOUT_MS);

    async function extractFresh(prefix: string): Promise<string> {
        const dir = mkdtempSync(join(TEST_DATA_DIR, prefix));
        await unpackWhole(artifact, dir);
        return dir;
    }

    test(
        'packs into a .tar.zst and verifies a fresh extract',
        async () => {
            expect(Bun.file(artifact).size).toBeGreaterThan(0);
            // It holds password hashes and keys, so only the API's own user reads it.
            expect(fs.statSync(artifact).mode & 0o777).toBe(0o600);
            const dir = await extractFresh('extract-ok-');
            const record = await verifyFolder(join(dir, folderName));
            expect(record.failures).toEqual([]);
            expect(record.status).toBe('verified');
            expect(record.checkedAt).toBeTruthy();
        },
        PACK_TIMEOUT_MS,
    );

    test(
        "a home archive's entries and a fresh extract of it are for the API's user alone",
        async () => {
            const headers = tarHeaderModes(Bun.zstdDecompressSync(await Bun.file(artifact).bytes()));
            expect(headers.some((header) => header.typeflag === 'x')).toBe(true);
            expect(headers.some((header) => header.name === `${folderName}/${EMPTY_DIR}/`)).toBe(true);
            const privateMode = (typeflag: string) => (typeflag === '5' ? 0o700 : 0o600);
            // A pax header carries the mode of the entry that follows it, a long-named folder's as well as a file's.
            const entryType = (at: number) => headers[headers[at].typeflag === 'x' ? at + 1 : at].typeflag;
            expect(headers.filter((header, at) => header.mode !== privateMode(entryType(at)))).toEqual([]);

            const root = join(await extractFresh('extract-modes-'), folderName);
            const modes = ['', ...new Bun.Glob('**/*').scanSync({ cwd: root, onlyFiles: false, dot: true })].map(
                (rel) => {
                    const stat = fs.statSync(join(root, rel));
                    return { rel, mode: stat.mode & 0o7777, expected: stat.isDirectory() ? 0o700 : 0o600 };
                },
            );
            expect(modes.some(({ rel }) => rel === EMPTY_DIR)).toBe(true);
            expect(modes.some(({ rel }) => rel === docDataDb)).toBe(true);
            expect(modes.filter(({ mode, expected }) => mode !== expected)).toEqual([]);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'an empty directory survives pack and extract',
        async () => {
            const dir = await extractFresh('extract-dirs-');
            expect(existsSync(join(dir, folderName, EMPTY_DIR))).toBe(true);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'verifying a folder does not change a byte of it',
        async () => {
            const dir = await extractFresh('extract-stable-');
            const folder = join(dir, folderName);
            const before = await hashTree(folder);
            const record = await verifyFolder(folder);
            expect(record.status).toBe('verified');
            // A read-write open of a container data.db would leave a journal beside it and change the
            // very hashes stage 1 just checked. hashTree covers both: it walks the folder and folds
            // every path and its bytes in, so a stray -wal file moves the hash too.
            expect(await hashTree(folder)).toBe(before);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'the extracted folder holds the same bytes as the snapshot',
        async () => {
            const dir = await extractFresh('extract-bytes-');
            const files = await listFiles(join(dir, folderName));
            expect(files).toEqual([...manifest.entries.map((e) => e.path), 'manifest.json'].sort());
            for (const entry of manifest.entries) {
                expect(await sha256Of(join(dir, folderName, entry.path))).toBe(entry.sha256);
            }
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a flipped byte in a database fails stage 1, naming the entry',
        async () => {
            const dir = await extractFresh('extract-flip-');
            const target = join(dir, folderName, sheetDataDb);
            const bytes = readFileSync(target);
            const offset = Math.floor(bytes.length / 2);
            bytes[offset] = bytes[offset] ^ 0xff;
            writeFileSync(target, bytes);

            const record = await verifyFolder(join(dir, folderName));
            expect(record.status).toBe('failed');
            expect(record.failures.some((f) => f.includes(sheetDataDb) && f.includes('sha256'))).toBe(true);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a file the manifest does not list fails stage 1',
        async () => {
            const dir = await extractFresh('extract-extra-');
            const folder = join(dir, folderName);
            writeFileSync(join(folder, 'home/stowaway.txt'), 'not in the manifest');

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures).toContain('home/stowaway.txt: not in the manifest');
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a structurally broken database fails stage 2',
        async () => {
            const dir = await extractFresh('extract-corrupt-');
            const folder = join(dir, folderName);
            const relPath = `home/mounts/${mountId}/metadata.db`;
            const target = join(folder, relPath);
            // Wreck the pages after the header, then re-state the manifest entry so stage 1 is happy and
            // only SQLite's own verdict is left to fail.
            const bytes = readFileSync(target);
            bytes.fill(0xff, 4096, Math.min(bytes.length, 12288));
            writeFileSync(target, bytes);
            await restateManifestEntry(folder, relPath);

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures.some((f) => f.startsWith(`${relPath}: quick_check`))).toBe(true);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a manifest entry pointing outside the folder fails stage 1 and is never read',
        async () => {
            const dir = await extractFresh('extract-escape-');
            const folder = join(dir, folderName);
            const outside = join(dir, 'outside.txt');
            writeFileSync(outside, 'must not be read');

            const manifestPath = join(folder, 'manifest.json');
            const patched: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            patched.entries.push({ path: '../outside.txt', bytes: 16, sha256: 'x'.repeat(64) });
            patched.entries.push({ path: '/etc/hosts', bytes: 1, sha256: 'y'.repeat(64) });
            writeFileSync(manifestPath, JSON.stringify(patched, null, 2));

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures).toContain('../outside.txt: leaves the backup folder');
            expect(record.failures).toContain('/etc/hosts: leaves the backup folder');
            expect(record.failures.some((f) => f.includes('sha256'))).toBe(false);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a symlink in the folder fails stage 1 and its target is never read',
        async () => {
            const dir = await extractFresh('extract-symlink-');
            const folder = join(dir, folderName);
            // What a hostile archive would carry: a link out of the folder, and a manifest entry that
            // reads through it. packFolder never writes one.
            symlinkSync('/etc', join(folder, 'home/escape'));

            const manifestPath = join(folder, 'manifest.json');
            const patched: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            patched.entries.push({ path: 'home/escape/hosts', bytes: 1, sha256: 'z'.repeat(64) });
            writeFileSync(manifestPath, JSON.stringify(patched, null, 2));

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures).toContain('home/escape: is a symbolic link');
            expect(record.failures).toContain('home/escape/hosts: leaves the backup folder');
            expect(record.failures.some((f) => f.includes('sha256'))).toBe(false);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a manifest that is not a version 1 manifest fails the whole verify',
        async () => {
            const dir = await extractFresh('extract-badmanifest-');
            const folder = join(dir, folderName);
            const manifestPath = join(folder, 'manifest.json');
            const valid: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

            for (const broken of [
                'not json at all',
                JSON.stringify({ ...valid, entries: undefined }),
                JSON.stringify({ ...valid, formatVersion: 2 }),
            ]) {
                writeFileSync(manifestPath, broken);
                const record = await verifyFolder(folder);
                expect(record.status).toBe('failed');
                expect(record.failures).toEqual(['manifest.json is missing or not a version 1 backup manifest']);
            }
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a valid but empty data.db fails stage 3',
        async () => {
            const dir = await extractFresh('extract-empty-');
            const folder = join(dir, folderName);
            const target = join(folder, docDataDb);
            const empty = new Database(target, { create: true, readwrite: true });
            empty.run('PRAGMA journal_mode = DELETE');
            empty.run('DROP TABLE IF EXISTS doc_updates');
            empty.run('DROP TABLE IF EXISTS doc_snapshots');
            padPastEveryDataDb(empty, manifest);
            empty.run('VACUUM');
            empty.close();

            // Stage 1 must pass, so the manifest entry is re-stated for the replacement bytes.
            await restateManifestEntry(folder, docDataDb);

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures).toContain(
                `${docDataDb}: the Yjs state could not be read (no such table: doc_updates)`,
            );
            expect(record.failures.some((f) => f.includes('sha256') || f.includes('missing'))).toBe(false);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'blobs that decode to a document with no content fail stage 3',
        async () => {
            const dir = await extractFresh('extract-hollow-');
            const folder = join(dir, folderName);
            const target = join(folder, sheetDataDb);
            // One update row holding the encoding of an empty Y.Doc: the blobs decode fine, and there is
            // nothing in the document they describe.
            const hollow = new Database(target, { readwrite: true });
            hollow.run('DELETE FROM doc_updates');
            hollow.run('DELETE FROM doc_snapshots');
            hollow.query('INSERT INTO doc_updates (updateData) VALUES (?)').run(Y.encodeStateAsUpdate(new Y.Doc()));
            padPastEveryDataDb(hollow, manifest);
            hollow.close();
            await restateManifestEntry(folder, sheetDataDb);

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures).toContain(`${sheetDataDb}: its Yjs blobs decode to an empty document`);
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a non-ASCII file name survives pack and extract',
        async () => {
            const dir = await extractFresh('utf8-');
            const files = await listFiles(join(dir, folderName));
            expect(files.some((f) => f.endsWith('café ünïcode.png'))).toBe(true);
        },
        PACK_TIMEOUT_MS,
    );

    test('a folder whose name holds a backslash packs and extracts under its own name', async () => {
        const dir = mkdtempSync(join(TEST_DATA_DIR, 'backslash-'));
        const mailbox = 'home/eigen.mail/Maildir/.Projects\\2026/cur';
        mkdirSync(join(dir, 'home-x', mailbox), { recursive: true });
        writeFileSync(join(dir, 'home-x', mailbox, '1.eml'), 'mail');
        await packFolder(join(dir, 'home-x'), join(dir, 'x.tar.zst'));
        // A bare folder, with no manifest to bound its unpack by.
        await extractArtifact(join(dir, 'x.tar.zst'), join(dir, 'out'), 1e9);
        expect(readFileSync(join(dir, 'out/home-x', mailbox, '1.eml'), 'utf8')).toBe('mail');
        rmSync(dir, { recursive: true, force: true });
    });

    test(
        'readArtifactManifest reads the manifest without a full extract',
        async () => {
            const read = await readArtifactManifest(artifact);
            expect(read).toEqual(JSON.parse(JSON.stringify(manifest)));
        },
        PACK_TIMEOUT_MS,
    );

    test('the sidecar round-trips and is null when missing', async () => {
        expect(await readSidecar(artifact)).toBeNull();
        // The record travels as a Date; the sidecar on disk is JSON, so it round-trips through ISO.
        const verify = { status: 'verified' as const, checkedAt: new Date(), failures: [] };
        await writeSidecar(artifact, manifest, verify);
        // It names every file of the home, so it is as private as the archive.
        expect(fs.statSync(`${artifact}.manifest.json`).mode & 0o777).toBe(0o600);
        const read = await readSidecar(artifact);
        expect(read?.verify).toEqual(verify);
        expect(read?.manifest).toEqual(JSON.parse(JSON.stringify(manifest)));
    });

    test(
        'a file row whose size or sha256 differs from its bytes fails verify, each named',
        async () => {
            const dir = await extractFresh('extract-row-mismatch-');
            const folder = join(dir, folderName);
            const relMetadata = `home/mounts/${mountId}/metadata.db`;
            const db = new Database(join(folder, relMetadata));
            try {
                db.run("UPDATE paths SET size = 1 WHERE name = 'café ünïcode.png'");
                db.run("UPDATE paths SET hash = ? WHERE name LIKE 'long-name-%'", ['0'.repeat(64)]);
            } finally {
                db.close();
            }
            await restateManifestEntry(folder, relMetadata);
            const cafe = manifest.entries.find((entry) => entry.path.includes('café ünïcode.png'))!;

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures.toSorted()).toEqual(
                [
                    `${cafe.path}: ${cafe.bytes} bytes, its row says 1`,
                    `${longPath}: sha256 does not match its row`,
                ].toSorted(),
            );
        },
        PACK_TIMEOUT_MS,
    );

    // A hostile table can be deep enough that building its paths holds the event loop, so the size check never runs.
    test(
        'a paths table that fails its row checks is refused before a path is built from it',
        async () => {
            const dir = await extractFresh('extract-row-refused-');
            const folder = join(dir, folderName);
            const relMetadata = `home/mounts/${mountId}/metadata.db`;
            const db = new Database(join(folder, relMetadata));
            try {
                db.run("UPDATE paths SET size = 1 WHERE name = 'café ünïcode.png'");
                db.run("UPDATE paths SET trashedFrom = id WHERE name LIKE 'long-name-%'");
            } finally {
                db.close();
            }
            await restateManifestEntry(folder, relMetadata);

            const record = await verifyFolder(folder);
            expect(record.status).toBe('failed');
            expect(record.failures.join(' ')).toContain('was trashed from inside itself');
            expect(record.failures.join(' ')).not.toContain('its row says');
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'a sidecar that is not one reads as none, and an artifact that is not one is an error',
        async () => {
            const dir = mkdtempSync(join(TEST_DATA_DIR, 'bad-sidecar-'));
            const fake = join(dir, buildArtifactName(ownerId, new Date()));
            writeFileSync(`${fake}.manifest.json`, '{"manifest": {"formatVersion": 2}, "verify": {}}');
            expect(await readSidecar(fake)).toBeNull();

            const folder = join(dir, buildHomeFolderName('bogus'));
            mkdirSync(folder, { recursive: true });
            writeFileSync(join(folder, 'manifest.json'), 'not json at all');
            const bogus = join(dir, buildArtifactName('bogus', new Date()));
            await packFolder(folder, bogus);
            await expect(readArtifactManifest(bogus)).rejects.toThrow('is not an Eigen backup archive');
        },
        PACK_TIMEOUT_MS,
    );

    // A header alone, since the cap goes by the size it declares: no body has to follow, and none is collected.
    test('a manifest past the cap is refused by its size, before it is read', async () => {
        const artifact = join(TEST_DATA_DIR, 'oversize.tar.zst');
        const header = headerChunks('home-x/manifest.json', MANIFEST_CAP + 1, Date.now(), FILE_TYPEFLAG, 0o600);
        writeFileSync(artifact, Bun.zstdCompressSync(Buffer.concat([...header])));
        await expect(readArtifactManifest(artifact)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('this server reads'),
        });
    });

    test.skipIf(!HAS_ZSTD)('the artifact is a standard zstd frame', () => {
        // `zstd -t` decodes the whole frame and checks its checksums. Spawned straight, rather than
        // through `tar --zstd`, which forks zstd itself and turns any of its hiccups into a flake.
        const check = Bun.spawnSync(['zstd', '-t', artifact]);
        expect(check.stderr.toString()).not.toContain('ERROR');
        expect(check.success).toBe(true);
    });

    test.skipIf(!HAS_TAR)('system tar lists the artifact with the home folder at its root', async () => {
        const plain = join(mkdtempSync(join(TEST_DATA_DIR, 'tar-listing-')), 'artifact.tar');
        writeFileSync(plain, Bun.zstdDecompressSync(await Bun.file(artifact).bytes()));
        const listing = Bun.spawnSync(['tar', '-tf', plain]);
        expect(listing.stderr.toString()).toBe('');
        expect(listing.success).toBe(true);

        const paths = listing.stdout.toString().trim().split('\n');
        expect(paths).toContain(`${folderName}/manifest.json`);
        expect(paths).toContain(`${folderName}/${EMPTY_DIR}/`);
        // The pax path record, read back by a real tar rather than by the writer's own reader.
        expect(paths).toContain(`${folderName}/${longPath}`);
        expect(paths.every((p) => p.startsWith(`${folderName}/`))).toBe(true);
    });
});

describe('Backup verify stage 3 samples deterministically', () => {
    // Stage 3 decodes the ten largest collab documents plus ten more, so two verifies of one folder
    // have to judge the same twenty — otherwise the verdict on an archive changes between the backup
    // that wrote it and the restore that reads it, and an admin cannot act on either.
    const DOCUMENTS = 25;
    const SAMPLED = 20;
    let folder: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        const { id: userId, sessionToken: token } = await createTestUser(
            `verify-sample-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Verify Sample',
        );
        expect(ctx.app).toBeDefined();

        const sampleMountId = (
            await assertJson<{ id: string }[]>(await authedRequest(token, `/drive/${userId}/mounts`))
        )[0].id;
        const root = await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${sampleMountId}/root`));
        for (let i = 0; i < DOCUMENTS; i++) {
            await drivePost(token, userId, sampleMountId, `folder/${root.id}/create/doc`, {
                fileName: `Sample ${i}`,
            });
        }

        const target = mkdtempSync(join(TEST_DATA_DIR, 'sample-'));
        await snapshotHome(await getHome(userId), target);
        folder = join(target, buildHomeFolderName(userId));

        // Every document gets a blob that cannot decode, so the failures name exactly the documents
        // the sample picked — a random tail would name a different twenty on the second run.
        for (const rel of await listFiles(folder)) {
            if (!rel.endsWith('/data.db') || !rel.includes('.eigendoc/')) continue;
            const db = new Database(join(folder, rel));
            try {
                db.run("INSERT INTO doc_updates (updateData) VALUES (X'DEADBEEF')");
            } finally {
                db.close();
            }
            await restateManifestEntry(folder, rel);
        }
    }, PACK_TIMEOUT_MS);

    test(
        'two verifies of one folder judge the same documents',
        async () => {
            const first = await verifyFolder(folder);
            const second = await verifyFolder(folder);

            expect(first.status).toBe('failed');
            const decodeFailures = (record: typeof first) =>
                record.failures.filter((failure) => failure.includes('Yjs state could not be read')).sort();
            // A sample, not the whole set: fewer failures than documents, and the same ones twice.
            expect(decodeFailures(first).length).toBe(SAMPLED);
            expect(decodeFailures(second)).toEqual(decodeFailures(first));
        },
        PACK_TIMEOUT_MS,
    );
});

describe('Whole-server archive', () => {
    // Whole seconds: the member names carry the archive's stamp, and a stamp is a second wide.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const DKIM_FILES = ['eigen.private', 'eigen.txt'];
    const CERT_FILES = ['cert.pem', 'key.pem'];
    // appendInstallFiles reads the install's own folders under the data root.
    const dkimDir = join(TEST_DATA_DIR, 'dkim');
    const certsDir = join(TEST_DATA_DIR, 'certs');
    let dir: string;
    let archivePath: string;
    let manifest: ServerArchiveManifest;
    // Each home's member name and the standalone per-home artifact the same pack wrote.
    const homes: { ownerId: string; member: string; standalone: string }[] = [];

    beforeAll(async () => {
        const ctx = await getTestContext();
        const teamId = await createTeam(ctx, getServerConfig()!.orgId, `Archive Team ${Date.now()}`);
        dir = mkdtempSync(join(TEST_DATA_DIR, 'server-archive-'));
        archivePath = join(dir, buildServerArchiveName('manual', 'full-s3', at));
        const writer = await createServerArchiveWriter(archivePath);
        try {
            const serverStaging = mkdtempSync(join(TEST_DATA_DIR, 'server-member-'));
            await snapshotServer(serverStaging, at);
            const serverArtifact = join(dir, SERVER_ARCHIVE_SERVER_MEMBER);
            await packFolder(join(serverStaging, buildServerFolderName(at)), serverArtifact);
            await writer.appendFile(SERVER_ARCHIVE_SERVER_MEMBER, serverArtifact);

            const summaries: ServerArchiveManifest['homes'] = [];
            for (const ownerId of [ctx.alice.user.id, teamOwnerId(teamId)]) {
                const staging = mkdtempSync(join(TEST_DATA_DIR, 'home-member-'));
                const home = await snapshotHome(await getHome(ownerId), staging);
                const standalone = join(
                    mkdtempSync(join(TEST_DATA_DIR, 'standalone-')),
                    buildArtifactName(ownerId, at),
                );
                await packFolder(join(staging, buildHomeFolderName(ownerId)), standalone);
                const member = buildHomeMemberName(ownerId, at);
                await writer.appendFile(member, standalone);
                homes.push({ ownerId, member, standalone });
                const kind = home.kind === 'team' ? 'team' : 'user';
                summaries.push({ ownerId, kind, name: home.name, member, bytes: home.counts.bytes });
            }

            const envFile = join(dir, 'env.production');
            writeFileSync(envFile, 'DOMAIN=test.eigen.is\n');
            process.env['EIGEN_ENV_FILE'] = envFile;
            mkdirSync(dkimDir, { recursive: true });
            for (const name of DKIM_FILES) writeFileSync(join(dkimDir, name), `${name} bytes`);
            mkdirSync(certsDir, { recursive: true });
            for (const name of CERT_FILES) writeFileSync(join(certsDir, name), `${name} bytes`);
            // A temp file of a certificate being swapped in is not the certificate.
            writeFileSync(join(certsDir, 'key.pem.tmp'), 'half a key');
            const install = await appendInstallFiles(writer);
            expect(install).toEqual({ envFile: true, dkim: true, certs: true });

            manifest = await writer.finish({
                formatVersion: 1,
                level: 'full-s3',
                reason: 'manual',
                createdAt: at.toISOString(),
                appVersion: 'test',
                domain: 'test.eigen.is',
                homes: summaries,
                orphans: [],
                ...install,
                images: {},
            });
        } finally {
            await writer.abort();
            delete process.env['EIGEN_ENV_FILE'];
            rmSync(dkimDir, { recursive: true, force: true });
            rmSync(certsDir, { recursive: true, force: true });
        }
    }, PACK_TIMEOUT_MS);

    function memberNames(): string[] {
        return [
            SERVER_ARCHIVE_SERVER_MEMBER,
            ...homes.map((home) => home.member),
            SERVER_ARCHIVE_ENV_MEMBER,
            ...DKIM_FILES.map((name) => `dkim/${name}`),
            ...CERT_FILES.map((name) => `certs/${name}`),
            ARCHIVE_MANIFEST_FILE,
        ];
    }

    test('lists every member in order, the manifest last', async () => {
        const members = await hashArchiveMembers(archivePath);
        expect(members.map((member) => member.name)).toEqual(memberNames());
        expect(parseServerArchiveName(basename(archivePath))).toEqual({ reason: 'manual', level: 'full-s3', at });
    });

    test('the manifest lists every other member with its bytes and sha256', async () => {
        const members = await hashArchiveMembers(archivePath);
        const read = parseServerArchiveManifest(new TextDecoder().decode(await readArchiveMember(members.at(-1)!)));
        expect(read).toEqual(manifest);
        expect(read!.entries).toEqual(
            members.slice(0, -1).map((member) => ({ path: member.name, bytes: member.bytes, sha256: member.sha256 })),
        );
        // Against the source files, not only against the writer's own reader.
        for (const home of homes) {
            const entry = read!.entries.find((e) => e.path === home.member)!;
            expect(entry.sha256).toBe(await sha256Of(home.standalone));
        }
        const record = (await readServerArchive(archivePath)).verify;
        expect(record.failures).toEqual([]);
        expect(record.status).toBe('verified');
    });

    test(
        'each home member is its standalone per-home artifact, byte for byte, and verifies as one',
        async () => {
            const members = await hashArchiveMembers(archivePath);
            for (const home of homes) {
                const member = members.find((m) => m.name === home.member)!;
                const copy = join(mkdtempSync(join(TEST_DATA_DIR, 'member-copy-')), basename(member.name));
                await copyArchiveMember(member, copy);
                expect(Buffer.compare(readFileSync(copy), readFileSync(home.standalone))).toBe(0);

                const name = basename(member.name);
                expect(parseBackupArtifactName(name)).toEqual({ ownerId: home.ownerId, at });
                const unpackDir = mkdtempSync(join(TEST_DATA_DIR, 'member-extract-'));
                await unpackWhole(member, unpackDir);
                const { folder, manifest: inner } = readUnpackedHome(unpackDir, home.ownerId, name);
                expect(inner.ownerId).toBe(home.ownerId);
                const record = await verifyFolder(folder);
                expect(record.failures).toEqual([]);
            }
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'the server member extracts and verifies with its databases',
        async () => {
            const members = await hashArchiveMembers(archivePath);
            const unpackDir = mkdtempSync(join(TEST_DATA_DIR, 'server-extract-'));
            await unpackWhole(members.find((m) => m.name === SERVER_ARCHIVE_SERVER_MEMBER)!, unpackDir);
            const folder = join(unpackDir, buildServerFolderName(at));
            expect(existsSync(join(folder, 'server', SERVER_DATABASES.users))).toBe(true);
            const record = await verifyFolder(folder);
            expect(record.failures).toEqual([]);
            expect(record.status).toBe('verified');
        },
        PACK_TIMEOUT_MS,
    );

    test('a corrupted member fails the transport check, naming it', async () => {
        const members = await hashArchiveMembers(archivePath);
        const target = members.find((m) => m.name === homes[1].member)!;
        const bytes = await Bun.file(archivePath).bytes();
        const offset = target.offset + Math.floor(target.bytes / 2);
        bytes[offset] = bytes[offset] ^ 0xff;
        const corrupted = join(mkdtempSync(join(TEST_DATA_DIR, 'server-corrupt-')), basename(archivePath));
        writeFileSync(corrupted, bytes);

        const record = (await readServerArchive(corrupted)).verify;
        expect(record.status).toBe('failed');
        expect(record.failures).toEqual([`${homes[1].member}: sha256 does not match the manifest`]);
    });

    test(
        'a home member copied into the backups folder lists and restores as a per-home artifact',
        async () => {
            const { ownerId, member: memberName } = homes[1];
            const member = (await hashArchiveMembers(archivePath)).find((m) => m.name === memberName)!;
            const name = basename(memberName);
            await copyArchiveMember(member, join(getBackupsDir(), name));
            try {
                expect((await listArtifacts(ownerId)).map((artifact) => artifact.name)).toContain(name);
                await restoreHome(name, ownerId, `archive-member-restore-${Date.now()}`);
            } finally {
                rmSync(join(getBackupsDir(), name), { force: true });
            }
        },
        PACK_TIMEOUT_MS,
    );

    test('an unreadable env file, a missing DKIM folder and an unreadable TLS key are left out and say so', async () => {
        const small = join(mkdtempSync(join(TEST_DATA_DIR, 'server-install-')), 'archive.tar');
        const envFile = join(dir, 'unreadable.env');
        writeFileSync(envFile, 'SECRET=1\n');
        chmodSync(envFile, 0o000);
        process.env['EIGEN_ENV_FILE'] = envFile;
        // A certificate without its key restores nothing.
        mkdirSync(certsDir, { recursive: true });
        for (const name of CERT_FILES) writeFileSync(join(certsDir, name), `${name} bytes`);
        chmodSync(join(certsDir, 'key.pem'), 0o000);
        const writer = await createServerArchiveWriter(small);
        try {
            const install = await appendInstallFiles(writer);
            expect(install).toEqual({ envFile: false, dkim: false, certs: false });
            await writer.finish({ ...manifest, ...install });
        } finally {
            await writer.abort();
            delete process.env['EIGEN_ENV_FILE'];
            rmSync(certsDir, { recursive: true, force: true });
        }
        expect((await hashArchiveMembers(small)).map((member) => member.name)).toEqual(['manifest.json']);
    });

    test.skipIf(!HAS_TAR)('system tar lists the members in order', () => {
        const listing = Bun.spawnSync(['tar', '-tf', archivePath]);
        expect(listing.stderr.toString()).toBe('');
        expect(listing.success).toBe(true);
        expect(listing.stdout.toString().trim().split('\n')).toEqual(memberNames());
    });
});

describe('Archive writer and reader', () => {
    // What readArchiveMember holds in memory at most.
    const READ_CAP = 16 * 1024 * 1024;
    const fields: Omit<ServerArchiveManifest, 'entries'> = {
        formatVersion: 1,
        level: 'full',
        reason: 'manual',
        createdAt: new Date().toISOString(),
        appVersion: 'test',
        domain: 'test.eigen.is',
        homes: [],
        orphans: [],
        envFile: false,
        dkim: false,
        certs: false,
        images: {},
    };
    let dir: string;
    // Goes first in every archive, so no member under test starts at offset 0.
    let lead: string;

    beforeAll(() => {
        dir = mkdtempSync(join(TEST_DATA_DIR, 'archive-rw-'));
        lead = join(dir, 'lead.txt');
        writeFileSync(lead, 'lead member');
    });

    async function writeArchive(name: string, members: [string, string][]): Promise<string> {
        const archivePath = join(dir, name);
        const writer = await createServerArchiveWriter(archivePath);
        try {
            for (const [member, source] of members) await writer.appendFile(member, source);
            await writer.finish(fields);
        } finally {
            await writer.abort();
        }
        return archivePath;
    }

    test('a pax or GNU long-name header past 64 KiB is refused before it is read into memory', async () => {
        for (const typeflag of ['x', 'g', 'L']) {
            const size = 64 * 1024 + 1;
            const header = Buffer.alloc(512);
            header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
            header.write(typeflag, 156);
            const archivePath = join(dir, `long-header-${typeflag}.tar`);
            writeFileSync(archivePath, Buffer.concat([header, Buffer.alloc(Math.ceil(size / 512) * 512 + 1024)]));
            await expect(hashArchiveMembers(archivePath)).rejects.toThrow('header');
        }
    });

    test('a member past the read cap is refused in memory and streamed out byte for byte', async () => {
        const big = join(dir, 'big.bin');
        const bytes = new Uint8Array(READ_CAP + 1);
        for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251;
        writeFileSync(big, bytes);
        const archivePath = await writeArchive('big.tar', [
            ['lead.txt', lead],
            ['big.bin', big],
        ]);
        const member = (await hashArchiveMembers(archivePath)).find((m) => m.name === 'big.bin')!;
        await expect(readArchiveMember(member)).rejects.toThrow('big.bin');

        const dest = join(dir, 'big-copy.bin');
        const readStream = spyOn(fs, 'createReadStream');
        try {
            await copyArchiveMember(member, dest);
            expect(readStream).toHaveBeenCalledWith(archivePath, {
                start: member.offset,
                end: member.offset + member.bytes - 1,
            });
        } finally {
            readStream.mockRestore();
        }
        expect(fs.statSync(dest).size).toBe(bytes.length);
        expect(await sha256Of(dest)).toBe(await sha256Of(big));
    });

    test('an empty member copies out as an empty file', async () => {
        const empty = join(dir, 'empty.txt');
        writeFileSync(empty, '');
        const archivePath = await writeArchive('empty.tar', [
            ['lead.txt', lead],
            ['empty.txt', empty],
        ]);
        const member = (await hashArchiveMembers(archivePath)).find((m) => m.name === 'empty.txt')!;
        const dest = join(dir, 'empty-copy.txt');
        await copyArchiveMember(member, dest);
        expect(fs.statSync(dest).size).toBe(0);
    });

    test('a member whose range runs past the end of the archive fails its copy and leaves no file', async () => {
        const archivePath = await writeArchive('cut.tar', [['lead.txt', lead]]);
        const member = (await hashArchiveMembers(archivePath)).find((m) => m.name === 'lead.txt')!;
        fs.truncateSync(archivePath, member.offset + 4);
        const dest = join(dir, 'cut-copy.txt');
        await expect(copyArchiveMember(member, dest)).rejects.toThrow('lead.txt');
        expect(existsSync(dest)).toBe(false);
    });

    test('a read error mid-copy fails the copy and leaves no file', async () => {
        const archivePath = await writeArchive('broken.tar', [['lead.txt', lead]]);
        const member = (await hashArchiveMembers(archivePath)).find((m) => m.name === 'lead.txt')!;
        const dest = join(dir, 'broken-copy.txt');
        const realCreateReadStream = fs.createReadStream;
        const readStream = spyOn(fs, 'createReadStream').mockImplementation((path, options) => {
            const stream = realCreateReadStream(path, options);
            stream.once('data', () => stream.destroy(new Error('injected read failure')));
            return stream;
        });
        try {
            await expect(copyArchiveMember(member, dest)).rejects.toThrow('injected read failure');
        } finally {
            readStream.mockRestore();
        }
        expect(existsSync(dest)).toBe(false);
    });

    test('abort removes a half-written archive and leaves a finished one alone', async () => {
        const partial = join(dir, 'partial.tar');
        const writer = await createServerArchiveWriter(partial);
        await writer.appendFile('lead.txt', lead);
        await writer.abort();
        expect(existsSync(partial)).toBe(false);

        const finished = await writeArchive('finished.tar', [['lead.txt', lead]]);
        expect((await hashArchiveMembers(finished)).map((m) => m.name)).toEqual(['lead.txt', 'manifest.json']);
    });

    test('two members of one name fail the transport check', async () => {
        const archivePath = await writeArchive('duplicate.tar', [
            ['lead.txt', lead],
            ['lead.txt', lead],
        ]);
        const record = (await readServerArchive(archivePath)).verify;
        expect(record.status).toBe('failed');
        expect(record.failures).toEqual(['lead.txt: appears more than once in the archive']);
    });

    test('a last member named manifest.json past the read cap fails the transport check', async () => {
        const big = join(dir, 'big-manifest.json');
        writeFileSync(big, new Uint8Array(READ_CAP + 1));
        // finish() would put the real manifest after it, so the archive is taken before it closes.
        const building = join(dir, 'big-manifest-building.tar');
        const archivePath = join(dir, 'big-manifest.tar');
        const writer = await createServerArchiveWriter(building);
        try {
            await writer.appendFile('lead.txt', lead);
            await writer.appendFile('manifest.json', big);
            fs.copyFileSync(building, archivePath);
        } finally {
            await writer.abort();
        }
        const record = (await readServerArchive(archivePath)).verify;
        expect(record.status).toBe('failed');
    });
});

// What an unpack is allowed to write is what the manifest declares, counted the way the unpack counts it: the bytes of
// every entry, the manifest's own, and an allowance for every file and every folder it counts, which take the disk's
// blocks with no bytes of their own.
describe('The unpack bound', () => {
    const FILES = 2000;
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(TEST_DATA_DIR, 'unpack-bound-'));
    });

    // A home of many empty files, so its manifest outweighs them, and `emptyFolders` empty folders. `counted` is how
    // many of those its manifest counts.
    async function packHome(
        name: string,
        { emptyFolders, counted = emptyFolders }: { emptyFolders: number; counted?: number },
    ): Promise<{ artifact: string; manifest: BackupManifest; folder: string }> {
        const folder = join(dir, name, buildHomeFolderName('unpackbound'));
        const entries = Array.from({ length: FILES }, (_, index) => ({
            path: `home/notes/${index % 10}/note-${index}.txt`,
            bytes: 0,
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        }));
        for (const entry of entries) {
            mkdirSync(join(folder, entry.path, '..'), { recursive: true });
            writeFileSync(join(folder, entry.path), '');
        }
        const makeEmptyFolders = (from: number, to: number) => {
            for (let index = from; index < to; index++)
                mkdirSync(join(folder, 'home', 'empty', `${index}`), { recursive: true });
        };
        makeEmptyFolders(0, counted);
        const dirs = countPackedFolders(folder);
        makeEmptyFolders(counted, emptyFolders);
        const manifest: BackupManifest = {
            formatVersion: 1,
            kind: 'user',
            ownerId: 'unpackbound',
            name: 'Unpack bound',
            createdAt: new Date().toISOString(),
            appVersion: 'test',
            server: { domain: 'test.eigen.is', orgId: 'org' },
            counts: { databases: 0, files: FILES, bytes: 0, dirs },
            level: 'full-s3',
            mounts: [],
            entries,
        };
        writeFileSync(join(folder, ARCHIVE_MANIFEST_FILE), serializeManifest(manifest));
        const artifact = join(dir, `${name}.tar.zst`);
        await packFolder(folder, artifact);
        return { artifact, manifest, folder };
    }

    test(
        'an archive that holds what its manifest lists unpacks within it, the manifest itself and every folder counted',
        async () => {
            const { artifact, manifest } = await packHome('exact', { emptyFolders: 50 });
            // The manifest alone weighs more than the files it lists.
            expect(Buffer.byteLength(serializeManifest(manifest))).toBeGreaterThan(100 * FILES);
            await extractArtifact(artifact, join(dir, 'exact-out'), declaredUnpackBytes(manifest));
            await expect(
                extractArtifact(artifact, join(dir, 'exact-short'), declaredUnpackBytes(manifest) - 1),
            ).rejects.toThrow(/more than its manifest declares/);
            expect(existsSync(join(dir, 'exact-short'))).toBe(false);
        },
        PACK_TIMEOUT_MS,
    );

    // Our writer lists a folder before what sits in it, so a parent nothing listed is a crafted archive's way to make
    // folders its manifest never counted.
    test('an entry whose folder has not come yet is refused, and leaves nothing', async () => {
        const tarOf = (...chunks: Iterable<Uint8Array>[]) => Buffer.concat(chunks.flatMap((part) => [...part]));
        const rootEntry = () => headerChunks('root/', 0, Date.now(), DIRECTORY_TYPEFLAG, 0o700);
        const crafted = {
            file: tarOf(rootEntry(), headerChunks('root/a/b/c.txt', 0, Date.now(), FILE_TYPEFLAG, 0o600)),
            folder: tarOf(rootEntry(), headerChunks('root/a/b/', 0, Date.now(), DIRECTORY_TYPEFLAG, 0o700)),
        };
        for (const [name, tar] of Object.entries(crafted)) {
            const artifact = join(dir, `implicit-${name}.tar.zst`);
            writeFileSync(artifact, Bun.zstdCompressSync(tar));
            const out = join(dir, `implicit-${name}-out`);
            await expect(extractArtifact(artifact, out, 1e9)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(existsSync(out)).toBe(false);
        }
    });

    // The manifest decides how much a verify may write, and it can be crafted, so the room is checked on the disk the
    // verify unpacks on, the backups folder's.
    test(
        'a verify of an archive that declares more than the disk holds is refused before it unpacks',
        async () => {
            const { manifest, folder } = await packHome('declared', { emptyFolders: 0 });
            const declared = { ...manifest, counts: { ...manifest.counts, bytes: 1e15 } };
            writeFileSync(join(folder, ARCHIVE_MANIFEST_FILE), serializeManifest(declared));
            const name = buildArtifactName(manifest.ownerId, new Date());
            await packFolder(folder, join(getBackupsDir(), name));
            const job: BackupJob = {
                id: crypto.randomUUID(),
                kind: 'verify',
                ownerId: manifest.ownerId,
                state: 'running',
                progress: { step: 'starting', done: 0, total: 0 },
                startedAt: new Date(),
            };
            try {
                await expect(runArtifactVerify(name, job, () => {})).rejects.toMatchObject({ status: 507 });
            } finally {
                rmSync(join(getBackupsDir(), name), { force: true });
            }
        },
        PACK_TIMEOUT_MS,
    );

    test(
        'an archive with more folders than its manifest counts is refused, though they hold no bytes',
        async () => {
            const { artifact, manifest } = await packHome('folders', { emptyFolders: 50, counted: 10 });
            await expect(
                extractArtifact(artifact, join(dir, 'folders-out'), declaredUnpackBytes(manifest)),
            ).rejects.toThrow(/more than its manifest declares/);
            expect(existsSync(join(dir, 'folders-out'))).toBe(false);
        },
        PACK_TIMEOUT_MS,
    );
});

// A home can hold tens of thousands of databases, and each quick_check blocks the thread. A restore verifies in the API,
// so other requests run between every few databases.
describe('verifyFolder', () => {
    // The verify of a backup reads the manifest through the same cap, so a home past it finds out when it is backed up.
    test('a folder whose manifest is past the cap is refused', async () => {
        const folder = mkdtempSync(join(TEST_DATA_DIR, 'verify-cap-'));
        writeFileSync(join(folder, 'manifest.json'), '');
        truncateSync(join(folder, 'manifest.json'), MANIFEST_CAP + 1);
        try {
            await expect(verifyFolder(folder)).rejects.toMatchObject({
                status: 400,
                message: expect.stringContaining('this server reads'),
            });
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test('lets other work run while it checks the databases', async () => {
        const folder = mkdtempSync(join(TEST_DATA_DIR, 'verify-yield-'));
        const manifest: BackupManifest = {
            formatVersion: 1,
            kind: 'user',
            ownerId: 'verifyyieldAAAAAAAAAAAAAAAAAAAAA',
            name: 'yield',
            createdAt: new Date().toISOString(),
            appVersion: 'test',
            server: { domain: 'test', orgId: 'test' },
            counts: { databases: 0, files: 0, bytes: 0, dirs: 0 },
            mounts: [],
            entries: [],
        };
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
        for (let index = 0; index < 120; index++) {
            mkdirSync(join(folder, 'home', 'mounts', `m${index}`), { recursive: true });
            new Database(join(folder, 'home', 'mounts', `m${index}`, 'metadata.db')).close();
        }
        const turns = countLoopTurns();
        const turnsAt: number[] = [];
        try {
            await verifyFolder(folder, (step) => {
                if (step === 'verify databases') turnsAt.push(turns.read());
            });
        } finally {
            turns.stop();
            rmSync(folder, { recursive: true, force: true });
        }
        expect(turnsAt).toHaveLength(120);
        expect(turnsAt.at(-1)).toBeGreaterThan(turnsAt[0]);
    });
});
