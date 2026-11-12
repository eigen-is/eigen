import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core';
import { getSharedDrive } from '../../lib/drive/get-drive';
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

// Inside a document a person only adds a file to its media/ or a thread to its chat/. Every other add there is
// refused, and so is every change to something inside it, the owner's included, all with one 423.
const REFUSED = '423 Cannot change the inside of a document';

describe('Container write guard', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const mountId = 'default';
    let rootId: string;
    const aliceId = () => ctx.alice.user.id;

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    function request(token: string, ownerId: string, method: string, path: string, body?: Record<string, unknown>) {
        return authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body),
        });
    }

    function upload(token: string, ownerId: string, parentId: string, name = 'photo.png') {
        const formData = new FormData();
        formData.append('file', new File([TEST_PNG_BYTES], name, { type: 'image/png' }));
        return authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
            method: 'POST',
            body: formData,
        });
    }

    async function children(token: string, ownerId: string, folderId: string): Promise<DrivePath[]> {
        return driveGetList(token, ownerId, mountId, `folder/${folderId}`);
    }

    async function sharedFolder(name: string, owner = ctx.alice.user, guest = ctx.bob.user): Promise<DrivePath> {
        const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
        const folder = await drivePost<DrivePath>(owner.sessionToken, owner.id, mountId, `folder/${root.id}`, {
            folderName: name,
        });
        await drivePut(owner.sessionToken, owner.id, mountId, `path/${folder.id}/acl`, {
            add: [{ id: guest.email, read: true, write: true }],
        });
        return folder;
    }

    function editorPut(token: string, ownerId: string, pathId: string, body: Record<string, unknown>) {
        return authedRequest(token, `/editor/${ownerId}/${mountId}/${pathId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    describe('editor save', () => {
        test('a non-editable file (.png) is refused by the save route', async () => {
            const uploaded = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' }),
            );
            const res = await editorPut(ctx.alice.user.sessionToken, aliceId(), uploaded.id, {
                content: 'text into a png',
                force: true,
            });
            expect(res.status).toBe(400);
        });

        test('an editable file (.md) still saves', async () => {
            const uploaded = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                new File(['# hi'], 'notes.md', { type: 'text/markdown' }),
            );
            const res = await editorPut(ctx.alice.user.sessionToken, aliceId(), uploaded.id, {
                content: '# hi there',
                expectedEtag: `"${uploaded.hash}"`,
            });
            expect(res.status).toBe(200);
            expect((await res.json()).conflict).toBe(false);
        });
    });

    // A document in a folder shared with Bob for writing, with one saved version, a media file, a thread and a file in
    // the thread's media/.
    describe('inside a document', () => {
        let folder: DrivePath;
        let doc: DrivePath;
        let media: DrivePath;
        let chat: DrivePath;
        let versions: DrivePath;
        let thread: DrivePath;
        let threadMedia: DrivePath;
        let parts: DrivePath[];
        let plainFile: DrivePath;
        let plainFolder: DrivePath;
        const alice = () => ctx.alice.user.sessionToken;

        beforeAll(async () => {
            folder = await sharedFolder('inside-guard');
            doc = await drivePost<DrivePath>(alice(), aliceId(), mountId, `folder/${folder.id}/create/doc`, {
                fileName: 'inside-guard',
            });
            const saved = await request(alice(), aliceId(), 'POST', `file/${doc.id}/versions/save`);
            expect(saved.status).toBe(200);
            const inDoc = await children(alice(), aliceId(), doc.id);
            media = findOrFail(inDoc, (c) => c.name === 'media');
            chat = findOrFail(inDoc, (c) => c.name === 'chat');
            versions = findOrFail(inDoc, (c) => c.name === 'versions');
            const [version] = await listVersions(alice(), aliceId(), mountId, doc.id);
            thread = await drivePost<DrivePath>(alice(), aliceId(), mountId, `folder/${chat.id}/create/chat`, {
                fileName: 'inside-thread',
            });
            threadMedia = findOrFail(await children(alice(), aliceId(), thread.id), (c) => c.name === 'media');
            parts = [
                findOrFail(inDoc, (c) => c.name === 'data.db'),
                findOrFail(inDoc, (c) => c.name === 'comments.db'),
                media,
                chat,
                versions,
                findOrFail(await children(alice(), aliceId(), versions.id), (c) => c.id === version.id),
                await driveUpload<DrivePath>(
                    alice(),
                    aliceId(),
                    mountId,
                    media.id,
                    new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' }),
                ),
                thread,
                await driveUpload<DrivePath>(
                    alice(),
                    aliceId(),
                    mountId,
                    threadMedia.id,
                    new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' }),
                ),
            ];
            plainFile = await driveUpload<DrivePath>(
                alice(),
                aliceId(),
                mountId,
                folder.id,
                new File(['plain'], 'plain.txt', { type: 'text/plain' }),
            );
            plainFolder = await drivePost<DrivePath>(alice(), aliceId(), mountId, `folder/${folder.id}`, {
                folderName: 'plain-folder',
            });
        });

        test('a writer and the owner add a file to media/ and a thread to chat/', async () => {
            for (const [i, token] of [ctx.bob.user.sessionToken, alice()].entries()) {
                const image = await upload(token, aliceId(), media.id);
                expect(image.status).toBe(200);
                const [uploaded]: DrivePath[] = await image.json();
                expect(uploaded.parentId).toBe(media.id);

                const attachment = await upload(token, aliceId(), threadMedia.id);
                expect(attachment.status).toBe(200);

                const started = await request(token, aliceId(), 'POST', `folder/${chat.id}/create/chat`, {
                    fileName: `another-thread-${i}`,
                });
                expect(started.status).toBe(200);
                expect((await started.json()).parentId).toBe(chat.id);
            }
        });

        test('every other add inside the document is refused with one 423', async () => {
            const refusals: string[] = [];
            for (const token of [ctx.bob.user.sessionToken, alice()]) {
                const into = [doc, media, chat, versions, thread, threadMedia];
                const writes: Record<string, Response> = {};
                for (const target of into) {
                    writes[`folder in ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'POST',
                        `folder/${target.id}`,
                        {
                            folderName: 'notes',
                        },
                    );
                    writes[`doc in ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'POST',
                        `folder/${target.id}/create/doc`,
                        { fileName: 'nested' },
                    );
                    writes[`folder copy into ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'POST',
                        `path/${plainFolder.id}/copy`,
                        { targetOwnerId: aliceId(), targetMountId: mountId, targetParentId: target.id },
                    );
                    writes[`folder move into ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'PUT',
                        `path/${plainFolder.id}/move`,
                        { targetParentId: target.id },
                    );
                }
                for (const target of [doc, chat, versions, thread]) {
                    writes[`upload into ${target.name}`] = await upload(token, aliceId(), target.id);
                    writes[`file copy into ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'POST',
                        `path/${plainFile.id}/copy`,
                        { targetOwnerId: aliceId(), targetMountId: mountId, targetParentId: target.id },
                    );
                    writes[`file move into ${target.name}`] = await request(
                        token,
                        aliceId(),
                        'PUT',
                        `path/${plainFile.id}/move`,
                        { targetParentId: target.id },
                    );
                }
                writes['chat in media'] = await request(token, aliceId(), 'POST', `folder/${media.id}/create/chat`, {
                    fileName: 'misplaced',
                });
                for (const [write, res] of Object.entries(writes))
                    refusals.push(`${write}: ${res.status} ${await res.text()}`);
            }
            expect(refusals.filter((refusal) => !refusal.endsWith(`: ${REFUSED}`))).toEqual([]);
            const after = await driveGet<DrivePath>(alice(), aliceId(), mountId, `path/${plainFile.id}`);
            expect(after.parentId).toBe(folder.id);
            expect(await listVersions(alice(), aliceId(), mountId, doc.id)).toHaveLength(1);
        });

        // Only something new is added to media/ or chat/. A moved path would be trapped there, and nothing in the
        // document names it, so the next sweep would delete it.
        test('an existing file or thread is never moved into media/ or chat/', async () => {
            const looseThread = await drivePost<DrivePath>(
                alice(),
                aliceId(),
                mountId,
                `folder/${folder.id}/create/chat`,
                { fileName: 'loose-thread' },
            );
            const moves: [string, DrivePath, DrivePath][] = [
                ['file into media/', plainFile, media],
                ["file into a thread's media/", plainFile, threadMedia],
                ['thread into chat/', looseThread, chat],
            ];
            const refusals: string[] = [];
            for (const token of [ctx.bob.user.sessionToken, alice()]) {
                for (const [move, path, target] of moves) {
                    const res = await request(token, aliceId(), 'PUT', `path/${path.id}/move`, {
                        targetParentId: target.id,
                    });
                    refusals.push(`${move}: ${res.status} ${await res.text()}`);
                }
            }
            expect(refusals.filter((refusal) => !refusal.endsWith(`: ${REFUSED}`))).toEqual([]);
            for (const path of [plainFile, looseThread]) {
                const after = await driveGet<DrivePath>(alice(), aliceId(), mountId, `path/${path.id}`);
                expect(`${after.name} in ${after.parentId}`).toBe(`${path.name} in ${folder.id}`);
            }
        });

        test('nothing inside the document is renamed, moved, trashed or overwritten, with the same 423', async () => {
            const refusals: string[] = [];
            for (const visitor of [ctx.bob.user, ctx.alice.user]) {
                const writes: Record<string, Response> = {};
                for (const part of parts) {
                    writes[`trash ${part.name}`] = await request(
                        visitor.sessionToken,
                        aliceId(),
                        'DELETE',
                        `path/${part.id}`,
                    );
                    writes[`rename ${part.name}`] = await request(
                        visitor.sessionToken,
                        aliceId(),
                        'PUT',
                        `path/${part.id}/rename`,
                        { newName: `renamed-${part.name}` },
                    );
                    writes[`move ${part.name}`] = await request(
                        visitor.sessionToken,
                        aliceId(),
                        'PUT',
                        `path/${part.id}/move`,
                        { targetParentId: folder.id },
                    );
                }
                for (const [write, res] of Object.entries(writes))
                    refusals.push(`${write}: ${res.status} ${await res.text()}`);

                const { user } = await getHome(visitor.id);
                const drive = await getSharedDrive(aliceId(), user);
                for (const part of parts.filter((p) => p.type === 'file')) {
                    const refused = await drive
                        .writeFileContent(mountId, part.id, Buffer.from('overwrite'), { user })
                        .then(
                            () => 'written',
                            (e: unknown) => (e instanceof ApiError ? `${e.status} ${e.message}` : String(e)),
                        );
                    refusals.push(`overwrite ${part.name}: ${refused}`);
                }
            }
            expect(refusals.filter((refusal) => !refusal.endsWith(`: ${REFUSED}`))).toEqual([]);
            for (const part of parts) {
                const after = await driveGet<DrivePath>(alice(), aliceId(), mountId, `path/${part.id}`);
                expect(`${after.name} in ${after.parentId}, hash ${after.hash}, trashed ${after.trashedAt}`).toBe(
                    `${part.name} in ${part.parentId}, hash ${part.hash}, trashed null`,
                );
            }
        });

        test('the whole document still renames, moves and goes to the trash', async () => {
            const other = await drivePost<DrivePath>(alice(), aliceId(), mountId, `folder/${folder.id}/create/doc`, {
                fileName: 'inside-guard-whole',
            });
            const bob = ctx.bob.user.sessionToken;
            const renamed = await request(bob, aliceId(), 'PUT', `path/${other.id}/rename`, {
                newName: 'whole.eigendoc',
            });
            expect(renamed.status).toBe(200);
            const moved = await request(bob, aliceId(), 'PUT', `path/${other.id}/move`, {
                targetParentId: plainFolder.id,
            });
            expect(moved.status).toBe(200);
            const trashed = await request(alice(), aliceId(), 'DELETE', `path/${other.id}`);
            expect(trashed.status).toBe(200);
            const trash = await driveGetList(alice(), aliceId(), mountId, 'trash');
            expect(trash.map((item) => item.id)).toContain(other.id);
        });
    });

    // Pasting content with images from one document into another copies each image into the target's media/.
    describe("a copy of a media file into another document's media/", () => {
        async function docAndMedia(owner: typeof ctx.alice.user, parentId: string, name: string): Promise<DrivePath> {
            const doc = await drivePost<DrivePath>(
                owner.sessionToken,
                owner.id,
                mountId,
                `folder/${parentId}/create/doc`,
                { fileName: name },
            );
            return findOrFail(await children(owner.sessionToken, owner.id, doc.id), (c) => c.name === 'media');
        }

        // Alice copies an image out of her own document's media/ into the target's, twice.
        async function copyTwiceInto(target: DrivePath, name: string): Promise<string[]> {
            const from = await docAndMedia(ctx.alice.user, rootId, name);
            const res = await upload(ctx.alice.user.sessionToken, aliceId(), from.id, 'img.png');
            const [image]: DrivePath[] = await res.json();
            const outcomes: string[] = [];
            for (let i = 0; i < 2; i++) {
                const copy = await request(ctx.alice.user.sessionToken, aliceId(), 'POST', `path/${image.id}/copy`, {
                    targetOwnerId: target.ownerId,
                    targetMountId: mountId,
                    targetParentId: target.id,
                });
                const copied: DrivePath = await copy.json();
                outcomes.push(`${copy.status} ${copied.name} in ${copied.parentId}`);
            }
            return outcomes;
        }

        test('lands in a document of the same mount, the second copy under a free name', async () => {
            const target = await docAndMedia(ctx.alice.user, rootId, 'media-copy-to');
            expect(await copyTwiceInto(target, 'media-copy-from')).toEqual([
                `200 img.png in ${target.id}`,
                `200 img (2).png in ${target.id}`,
            ]);
        });

        test("lands in another owner's document the copier may write, the second copy under a free name", async () => {
            const bob = ctx.bob.user;
            const bobsFolder = await sharedFolder('media-copy-shared', bob, ctx.alice.user);
            const target = await docAndMedia(bob, bobsFolder.id, 'media-copy-shared');
            expect(await copyTwiceInto(target, 'media-copy-across')).toEqual([
                `200 img.png in ${target.id}`,
                `200 img (2).png in ${target.id}`,
            ]);
            const names = (await children(bob.sessionToken, bob.id, target.id)).map((c) => c.name).sort();
            expect(names).toEqual(['img (2).png', 'img.png']);
        });
    });

    // A copy to another drive writes the new document's databases, media/ and chat/ into it, which no person may.
    describe('a copy to another drive', () => {
        const parts = ['chat', 'comments.db', 'data.db', 'media'];

        async function docWithMedia(owner: typeof ctx.alice.user, parentId: string, name: string): Promise<DrivePath> {
            const doc = await drivePost<DrivePath>(
                owner.sessionToken,
                owner.id,
                mountId,
                `folder/${parentId}/create/doc`,
                {
                    fileName: name,
                },
            );
            const media = findOrFail(await children(owner.sessionToken, owner.id, doc.id), (c) => c.name === 'media');
            expect((await upload(owner.sessionToken, owner.id, media.id)).status).toBe(200);
            return doc;
        }

        test("copies a whole document into the copier's own drive", async () => {
            const folder = await sharedFolder('copy-across-own');
            const doc = await docWithMedia(ctx.alice.user, folder.id, 'copy-across-own');
            const bob = ctx.bob.user;
            const bobRoot = await driveGet<DrivePath>(bob.sessionToken, bob.id, mountId, 'root');
            const res = await request(bob.sessionToken, aliceId(), 'POST', `path/${doc.id}/copy`, {
                targetOwnerId: bob.id,
                targetMountId: mountId,
                targetParentId: bobRoot.id,
            });
            expect(res.status).toBe(200);
            const copy: DrivePath = await res.json();
            const names = (await children(bob.sessionToken, bob.id, copy.id)).map((c) => c.name).sort();
            expect(names).toEqual(parts);
        });

        test("copies a whole document into a folder of another owner's drive", async () => {
            const bob = ctx.bob.user;
            const doc = await docWithMedia(ctx.alice.user, rootId, 'copy-across-shared');
            const bobsFolder = await sharedFolder('copy-across-target', bob, ctx.alice.user);
            const res = await request(ctx.alice.user.sessionToken, aliceId(), 'POST', `path/${doc.id}/copy`, {
                targetOwnerId: bob.id,
                targetMountId: mountId,
                targetParentId: bobsFolder.id,
            });
            expect(res.status).toBe(200);
            const copy: DrivePath = await res.json();
            expect(copy.parentId).toBe(bobsFolder.id);
            const names = (await children(bob.sessionToken, bob.id, copy.id)).map((c) => c.name).sort();
            expect(names).toEqual(parts);
        });

        test("a copy into another owner's document is refused with the same 423", async () => {
            const bob = ctx.bob.user;
            const bobsFolder = await sharedFolder('copy-across-into-doc', bob, ctx.alice.user);
            const bobsDoc = await drivePost<DrivePath>(
                bob.sessionToken,
                bob.id,
                mountId,
                `folder/${bobsFolder.id}/create/doc`,
                {
                    fileName: 'copy-across-into-doc',
                },
            );
            const file = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                aliceId(),
                mountId,
                rootId,
                new File(['x'], 'into-doc.txt', { type: 'text/plain' }),
            );
            const res = await request(ctx.alice.user.sessionToken, aliceId(), 'POST', `path/${file.id}/copy`, {
                targetOwnerId: bob.id,
                targetMountId: mountId,
                targetParentId: bobsDoc.id,
            });
            expect(`${res.status} ${await res.text()}`).toBe(REFUSED);
            const names = (await children(bob.sessionToken, bob.id, bobsDoc.id)).map((c) => c.name).sort();
            expect(names).toEqual(parts);
        });
    });
});
