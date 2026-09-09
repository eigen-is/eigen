import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

async function sha256Of(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
    return hasher.digest('hex');
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
        const manifestPath = join(folder, 'manifest.json');
        const patched: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const entry = patched.entries.find((e) => e.path === docDataDb)!;
        entry.bytes = Bun.file(target).size;
        entry.sha256 = await sha256Of(target);
        writeFileSync(manifestPath, JSON.stringify(patched, null, 2));

        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures.some((f) => f.includes(docDataDb))).toBe(true);
        expect(record.failures.some((f) => f.includes('sha256') || f.includes('missing'))).toBe(false);
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

    test('system tar lists the artifact with the home folder at its root', async () => {
        const listing = Bun.spawnSync(['tar', '--zstd', '-tf', artifact]);
        if (!listing.success) {
            console.warn(`Skipped: system tar cannot read zstd (${listing.stderr.toString().trim()})`);
            return;
        }
        const paths = listing.stdout.toString().trim().split('\n');
        expect(paths).toContain(`${folderName}/manifest.json`);
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
