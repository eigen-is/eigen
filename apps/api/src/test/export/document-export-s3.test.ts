import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home';
import { openZip } from '../../lib/ooxml/zip';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount } from '../fault-storage-helpers';
import { buildGoldenDocJson, GOLDEN_MEDIA_NAME, seedDocumentMedia, seedEigendoc } from '../fixtures/golden-documents';
import { authedRequest, getTestContext, TEST_PNG_BYTES } from '../setup';

// A doc export whose embedded image comes over Bun's real S3 client from a fake S3.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-document-export-s3-${Date.now()}`);
const MOUNT_ID = 'export-s3';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let s3: FakeS3Mount;
let docPath: DrivePath;
let mediaId: string;
let mediaKey: string;

beforeAll(async () => {
    ctx = await getTestContext();
    mkdirSync(TEST_DIR, { recursive: true });
    const home = await getHome(ctx.alice.user.id);
    s3 = await createFakeS3Mount(home, TEST_DIR, MOUNT_ID);
    const { drive, mount } = s3;

    docPath = await drive.create(MOUNT_ID, (await mount.getRootFolder())!.id, 'S3 Doc', 'doc', home.user);
    seedEigendoc((await drive.getCollabDocument(MOUNT_ID, docPath.id)).doc, buildGoldenDocJson());
    mediaId = await seedDocumentMedia(mount, docPath, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    // Uploaded, so the export reads the image from the bucket and not from its staged copy.
    await mount.uploadQueue?.drain({ flushNow: true });
    mediaKey = await mount.getStorageKey(mediaId);
});

afterAll(async () => {
    await removeFakeS3Mount(s3, [docPath.id]);
    rmSync(TEST_DIR, { recursive: true, force: true });
});

function exportRequest(format: string): Promise<Response> {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${MOUNT_ID}/file/${docPath.id}/export/${format}`,
    );
}

describe('Eigendoc export from an S3 mount', () => {
    test('a docx export whose image HEAD answers 503 SlowDown once still embeds the image', async () => {
        s3.fake.slowDowns.set(mediaKey, 1);
        const res = await exportRequest('docx');
        expect(res.status).toBe(200);
        const zip = openZip(new Uint8Array(await res.arrayBuffer()));
        expect(zip.names()).toContain('word/media/image1.jpeg');
        expect(s3.fake.heads.get(mediaKey)).toBe(2);
    }, 120_000);

    test('an html export inlines the image its screen preview reads from the bucket', async () => {
        const before = s3.fake.gets.get(mediaKey) ?? 0;
        const res = await exportRequest('html');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('src="data:image/');
        expect(s3.fake.gets.get(mediaKey) ?? 0).toBeGreaterThan(before);
    }, 120_000);
});

const pdfSuite = (await isWeasyPrintAvailable()) ? describe : describe.skip;

pdfSuite('Eigendoc PDF export from an S3 mount', () => {
    test('a pdf export draws the image from the bucket', async () => {
        // The html case leaves the screen preview in the local cache, which would spare the bucket its read.
        for (const name of readdirSync(s3.mount.previewsDir)) {
            if (name.startsWith(`${mediaId}-`)) rmSync(join(s3.mount.previewsDir, name));
        }
        const before = s3.fake.gets.get(mediaKey) ?? 0;
        const res = await exportRequest('pdf');
        expect(res.status).toBe(200);
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(pdf.toString('latin1')).toContain('/Subtype /Image');
        expect(s3.fake.gets.get(mediaKey) ?? 0).toBeGreaterThan(before);
    }, 120_000);
});
