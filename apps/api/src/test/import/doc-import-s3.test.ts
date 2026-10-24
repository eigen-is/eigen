import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { readEigendocFromDoc } from '../../lib/document/doc';
import { getHome } from '../../lib/home';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount } from '../fault-storage-helpers';
import { buildGoldenDocx, GOLDEN_DOCX_IMAGE_NAME } from '../fixtures/golden-docx';
import { assertJson, authedRequest, collectSSE, getTestContext, TEST_PNG_BYTES } from '../setup';

// A docx import into a doc on an S3 mount: its image goes through Drive into the bucket and reads back from it.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-doc-import-s3-${Date.now()}`);
const MOUNT_ID = 'import-s3';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let s3: FakeS3Mount;
let docPath: DrivePath;

beforeAll(async () => {
    ctx = await getTestContext();
    mkdirSync(TEST_DIR, { recursive: true });
    const home = await getHome(ctx.alice.user.id);
    s3 = await createFakeS3Mount(home, TEST_DIR, MOUNT_ID);
    docPath = await s3.drive.create(MOUNT_ID, (await s3.mount.getRootFolder())!.id, 'S3 Doc', 'doc', home.user);
});

afterAll(async () => {
    await removeFakeS3Mount(s3, [docPath.id]);
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Eigendoc docx import into an S3 mount', () => {
    test('the image lands in the bucket byte for byte, the doc names it, and its drive event fires', async () => {
        const sse = await collectSSE(ctx.alice.user.id);
        try {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${MOUNT_ID}/file/${docPath.id}/import?mode=replace`,
                { method: 'POST', body: await buildGoldenDocx(TEST_PNG_BYTES) },
            );
            expect((await assertJson<{ success: boolean }>(res)).success).toBe(true);
        } finally {
            sse.stop();
        }
        const { mount, drive } = s3;
        // Uploaded, so the read below comes from the bucket and not from the staged copy.
        await mount.drainPendingUploads({ flushNow: true });
        const mediaFolder = await mount.getChildByName(docPath.id, 'media');
        const [image] = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
        if (!image) throw new Error('media/ holds no picture');
        expect(image.name).toMatch(GOLDEN_DOCX_IMAGE_NAME);
        const key = await mount.getStorageKey(image.id);
        const before = s3.fake.gets.get(key) ?? 0;
        const file = await mount.readFile(image.id);
        if (!file) throw new Error(`${image.name} unreadable`);
        expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(TEST_PNG_BYTES));
        expect(s3.fake.gets.get(key) ?? 0).toBeGreaterThan(before);

        const json = readEigendocFromDoc((await drive.getCollabDocument(MOUNT_ID, docPath.id)).doc);
        expect(JSON.stringify(json)).toContain(image.name);
        expect(
            sse.events.some((event) => event.type === SSEventType.DRIVE_FILE_UPLOADED && event.path.id === image.id),
        ).toBe(true);
    }, 120_000);
});
