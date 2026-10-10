import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { openZip } from '../../lib/core/zip';
import { getHome } from '../../lib/home';
import { createFakeS3Mount, type FakeS3Mount, removeFakeS3Mount } from '../fault-storage-helpers';
import { buildGoldenDocJson, GOLDEN_MEDIA_NAME, seedDocumentMedia, seedEigendoc } from '../fixtures/golden-documents';
import { authedRequest, getTestContext, TEST_PNG_BYTES } from '../setup';

// A doc export whose embedded image comes over Bun's real S3 client from a fake S3.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-document-export-s3-${Date.now()}`);
const MOUNT_ID = 'export-s3';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let s3: FakeS3Mount;
let docPath: DrivePath;
let mediaKey: string;

beforeAll(async () => {
    ctx = await getTestContext();
    mkdirSync(TEST_DIR, { recursive: true });
    const home = await getHome(ctx.alice.user.id);
    s3 = await createFakeS3Mount(home, TEST_DIR, MOUNT_ID);
    const { drive, mount } = s3;

    docPath = await drive.create(MOUNT_ID, (await mount.getRootFolder())!.id, 'S3 Doc', 'doc', home.user);
    seedEigendoc((await drive.getCollabDocument(MOUNT_ID, docPath.id)).doc, buildGoldenDocJson());
    const mediaId = await seedDocumentMedia(mount, docPath, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    // Uploaded, so the export reads the image from the bucket and not from its staged copy.
    await mount.drainPendingUploads({ flushNow: true });
    mediaKey = await mount.getStorageKey(mediaId);
});

afterAll(async () => {
    await removeFakeS3Mount(s3, [docPath.id]);
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Eigendoc export from an S3 mount', () => {
    test('a docx export whose image HEAD answers 503 SlowDown once still embeds the image', async () => {
        s3.fake.slowDowns.set(mediaKey, 1);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT_ID}/file/${docPath.id}/export/docx`,
        );
        expect(res.status).toBe(200);
        const zip = openZip(new Uint8Array(await res.arrayBuffer()));
        expect(zip.names()).toContain('word/media/image1.png');
        expect(s3.fake.heads.get(mediaKey)).toBe(2);
    }, 120_000);
});
