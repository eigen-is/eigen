import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { openZip } from '../../lib/core/zip';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { FakeS3Server } from '../fake-s3-server';
import {
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    registerFaultMount,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import { buildGoldenDocJson, GOLDEN_MEDIA_NAME, seedDocumentMedia, seedEigendoc } from '../fixtures/golden-documents';
import { authedRequest, getTestContext, TEST_PNG_BYTES } from '../setup';

// A doc export whose embedded image comes over Bun's real S3 client from a fake S3.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-document-export-s3-${Date.now()}`);
const MOUNT_ID = 'export-s3';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let fake: FakeS3Server;
let drive: Drive;
let mount: Mount;
let docPath: DrivePath;
let mediaKey: string;

beforeAll(async () => {
    ctx = await getTestContext();
    mkdirSync(TEST_DIR, { recursive: true });
    fake = new FakeS3Server(new LocalStorage(join(TEST_DIR, 'backing')));
    const s3Config = await fake.start();

    const home = await getHome(ctx.alice.user.id);
    drive = home.drive;
    mount = new FaultMount(
        ctx.alice.user.id,
        TEST_DIR,
        { ...createS3MountConfig(MOUNT_ID), s3Config },
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
    registerFaultMount(drive, mount);

    docPath = await drive.create(MOUNT_ID, (await mount.getRootFolder())!.id, 'S3 Doc', 'doc', home.user);
    seedEigendoc((await drive.getCollabDocument(MOUNT_ID, docPath.id)).doc, buildGoldenDocJson());
    await seedDocumentMedia(mount, docPath, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    // Uploaded, so the export reads the image from the bucket and not from its staged copy.
    await mount.drainPendingUploads({ flushNow: true });
    const media = (await mount.getChildByName(docPath.id, 'media'))!;
    mediaKey = await mount.getStorageKey((await mount.getChildByName(media.id, GOLDEN_MEDIA_NAME))!.id);
});

afterAll(async () => {
    fake.heal();
    await drive.closeCollabDocument(MOUNT_ID, docPath.id).catch(() => {});
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    await fake.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Eigendoc export from an S3 mount', () => {
    test('a docx export whose image HEAD answers 503 SlowDown once still embeds the image', async () => {
        fake.slowDowns.set(mediaKey, 1);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT_ID}/file/${docPath.id}/export/docx`,
        );
        expect(res.status).toBe(200);
        const zip = openZip(new Uint8Array(await res.arrayBuffer()));
        expect(zip.names()).toContain('word/media/image1.png');
        expect(fake.heads.get(mediaKey)).toBe(2);
    }, 120_000);
});
