import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
    TEST_PNG_BYTES,
} from '../setup';

// Findings #5 (editor save) + #13 (create/copy into a document container). A write collaborator
// could overwrite a shared container's data.db through the editor route, and the create/copy REST
// routes accepted a document container as the direct parent. Both write surfaces now refuse
// container internals while the media/ subfolder stays writable.
describe('Container write guard', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;
    const aliceId = () => ctx.alice.user.id;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    async function createDoc(name: string): Promise<DrivePath> {
        return drivePost<DrivePath>(ctx.alice.user.sessionToken, aliceId(), mountId, `folder/${rootId}/create/doc`, {
            fileName: name,
        });
    }

    async function containerChildren(docId: string): Promise<DrivePath[]> {
        return driveGetList(ctx.alice.user.sessionToken, aliceId(), mountId, `folder/${docId}`);
    }

    function editorPut(token: string, ownerId: string, pathId: string, body: Record<string, unknown>) {
        return authedRequest(token, `/editor/${ownerId}/${mountId}/${pathId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    describe('#5 editor save', () => {
        test('a write collaborator cannot overwrite a shared container data.db', async () => {
            const doc = await createDoc('shared-guard.eigendoc');
            await drivePut(ctx.alice.user.sessionToken, aliceId(), mountId, `path/${doc.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });

            const children = await containerChildren(doc.id);
            const dataDb = children.find((c) => c.name === 'data.db');
            expect(dataDb).toBeDefined();
            const before = await driveGet<DrivePath>(
                ctx.bob.user.sessionToken,
                aliceId(),
                mountId,
                `path/${dataDb!.id}`,
            );

            const res = await editorPut(ctx.bob.user.sessionToken, aliceId(), dataDb!.id, {
                content: 'malicious overwrite',
                expectedUpdatedAt: before.updatedAt,
                force: true,
            });
            expect(res.status).toBe(423);

            const after = await driveGet<DrivePath>(
                ctx.bob.user.sessionToken,
                aliceId(),
                mountId,
                `path/${dataDb!.id}`,
            );
            expect(after.size).toBe(before.size);
            // driveGet returns raw JSON (dates as strings) — a byte-equal string compare is enough.
            expect(String(after.updatedAt)).toBe(String(before.updatedAt));
        });

        test('a non-editable file (.png) is refused by the save route', async () => {
            const file = new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' });
            const uploaded = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                file,
            );
            const res = await editorPut(ctx.alice.user.sessionToken, aliceId(), uploaded.id, {
                content: 'text into a png',
                expectedUpdatedAt: uploaded.updatedAt,
                force: true,
            });
            expect(res.status).toBe(400);
        });

        test('an editable file (.md) still saves', async () => {
            const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
            const uploaded = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                file,
            );
            const current = await driveGet<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                `path/${uploaded.id}`,
            );
            const res = await editorPut(ctx.alice.user.sessionToken, aliceId(), uploaded.id, {
                content: '# hi there',
                expectedUpdatedAt: current.updatedAt,
            });
            expect(res.status).toBe(200);
        });
    });

    describe('#13 create / copy parents', () => {
        test('creating a folder with a document container as parent is rejected', async () => {
            const doc = await createDoc('no-folder-here.eigendoc');
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/folder/${doc.id}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'intruder' }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('creating a nested doc inside a document container is rejected', async () => {
            const doc = await createDoc('no-doc-here.eigendoc');
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/folder/${doc.id}/create/doc`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: 'nested' }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('a normal folder still creates in a plain folder', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/folder/${rootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: `ok-${Date.now()}` }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('uploading into the container media/ folder still works (attachment path)', async () => {
            const doc = await createDoc('media-ok.eigendoc');
            const media = (await containerChildren(doc.id)).find((c) => c.name === 'media');
            expect(media).toBeDefined();
            const file = new File([TEST_PNG_BYTES], 'attach.png', { type: 'image/png' });
            const uploaded = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                media!.id,
                file,
            );
            expect(uploaded.id).toBeDefined();
        });

        test('copying a file into a document container is rejected, but into media/ works', async () => {
            const doc = await createDoc('copy-guard.eigendoc');
            const media = (await containerChildren(doc.id)).find((c) => c.name === 'media');
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                new File(['payload'], 'src.txt', { type: 'text/plain' }),
            );

            const intoContainer = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/path/${source.id}/copy`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetOwnerId: aliceId(), targetMountId: mountId, targetParentId: doc.id }),
                },
            );
            expect(intoContainer.status).toBe(400);

            const intoMedia = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/path/${source.id}/copy`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        targetOwnerId: aliceId(),
                        targetMountId: mountId,
                        targetParentId: media!.id,
                    }),
                },
            );
            expect(intoMedia.status).toBe(200);
        });
    });
});
