import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../lib/core';
import { readEigendocFromDoc } from '../lib/document/doc';
import { toTransferableBuffer } from '../lib/document/transform/protocol';
import { getSharedDrive } from '../lib/drive/get-drive';
import { getHome } from '../lib/home/get-home';
import { importDocxToEigendocUpdate } from '../lib/import/doc/transform';
import { importIntoDocument } from '../lib/import/import-document';
import { getUserById } from '../lib/user';
import { seedEigendoc } from './fixtures/golden-documents';
import { buildGoldenDocx, GOLDEN_DOCX_HEADING, GOLDEN_DOCX_IMAGE_NAME, GOLDEN_DOCX_LINK } from './fixtures/golden-docx';
import { buildDeclaredSizeBombZip } from './fixtures/zip-bomb';
import {
    assertJson,
    authedRequest,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
    setMaxUploadSizeMB,
    TEST_PNG_BYTES,
} from './setup';

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

    test('a repeat .docx import overwrites the previous import media', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'repeat-import-target' },
        );
        const first = await importRequest(docPath.id, await buildGoldenDocx(TEST_PNG_BYTES));
        expect((await assertJson<{ success: boolean }>(first)).success).toBe(true);

        // The second import extracts the same deterministic media names — it must
        // overwrite them, not 409 after the content was already replaced.
        const altBytes = new Uint8Array([...TEST_PNG_BYTES, 0]);
        const second = await importRequest(docPath.id, await buildGoldenDocx(altBytes));
        expect((await assertJson<{ success: boolean }>(second)).success).toBe(true);

        expect(nodeTypes(await readDocJson(docPath.id))).toEqual(['heading', 'paragraph', 'bulletList', 'paragraph']);
        expect(await readDocMedia(docPath.id, GOLDEN_DOCX_IMAGE_NAME)).toEqual(Buffer.from(altBytes));
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

    test('import route surfaces the decompression-bomb guard as 413 Document too large', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'bomb-import-target' },
        );
        const bomb = await buildDeclaredSizeBombZip('word/document.xml', 201 * 1024 * 1024);
        const res = await importRequest(docPath.id, toTransferableBuffer(bomb));
        expect(res.status).toBe(413);
        expect(await res.text()).toBe('Document too large');
    }, 60_000);

    test('write revoked while the transform ran blocks the commit', async () => {
        // The route checks write before buffering, then the job queues and transforms
        // for up to minutes. Calling the commit seam directly with a writer whose
        // permission was revoked in that window is exactly the race: read still
        // resolves the collab document, only the write recheck stands in the way.
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'acl-race-target' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        seedEigendoc(collab.doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR CONTENT' }] }],
        });
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docPath.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });

        const bob = await getUserById(ctx.bob.user.id);
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob!);
        const { mount, path } = await bobDrive.resolveFile(mountId, docPath.id);

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docPath.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });

        const before = await readDocJson(docPath.id);
        const buffer = Buffer.from(await buildGoldenDocx(TEST_PNG_BYTES));
        let error: unknown;
        try {
            await importIntoDocument(bobDrive, mount, path, buffer, bob!);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
        expect((error as ApiError).message).toBe('No write permission');
        expect(await readDocJson(docPath.id)).toEqual(before);
    }, 60_000);

    test('write revoked during the collab-document lookup blocks the commit', async () => {
        // The recheck only closes the race if it is the LAST await before the write:
        // resolving the collab document is itself an await, read-checked only.
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'acl-race-lookup-target' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        seedEigendoc(collab.doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR CONTENT' }] }],
        });
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docPath.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });

        const bob = await getUserById(ctx.bob.user.id);
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob!);
        const { mount, path } = await bobDrive.resolveFile(mountId, docPath.id);

        const realGet = bobDrive.getCollabDocument.bind(bobDrive);
        const getSpy = spyOn(bobDrive, 'getCollabDocument').mockImplementation(async (id, pathId) => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docPath.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            return realGet(id, pathId);
        });

        const before = await readDocJson(docPath.id);
        const buffer = Buffer.from(await buildGoldenDocx(TEST_PNG_BYTES));
        let error: unknown;
        try {
            await importIntoDocument(bobDrive, mount, path, buffer, bob!);
        } catch (e) {
            error = e;
        } finally {
            getSpy.mockRestore();
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
        expect((error as ApiError).message).toBe('No write permission');
        expect(await readDocJson(docPath.id)).toEqual(before);
    }, 60_000);

    test('convert rejects a stored .docx over the upload limit with 413', async () => {
        // /convert buffers an already-stored file, so it needs its own bound — the
        // upload-time limit can have been raised since the file landed.
        const uploaded = await upload('x'.repeat(2 * 1024 * 1024), 'oversized.docx');
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await convertRequest(uploaded.id);
            expect(res.status).toBe(413);
            expect(await res.text()).toBe('Source file too large');
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    }, 60_000);
});

describe('docx import resource guards', () => {
    test('rejects a docx whose declared decompressed size exceeds the cap', async () => {
        // The declared-size guard reads each entry's uncompressedSize straight from the zip
        // central directory and never decompresses, so it needs no real bomb payload — the
        // fixture forges a tiny entry's declared size just over the 200 MB cap. The guard
        // runs before mammoth inflates anything (that OOM is uncatchable, so a post-parse
        // check would never fire).
        const bomb = await buildDeclaredSizeBombZip('word/document.xml', 201 * 1024 * 1024);

        let error: unknown;
        try {
            await importDocxToEigendocUpdate(toTransferableBuffer(bomb));
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(413);
        expect((error as ApiError).message).toBe('Document too large');
    });
});
