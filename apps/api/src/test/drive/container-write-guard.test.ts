import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home/get-home';
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

// A write collaborator on a shared document must not overwrite, trash, rename or move its databases
// and saved versions, nor put anything into its versions/ folder. The rest of the document, such as
// its media/ folder, stays writable.
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

    async function createDoc(name: string, parentId = rootId): Promise<DrivePath> {
        return drivePost<DrivePath>(ctx.alice.user.sessionToken, aliceId(), mountId, `folder/${parentId}/create/doc`, {
            fileName: name,
        });
    }

    async function containerChildren(docId: string): Promise<DrivePath[]> {
        return driveGetList(ctx.alice.user.sessionToken, aliceId(), mountId, `folder/${docId}`);
    }

    // A document shared with Bob for writing, with one saved version, and its parts: the two
    // databases, the versions folder and the version in it.
    async function docWithVersion(name: string, parentId = rootId): Promise<{ doc: DrivePath; parts: DrivePath[] }> {
        const doc = await createDoc(name, parentId);
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

    function editorPut(token: string, ownerId: string, pathId: string, body: Record<string, unknown>) {
        return authedRequest(token, `/editor/${ownerId}/${mountId}/${pathId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    describe('editor save', () => {
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

    // The same parts can be renamed, moved or written into through the other routes. A renamed
    // data.db breaks the document, a version moved out leaves a gap in its history, and a file
    // put in versions/ would list and restore as a version. So those routes refuse them too.
    describe('writes to a document part', () => {
        const bobToken = () => ctx.bob.user.sessionToken;
        let sharedFolder: DrivePath;
        let doc: DrivePath;
        let parts: DrivePath[];
        let versionsFolder: DrivePath;
        let plainFile: DrivePath;

        beforeAll(async () => {
            sharedFolder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                `folder/${rootId}`,
                {
                    folderName: 'parts-write-guard',
                },
            );
            await drivePut(ctx.alice.user.sessionToken, aliceId(), mountId, `path/${sharedFolder.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });
            ({ doc, parts } = await docWithVersion('parts-write-guard', sharedFolder.id));
            versionsFolder = findOrFail(parts, (part) => part.name === 'versions');
            plainFile = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                sharedFolder.id,
                new File(['plain'], 'plain.txt', { type: 'text/plain' }),
            );
        });

        function bobPut(path: string, body: Record<string, unknown>) {
            return authedRequest(bobToken(), `/drive/${aliceId()}/${mountId}/${path}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }

        function bobPost(path: string, body: Record<string, unknown>) {
            return authedRequest(bobToken(), `/drive/${aliceId()}/${mountId}/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }

        // Every part keeps its name and its folder, and versions/ holds only the saved version.
        async function expectPartsUnchanged() {
            for (const part of parts) {
                const after = await driveGet<DrivePath>(
                    ctx.alice.user.sessionToken,
                    aliceId(),
                    mountId,
                    `path/${part.id}`,
                );
                expect(`${after.name} in ${after.parentId}`).toBe(`${part.name} in ${part.parentId}`);
            }
            const inVersions = await containerChildren(versionsFolder.id);
            expect(inVersions.map((child) => child.name)).toEqual(parts.slice(3).map((part) => part.name));
        }

        test('a writer cannot rename or move out a database, the versions folder or a version', async () => {
            const statuses: Record<string, number> = {};
            for (const part of parts) {
                const renamed = await bobPut(`path/${part.id}/rename`, { newName: `renamed-${part.name}` });
                statuses[`rename ${part.name}`] = renamed.status;
                const moved = await bobPut(`path/${part.id}/move`, { targetParentId: sharedFolder.id });
                statuses[`move ${part.name}`] = moved.status;
            }
            expect(statuses).toEqual(Object.fromEntries(Object.keys(statuses).map((write) => [write, 400])));
            await expectPartsUnchanged();
        });

        // The routes refuse such a write before they reach the drive, and the drive refuses it again for any
        // caller that comes later.
        test('the drive refuses new bytes for a database or a version', async () => {
            const drive = (await getHome(aliceId())).drive;
            const files = parts.filter((part) => part.type === 'file');
            for (const part of files) {
                await expect(drive.writeFileContent(mountId, part.id, Buffer.from('overwrite'))).rejects.toThrow(
                    "Cannot change a document's databases or versions",
                );
            }
            for (const part of files) {
                const after = await driveGet<DrivePath>(
                    ctx.alice.user.sessionToken,
                    aliceId(),
                    mountId,
                    `path/${part.id}`,
                );
                expect(after.size).toBe(part.size);
            }
        });

        test('a writer cannot move, upload, create or copy anything into versions/', async () => {
            const formData = new FormData();
            formData.append('file', new File(['fake'], 'fake.db', { type: 'application/x-sqlite3' }));
            const writes = {
                move: await bobPut(`path/${plainFile.id}/move`, { targetParentId: versionsFolder.id }),
                upload: await authedRequest(bobToken(), `/drive/${aliceId()}/${mountId}/file/${versionsFolder.id}`, {
                    method: 'POST',
                    body: formData,
                }),
                'create folder': await bobPost(`folder/${versionsFolder.id}`, { folderName: 'fake' }),
                'create doc': await bobPost(`folder/${versionsFolder.id}/create/doc`, { fileName: 'fake' }),
                copy: await bobPost(`path/${plainFile.id}/copy`, {
                    targetOwnerId: aliceId(),
                    targetMountId: mountId,
                    targetParentId: versionsFolder.id,
                }),
            };
            const statuses = Object.entries(writes).map(([write, res]) => `${write}: ${res.status}`);
            expect(statuses).toEqual(Object.keys(writes).map((write) => `${write}: 400`));
            await expectPartsUnchanged();
            const file = await driveGet<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                `path/${plainFile.id}`,
            );
            expect(file.parentId).toBe(sharedFolder.id);
            expect(await listVersions(ctx.alice.user.sessionToken, aliceId(), mountId, doc.id)).toHaveLength(1);
        });

        test('a writer still renames, moves and uploads a document and a plain file', async () => {
            const target = await bobPost(`folder/${sharedFolder.id}`, { folderName: 'parts-write-target' });
            expect(target.status).toBe(200);
            const targetFolder: DrivePath = await target.json();
            const { doc: other } = await docWithVersion('parts-write-other', sharedFolder.id);
            const file = await driveUpload<DrivePath>(
                bobToken(),
                aliceId(),
                mountId,
                sharedFolder.id,
                new File(['mine'], 'mine.txt', { type: 'text/plain' }),
            );
            for (const item of [other, file]) {
                const renamed = await bobPut(`path/${item.id}/rename`, { newName: `moved-${item.name}` });
                expect(renamed.status).toBe(200);
                const moved = await bobPut(`path/${item.id}/move`, { targetParentId: targetFolder.id });
                expect(moved.status).toBe(200);
                const after = await driveGet<DrivePath>(bobToken(), aliceId(), mountId, `path/${item.id}`);
                expect(`${after.name} in ${after.parentId}`).toBe(`moved-${item.name} in ${targetFolder.id}`);
            }
            const media = findOrFail(await containerChildren(other.id), (c) => c.name === 'media');
            const image = await driveUpload<DrivePath>(
                bobToken(),
                aliceId(),
                mountId,
                media.id,
                new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' }),
            );
            expect(image.parentId).toBe(media.id);
        });
    });

    // Every lookup of versions/ ignores case, and a document has none before its first saved version or after a
    // Delete history. A folder or file a writer gives that name would take the place of the real one, so no write
    // names a child of a document that way.
    describe('a versions folder planted in a document', () => {
        const bobToken = () => ctx.bob.user.sessionToken;
        let sharedFolder: DrivePath;

        beforeAll(async () => {
            sharedFolder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                `folder/${rootId}`,
                { folderName: 'planted-versions' },
            );
            await drivePut(ctx.alice.user.sessionToken, aliceId(), mountId, `path/${sharedFolder.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });
        });

        function bobRequest(method: string, path: string, body: Record<string, unknown>) {
            return authedRequest(bobToken(), `/drive/${aliceId()}/${mountId}/${path}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }

        // A plain folder named versions, with a file in it a save could list as a version.
        async function fakeVersions(token: string, ownerId: string, parentId: string): Promise<DrivePath> {
            const folder = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${parentId}`, {
                folderName: 'versions',
            });
            await driveUpload(
                token,
                ownerId,
                mountId,
                folder.id,
                new File(['fake'], '2026-01-01T00-00-00-000Z.db', { type: 'application/x-sqlite3' }),
            );
            return folder;
        }

        async function expectNoVersions(doc: DrivePath) {
            const children = await containerChildren(doc.id);
            expect(children.filter((child) => child.name.toLowerCase() === 'versions')).toEqual([]);
            expect(await listVersions(ctx.alice.user.sessionToken, aliceId(), mountId, doc.id)).toEqual([]);
        }

        test('a writer cannot create, rename to, copy in or move in a versions folder', async () => {
            const doc = await createDoc('planted-versions-doc', sharedFolder.id);
            const notes = await bobRequest('POST', `folder/${doc.id}`, { folderName: 'notes' });
            expect(notes.status).toBe(200);
            const notesFolder: DrivePath = await notes.json();
            const inShared = await fakeVersions(bobToken(), aliceId(), sharedFolder.id);
            const bobRoot = await driveGet<DrivePath>(bobToken(), ctx.bob.user.id, mountId, 'root');
            const inBobsDrive = await fakeVersions(bobToken(), ctx.bob.user.id, bobRoot.id);

            const writes = {
                'create Versions': await bobRequest('POST', `folder/${doc.id}`, { folderName: 'Versions' }),
                'rename to versions': await bobRequest('PUT', `path/${notesFolder.id}/rename`, { newName: 'versions' }),
                copy: await bobRequest('POST', `path/${inShared.id}/copy`, {
                    targetOwnerId: aliceId(),
                    targetMountId: mountId,
                    targetParentId: doc.id,
                }),
                'copy from another drive': await authedRequest(
                    bobToken(),
                    `/drive/${ctx.bob.user.id}/${mountId}/path/${inBobsDrive.id}/copy`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            targetOwnerId: aliceId(),
                            targetMountId: mountId,
                            targetParentId: doc.id,
                        }),
                    },
                ),
            };
            const statuses = Object.entries(writes).map(([write, res]) => `${write}: ${res.status}`);
            expect(statuses).toEqual(Object.keys(writes).map((write) => `${write}: 400`));
            // A move only goes into a folder, and a document is not one.
            const moved = await bobRequest('PUT', `path/${inShared.id}/move`, { targetParentId: doc.id });
            expect(moved.status).toBe(404);
            await expectNoVersions(doc);
        });

        test('a writer cannot upload into a versions folder whose name differs in case', async () => {
            const doc = await createDoc('planted-versions-upload', sharedFolder.id);
            const { mount } = await (await getHome(aliceId())).drive.resolveFile(mountId, doc.id);
            const plantedId = await mount.createFolder(doc.id, 'Versions');
            const formData = new FormData();
            formData.append(
                'file',
                new File(['fake'], '2026-01-01T00-00-00-000Z.db', { type: 'application/x-sqlite3' }),
            );
            const res = await authedRequest(bobToken(), `/drive/${aliceId()}/${mountId}/file/${plantedId}`, {
                method: 'POST',
                body: formData,
            });
            expect(res.status).toBe(400);
            expect(await listVersions(ctx.alice.user.sessionToken, aliceId(), mountId, doc.id)).toEqual([]);
        });

        test("a document's databases keep their names: a twin is a name taken", async () => {
            const doc = await createDoc('planted-database', sharedFolder.id);
            const res = await bobRequest('POST', `folder/${doc.id}`, { folderName: 'Data.db' });
            expect(res.status).toBe(409);
            const names = (await containerChildren(doc.id)).map((child) => child.name).sort();
            expect(names).toEqual(['chat', 'comments.db', 'data.db', 'media']);
        });

        test("a chat keeps no comments.db, so an item of that name in a chat is a writer's own", async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                `folder/${sharedFolder.id}/create/chat`,
                { fileName: 'planted-chat' },
            );
            const created = await bobRequest('POST', `folder/${chat.id}`, { folderName: 'comments.db' });
            expect(created.status).toBe(200);
            const item: DrivePath = await created.json();
            const renamed = await bobRequest('PUT', `path/${item.id}/rename`, { newName: 'notes' });
            expect(renamed.status).toBe(200);
        });

        test('a save still makes the versions folder, and a copy to another drive still copies the document', async () => {
            const doc = await createDoc('planted-versions-save', sharedFolder.id);
            const saved = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${aliceId()}/${mountId}/file/${doc.id}/versions/save`,
                { method: 'POST' },
            );
            expect(saved.status).toBe(200);
            expect(await listVersions(ctx.alice.user.sessionToken, aliceId(), mountId, doc.id)).toHaveLength(1);

            const bobRoot = await driveGet<DrivePath>(bobToken(), ctx.bob.user.id, mountId, 'root');
            const copied = await bobRequest('POST', `path/${doc.id}/copy`, {
                targetOwnerId: ctx.bob.user.id,
                targetMountId: mountId,
                targetParentId: bobRoot.id,
            });
            expect(copied.status).toBe(200);
            const copy: DrivePath = await copied.json();
            const inCopy = await driveGetList(bobToken(), ctx.bob.user.id, mountId, `folder/${copy.id}`);
            expect(inCopy.map((child) => child.name).sort()).toEqual(['chat', 'comments.db', 'data.db', 'media']);
        });
    });
});
