import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    drivePut,
    driveUpload,
    findOrFail,
    getTestContext,
    listVersions,
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
                force: true,
            });
            expect(res.status).toBe(400);

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
            const res = await editorPut(ctx.alice.user.sessionToken, aliceId(), uploaded.id, {
                content: '# hi there',
                expectedEtag: `"${uploaded.hash}"`,
            });
            expect(res.status).toBe(200);
            expect((await res.json()).conflict).toBe(false);
        });
    });

    // A document's databases and its saved versions are rows a writer can name, through the folder
    // listing and the version list. Trashing one would break the document or undo its history, so
    // the delete route refuses them for everyone, the owner included.
    describe('trash of a document part', () => {
        function deletePath(token: string, pathId: string) {
            return authedRequest(token, `/drive/${aliceId()}/${mountId}/path/${pathId}`, { method: 'DELETE' });
        }

        async function docWithVersion(name: string): Promise<{ doc: DrivePath; parts: DrivePath[] }> {
            const doc = await createDoc(name);
            await drivePut(ctx.alice.user.sessionToken, aliceId(), mountId, `path/${doc.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });
            const saved = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/file/${doc.id}/versions/save`,
                { method: 'POST' },
            );
            expect(saved.status).toBe(200);
            const children = await containerChildren(doc.id);
            const versionsFolder = findOrFail(children, (c) => c.name === 'versions');
            const [version] = await listVersions(ctx.alice.user.sessionToken, aliceId(), mountId, doc.id);
            const parts = [
                findOrFail(children, (c) => c.name === 'data.db'),
                findOrFail(children, (c) => c.name === 'comments.db'),
                versionsFolder,
                findOrFail(await containerChildren(versionsFolder.id), (c) => c.id === version.id),
            ];
            return { doc, parts };
        }

        test('a writer and the owner cannot trash a database, the versions folder or a version', async () => {
            const { parts } = await docWithVersion('parts-guard.eigendoc');
            for (const part of parts) {
                for (const token of [ctx.bob.user.sessionToken, ctx.alice.user.sessionToken]) {
                    const res = await deletePath(token, part.id);
                    expect(`${part.name}: ${res.status}`).toBe(`${part.name}: 400`);
                }
                const after = await driveGet<DrivePath>(
                    ctx.alice.user.sessionToken,
                    aliceId(),
                    mountId,
                    `path/${part.id}`,
                );
                expect(after.trashedAt).toBeNull();
            }
            const trash = await driveGetList(ctx.alice.user.sessionToken, aliceId(), mountId, 'trash');
            expect(trash.filter((item) => parts.some((part) => part.id === item.id))).toEqual([]);
        });

        test('the whole document still goes to the trash', async () => {
            const { doc } = await docWithVersion('parts-guard-whole.eigendoc');
            const res = await deletePath(ctx.alice.user.sessionToken, doc.id);
            expect(res.status).toBe(200);
            const trash = await driveGetList(ctx.alice.user.sessionToken, aliceId(), mountId, 'trash');
            expect(trash.map((item) => item.id)).toContain(doc.id);
        });
    });
});
