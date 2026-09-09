import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { extractArtifact, packFolder, readArtifactManifest, readSidecar, writeSidecar } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { verifyFolder } from '../../lib/backup/verify';
import { getHome } from '../../lib/home/get-home';
import {
    assertJson,
    authedRequest,
    drivePost,
    driveUpload,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const DOC_PROBE = 'pack-verify-probe';
const EMPTY_DIR = 'home/eigen.mail/Maildir/.Empty/cur';

// Evaluated at registration time, so a machine without these tools skips the tests outright rather
// than passing them without asserting anything.
const HAS_TAR = Bun.which('tar') !== null;
const HAS_ZSTD = Bun.which('zstd') !== null;

function syncUpdateMessage(doc: Y.Doc): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collabDocument.ts)
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
    });

    async function extractFresh(prefix: string, glob?: string): Promise<string> {
        const dir = mkdtempSync(join(TEST_DATA_DIR, prefix));
        await extractArtifact(artifact, dir, glob);
        return dir;
    }

    test('packs into a .tar.zst and verifies a fresh extract', async () => {
        expect(Bun.file(artifact).size).toBeGreaterThan(0);
        const dir = await extractFresh('extract-ok-');
        const record = await verifyFolder(join(dir, folderName));
        expect(record.failures).toEqual([]);
        expect(record.status).toBe('verified');
        expect(record.checkedAt).toBeTruthy();
    });

    test('an empty directory survives pack and extract', async () => {
        const dir = await extractFresh('extract-dirs-');
        expect(existsSync(join(dir, folderName, EMPTY_DIR))).toBe(true);
    });

    test('verifying a folder does not change a byte of it', async () => {
        const dir = await extractFresh('extract-stable-');
        const folder = join(dir, folderName);
        const before = await hashTree(folder);
        const record = await verifyFolder(folder);
        expect(record.status).toBe('verified');
        // A read-write open of a container data.db would leave a journal beside it and change the
        // very hashes stage 1 just checked.
        expect(await listFiles(folder)).toEqual(await listFiles(folder));
        expect(await hashTree(folder)).toBe(before);
    });

    test('the extracted folder holds the same bytes as the snapshot', async () => {
        const dir = await extractFresh('extract-bytes-');
        const files = await listFiles(join(dir, folderName));
        expect(files).toEqual([...manifest.entries.map((e) => e.path), 'manifest.json'].sort());
        for (const entry of manifest.entries) {
            expect(await sha256Of(join(dir, folderName, entry.path))).toBe(entry.sha256);
        }
    });

    test('a flipped byte in a database fails stage 1, naming the entry', async () => {
        const dir = await extractFresh('extract-flip-');
        const target = join(dir, folderName, sheetDataDb);
        const bytes = readFileSync(target);
        const offset = Math.floor(bytes.length / 2);
        bytes[offset] = bytes[offset] ^ 0xff;
        writeFileSync(target, bytes);

        const record = await verifyFolder(join(dir, folderName));
        expect(record.status).toBe('failed');
        expect(record.failures.some((f) => f.includes(sheetDataDb) && f.includes('sha256'))).toBe(true);
    });

    test('a file the manifest does not list fails stage 1', async () => {
        const dir = await extractFresh('extract-extra-');
        const folder = join(dir, folderName);
        writeFileSync(join(folder, 'home/stowaway.txt'), 'not in the manifest');

        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures).toContain('home/stowaway.txt: not in the manifest');
    });

    test('a structurally broken database fails stage 2', async () => {
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
    });

    test('a manifest entry pointing outside the folder fails stage 1 and is never read', async () => {
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
    });

    test('a manifest that is not a version 1 manifest fails the whole verify', async () => {
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
            expect(record.failures).toEqual(['manifest.json is not a version 1 backup manifest']);
        }
    });

    test('a valid but empty data.db fails stage 3', async () => {
        const dir = await extractFresh('extract-empty-');
        const folder = join(dir, folderName);
        const target = join(folder, docDataDb);
        // Padded past every other data.db in the folder, so the stage-3 sample (ten largest plus ten
        // at random) is certain to reach it.
        const largest = Math.max(...manifest.entries.filter((e) => e.path.endsWith('/data.db')).map((e) => e.bytes));
        const empty = new Database(target, { create: true, readwrite: true });
        empty.run('PRAGMA journal_mode = DELETE');
        empty.run('DROP TABLE IF EXISTS doc_updates');
        empty.run('DROP TABLE IF EXISTS doc_snapshots');
        empty.run('CREATE TABLE filler (bytes BLOB)');
        empty.run(`INSERT INTO filler VALUES (zeroblob(${largest + 4096}))`);
        empty.run('VACUUM');
        empty.close();

        // Stage 1 must pass, so the manifest entry is re-stated for the replacement bytes.
        await restateManifestEntry(folder, docDataDb);

        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures).toContain(`${docDataDb}: the Yjs state could not be read (no such table: doc_updates)`);
        expect(record.failures.some((f) => f.includes('sha256') || f.includes('missing'))).toBe(false);
    });

    test('blobs that decode to a document with no content fail stage 3', async () => {
        const dir = await extractFresh('extract-hollow-');
        const folder = join(dir, folderName);
        const target = join(folder, sheetDataDb);
        // One update row holding the encoding of an empty Y.Doc: the blobs decode fine, and there is
        // nothing in the document they describe.
        const hollow = new Database(target, { readwrite: true });
        hollow.run('DELETE FROM doc_updates');
        hollow.run('DELETE FROM doc_snapshots');
        hollow.query('INSERT INTO doc_updates (updateData) VALUES (?)').run(Y.encodeStateAsUpdate(new Y.Doc()));
        hollow.close();
        await restateManifestEntry(folder, sheetDataDb);

        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures).toContain(`${sheetDataDb}: its Yjs blobs decode to an empty document`);
    });

    test('readArtifactManifest reads the manifest without a full extract', async () => {
        const read = await readArtifactManifest(artifact);
        expect(read).toEqual(JSON.parse(JSON.stringify(manifest)));
    });

    test('the sidecar round-trips and is null when missing', async () => {
        expect(await readSidecar(artifact)).toBeNull();
        const verify = { status: 'verified' as const, checkedAt: new Date().toISOString(), failures: [] };
        await writeSidecar(artifact, manifest, verify);
        expect(existsSync(`${artifact}.manifest.json`)).toBe(true);
        const read = await readSidecar(artifact);
        expect(read?.verify).toEqual(verify);
        expect(read?.manifest).toEqual(JSON.parse(JSON.stringify(manifest)));
    });

    test('a sidecar that is not one is an error, an artifact that is not one too', async () => {
        const dir = mkdtempSync(join(TEST_DATA_DIR, 'bad-sidecar-'));
        const fake = join(dir, buildArtifactName(ownerId, new Date()));
        writeFileSync(`${fake}.manifest.json`, '{"manifest": {"formatVersion": 2}, "verify": {}}');
        await expect(readSidecar(fake)).rejects.toThrow('is not a backup manifest sidecar');

        const folder = join(dir, buildHomeFolderName('bogus'));
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'manifest.json'), 'not json at all');
        const bogus = join(dir, buildArtifactName('bogus', new Date()));
        await packFolder(folder, bogus);
        await expect(readArtifactManifest(bogus)).rejects.toThrow('is not an Eigen backup archive');
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

    test('extractArtifact with a glob extracts only the matching subtree', async () => {
        const dir = await extractFresh('extract-glob-', `${folderName}/home/mounts/${mountId}/**`);
        const files = await listFiles(dir);
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((f) => f.startsWith(`${folderName}/home/mounts/${mountId}/`))).toBe(true);
    });
});
