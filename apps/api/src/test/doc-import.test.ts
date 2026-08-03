import { beforeAll, describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import type { DrivePath } from '@workspace/lib/types/drive';
import { readEigendocFromDoc } from '../lib/document/doc';
import { toTransferableBuffer } from '../lib/document/transform/protocol';
import { getHome } from '../lib/home/get-home';
import { seedEigendoc } from './fixtures/golden-documents';
import { buildGoldenDocx, GOLDEN_DOCX_HEADING, GOLDEN_DOCX_IMAGE_NAME, GOLDEN_DOCX_LINK } from './fixtures/golden-docx';
import { assertJson, authedRequest, driveGet, drivePost, driveUpload, getTestContext, TEST_PNG_BYTES } from './setup';

// Route contract of docx import and conversion: what lands in the document, what
// the media folder gets, and the exact error statuses and bodies. Pinned here so
// moving the parsing and the ProseMirror-to-Yjs conversion into the
// document-transform Worker cannot change what the routes hand back.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
const mountId = 'default';
let rootId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
});

async function upload(bytes: ArrayBuffer | string, fileName: string, type = DOCX_MIME): Promise<DrivePath> {
    return driveUpload<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        rootId,
        new File([bytes], fileName, { type }),
    );
}

function convertRequest(pathId: string, targetType = 'eigendoc'): Promise<Response> {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/convert/${targetType}`,
        { method: 'POST' },
    );
}

function importRequest(pathId: string, body: ArrayBuffer): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import`, {
        method: 'POST',
        body,
    });
}

async function readDocJson(pathId: string): Promise<JSONContent> {
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, pathId);
    return readEigendocFromDoc(collab.doc);
}

async function readDocMedia(pathId: string, name: string): Promise<Buffer> {
    const home = await getHome(ctx.alice.user.id);
    const { mount, path } = await home.drive.resolveFile(mountId, pathId);
    const mediaFolder = await mount.getChildByName(path.id, 'media');
    if (!mediaFolder) throw new Error('media folder missing');
    const image = await mount.getChildByName(mediaFolder.id, name);
    if (!image) throw new Error(`${name} missing from media/`);
    const file = await mount.readFile(image.id);
    if (!file) throw new Error(`${name} unreadable`);
    return Buffer.from(await file.arrayBuffer());
}

async function setMaxUploadSizeMB(mb: number): Promise<void> {
    const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotas: { maxUploadSizeMB: mb } }),
    });
    expect(res.status).toBe(200);
}

// Node types the document carries, flattened for order-independent assertions.
function nodeTypes(json: JSONContent): string[] {
    return (json.content ?? []).map((node) => node.type ?? '');
}

describe('Eigendoc docx import/convert', () => {
    test('convert .docx to eigendoc replicates the document content and media', async () => {
        const uploaded = await upload(await buildGoldenDocx(TEST_PNG_BYTES), 'report.docx');
        const converted = await assertJson<DrivePath>(await convertRequest(uploaded.id));
        expect(converted.type).toBe('doc');
        expect(converted.name).toBe('report.eigendoc');
        expect(converted.parentId).toBe(rootId);

        const json = await readDocJson(converted.id);
        expect(nodeTypes(json)).toEqual(['heading', 'paragraph', 'bulletList', 'paragraph']);
        expect(JSON.stringify(json)).toContain(GOLDEN_DOCX_HEADING);
        expect(JSON.stringify(json)).toContain(GOLDEN_DOCX_LINK);
        // The figure references the extracted image by media name, and the bytes
        // land in the container's media/ folder unchanged.
        expect(JSON.stringify(json)).toContain(GOLDEN_DOCX_IMAGE_NAME);
        expect(await readDocMedia(converted.id, GOLDEN_DOCX_IMAGE_NAME)).toEqual(Buffer.from(TEST_PNG_BYTES));
    }, 120_000);

    test('import .docx replaces the existing eigendoc content instead of appending', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'import-target' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        seedEigendoc(collab.doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR CONTENT' }] }],
        });

        const res = await importRequest(docPath.id, await buildGoldenDocx(TEST_PNG_BYTES));
        expect((await assertJson<{ success: boolean }>(res)).success).toBe(true);

        const json = await readDocJson(docPath.id);
        expect(JSON.stringify(json)).not.toContain('PRIOR CONTENT');
        expect(nodeTypes(json)).toEqual(['heading', 'paragraph', 'bulletList', 'paragraph']);
        expect(await readDocMedia(docPath.id, GOLDEN_DOCX_IMAGE_NAME)).toEqual(Buffer.from(TEST_PNG_BYTES));
    }, 120_000);

    test('convert rejects non-.docx files', async () => {
        const uploaded = await upload('not a document', 'notes.txt', 'text/plain');
        const res = await convertRequest(uploaded.id);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Only .docx files can be converted to documents');
    }, 60_000);

    test('convert of a garbage .docx returns 400 Not a valid docx file', async () => {
        const uploaded = await upload('not a document at all', 'garbage.docx');
        const res = await convertRequest(uploaded.id);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid docx file');
    }, 60_000);

    test('import with a non-docx body returns 400, not 500', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'garbage-import-target' },
        );
        const res = await importRequest(docPath.id, toTransferableBuffer(Buffer.from('not a valid docx file')));
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid docx file');
    }, 60_000);

    test('convert rejects a stored .docx over the upload limit with 413', async () => {
        // /convert buffers an already-stored file, so it needs its own bound — the
        // upload-time limit can have been raised since the file landed.
        const uploaded = await upload('x'.repeat(2 * 1024 * 1024), 'oversized.docx');
        await setMaxUploadSizeMB(1);
        try {
            const res = await convertRequest(uploaded.id);
            expect(res.status).toBe(413);
            expect(await res.text()).toBe('Source file too large');
        } finally {
            await setMaxUploadSizeMB(35);
        }
    }, 60_000);
});
