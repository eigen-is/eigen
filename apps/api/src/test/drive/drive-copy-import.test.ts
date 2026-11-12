import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import { teamOwnerId } from '@workspace/lib/types';
import { DRIVE_TYPE_FOLDER } from '@workspace/lib/types/drive';
import type { MountInfo } from '@workspace/lib/types/mount';
import { SSEventType } from '@workspace/lib/types/sse';
import * as Y from 'yjs';
import * as enforcement from '../../lib/config/enforcement';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home';
import { drainHomeDeliveries } from '../../lib/home/home-relay';
import { copySize } from '../../lib/mount/copy';
import { getThumbnail } from '../../lib/shared/thumbnails';
import { getUserById } from '../../lib/user';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import { flushContentReindex } from '../mount-test-helpers';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    capUserDrive,
    collectSSE,
    createTeam,
    createTestUser,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    eventually,
    findOrFail,
    getTestContext,
    setMaxUploadSizeMB,
    TEST_PNG_BYTES,
} from '../setup';

const isWindows = process.platform === 'win32';

async function copyFile(
    sessionToken: string,
    sourceOwnerId: string,
    sourceMountId: string,
    sourcePathId: string,
    body: { targetOwnerId: string; targetMountId: string; targetParentId: string },
): Promise<Response> {
    return authedRequest(sessionToken, `/drive/${sourceOwnerId}/${sourceMountId}/path/${sourcePathId}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function importFromDrive(
    sessionToken: string,
    targetOwnerId: string,
    targetMountId: string,
    targetPathId: string,
    body: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string },
): Promise<Response> {
    return authedRequest(
        sessionToken,
        `/drive/${targetOwnerId}/${targetMountId}/file/${targetPathId}/import-from-drive`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, mode: 'replace' }),
        },
    );
}

describe.skipIf(isWindows)('Drive — /copy and /import-from-drive', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const mountId = 'default';
    let aliceRootId: string;
    let bobRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        aliceRootId = aliceRoot.id;
        const bobRoot = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, 'root');
        bobRootId = bobRoot.id;
    });

    describe('/copy', () => {
        test('copies a file from source drive into target folder', async () => {
            const file = new File(['copy-me'], 'source.txt', { type: 'text/plain' });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            const res = await copyFile(ctx.alice.user.sessionToken, source.ownerId, source.mountId, source.id, {
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            const copied = await assertJson<DrivePath>(res);
            expect(copied.id).not.toBe(source.id);
            expect(copied.name).toContain('source');
            expect(copied.size).toBe('copy-me'.length);
        });

        test("rejects Alice copying Bob's private file", async () => {
            const file = new File(['bob-only'], 'bob-private.txt', { type: 'text/plain' });
            const bobsFile = await driveUpload<DrivePath>(
                ctx.bob.user.sessionToken,
                ctx.bob.user.id,
                mountId,
                bobRootId,
                file,
            );

            const res = await copyFile(ctx.alice.user.sessionToken, bobsFile.ownerId, bobsFile.mountId, bobsFile.id, {
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(403);
        });

        test("rejects Alice copying into Bob's private drive", async () => {
            const file = new File(['alice-content'], 'alice-source.txt', { type: 'text/plain' });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            const res = await copyFile(ctx.alice.user.sessionToken, source.ownerId, source.mountId, source.id, {
                targetOwnerId: ctx.bob.user.id,
                targetMountId: mountId,
                targetParentId: bobRootId,
            });
            expect(res.status).toBe(403);
        });

        test('returns 404 for a missing source', async () => {
            const res = await copyFile(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'nonexistent-id', {
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(404);
        });

        test('returns 413 when the source file exceeds the per-file upload cap', async () => {
            const content = 'x'.repeat(2 * 1024 * 1024);
            const file = new File([content], 'big-source.txt', { type: 'text/plain' });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                const res = await copyFile(ctx.alice.user.sessionToken, source.ownerId, source.mountId, source.id, {
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: aliceRootId,
                });
                expect(res.status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
            }
        });

        // A file under the per-file cap that doesn't fit the free space is a full drive, as an upload is.
        test('returns 507 when the source file is under the upload cap but past the free space', async () => {
            const user = await createTestUser(`copy-full-${crypto.randomUUID()}@test.eigen.is`, 'pw-12345678', 'F');
            await getHome(user.id);
            const restore = await capUserDrive(user.id, mountId, 30);
            try {
                const rootId = (await driveGet(user.sessionToken, user.id, mountId, 'root')).id;
                const twenty = new File([new Uint8Array(20 * 1024 * 1024)], 'twenty.bin');
                const source = await driveUpload<DrivePath>(user.sessionToken, user.id, mountId, rootId, twenty);

                const res = await copyFile(user.sessionToken, user.id, mountId, source.id, {
                    targetOwnerId: user.id,
                    targetMountId: mountId,
                    targetParentId: rootId,
                });
                expect(res.status).toBe(507);
            } finally {
                await restore();
            }
        });

        describe('a folder whose child has lost its bytes', () => {
            let folder: DrivePath;

            beforeAll(async () => {
                const token = ctx.alice.user.sessionToken;
                const ownerId = ctx.alice.user.id;
                folder = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${aliceRootId}`, {
                    folderName: `half-${crypto.randomUUID()}`,
                });
                await driveUpload(token, ownerId, mountId, folder.id, new File(['kept'], 'kept.txt'));
                const gone = await driveUpload(token, ownerId, mountId, folder.id, new File(['gone'], 'gone.txt'));
                const { mount } = await (await getHome(ownerId)).drive.resolveFile(mountId, gone.id);
                expect(await mount.storage.delete(await mount.getStorageKey(gone.id))).toBe(true);
            });

            async function emptyFolder(): Promise<DrivePath> {
                return drivePost<DrivePath>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    `folder/${aliceRootId}`,
                    {
                        folderName: `half-target-${crypto.randomUUID()}`,
                    },
                );
            }

            function contents(target: DrivePath): Promise<DrivePath[]> {
                return driveGet<DrivePath[]>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    `folder/${target.id}`,
                );
            }

            test('a copy in one drive fails and leaves no folder in the target', async () => {
                const target = await emptyFolder();
                const { drive } = await getHome(ctx.alice.user.id);
                const trashBefore = await drive.listTrash(mountId);
                const res = await copyFile(ctx.alice.user.sessionToken, folder.ownerId, folder.mountId, folder.id, {
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: target.id,
                });
                expect(res.status).toBe(410);
                expect(await contents(target)).toEqual([]);
                // The half-built folder held only the copy's own files, so it went for good, not to the trash.
                expect(await drive.listTrash(mountId)).toEqual(trashBefore);
            });
        });

        // The per-file upload cap is for one file. A folder or a document is bounded by the free space.
        describe('the size limit of a folder copy', () => {
            let user: TestUser;
            let rootId: string;
            let folder: DrivePath;

            let restoreDrive: () => Promise<void>;

            // The drive holds 100 MB: its own cap and the server default both, as the larger of the two applies.
            beforeAll(async () => {
                user = await createTestUser(
                    `copy-size-${crypto.randomUUID()}@test.eigen.is`,
                    'testpassword123',
                    'Copy',
                );
                await getHome(user.id);
                restoreDrive = await capUserDrive(user.id, mountId, 100);
                rootId = (await driveGet(user.sessionToken, user.id, mountId, 'root')).id;
                folder = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${rootId}`, {
                    folderName: 'two-files',
                });
                for (const name of ['a.bin', 'b.bin']) {
                    const bytes = new Uint8Array(20 * 1024 * 1024);
                    await driveUpload(user.sessionToken, user.id, mountId, folder.id, new File([bytes], name));
                }
            });

            afterAll(async () => {
                await restoreDrive();
            });

            function copyFolder(): Promise<Response> {
                return copyFile(user.sessionToken, user.id, mountId, folder.id, {
                    targetOwnerId: user.id,
                    targetMountId: mountId,
                    targetParentId: rootId,
                });
            }

            test('a folder larger than the upload cap copies', async () => {
                const copied = await assertJson<DrivePath>(await copyFolder());
                expect(copied.size).toBe(40 * 1024 * 1024);
            });

            test('a folder larger than the free space is refused', async () => {
                // The folder and its first copy use 80 MB, so 20 MB is free.
                expect((await copyFolder()).status).toBe(507);
            });

            test('a document is sized without its version history, which the copy leaves behind', async () => {
                const doc = await drivePost<DrivePath>(
                    user.sessionToken,
                    user.id,
                    mountId,
                    `folder/${rootId}/create/doc`,
                    {
                        fileName: 'sized',
                    },
                );
                const saved = await authedRequest(
                    user.sessionToken,
                    `/drive/${user.id}/${mountId}/file/${doc.id}/versions/save`,
                    {
                        method: 'POST',
                    },
                );
                expect(saved.status).toBe(200);
                const drive = (await getHome(user.id)).drive;
                const versions = findOrFail(
                    await drive.getFolderContents(mountId, doc.id),
                    (child) => child.name === VERSIONS_FOLDER_NAME,
                );
                expect(versions.size).toBeGreaterThan(0);
                // The listing flushes the document's open databases, so its size is read after it.
                const { mount } = await drive.resolveFile(mountId, doc.id);
                const tree = await mount.listCopy(doc.id);
                const sized = await driveGet(user.sessionToken, user.id, mountId, `file/${doc.id}`);
                expect(copySize(tree)).toBe(sized.size - versions.size);
            });
        });

        // One writer makes every copy, so a copy is the same wherever it lands. The source is a folder on a team
        // drive, and Alice, a member, copies it.
        describe('a copy of a folder holding an image and a document', () => {
            let teamOwner: string;
            let teamMounts: string[];
            let folder: DrivePath;
            let image: DrivePath;
            let doc: DrivePath;
            const token = () => ctx.alice.user.sessionToken;

            beforeAll(async () => {
                const orgId = getServerConfig()?.orgId;
                if (!orgId) throw new Error('the server has no org');
                await authedRequest(token(), '/auth/organization/set-active', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ organizationId: orgId }),
                });
                const teamId = await createTeam(ctx, orgId, `Copy Parity ${crypto.randomUUID()}`);
                teamOwner = teamOwnerId(teamId);
                await addMember(ctx, teamId, ctx.alice.user.id);
                await addTeamMount(ctx, teamId, 'Parity A');
                await addTeamMount(ctx, teamId, 'Parity B');
                const mounts = await assertJson<MountInfo[]>(
                    await authedRequest(token(), `/drive/${teamOwner}/mounts`),
                );
                teamMounts = mounts.map((mount) => mount.id);
                expect(teamMounts).toHaveLength(2);

                const [sourceMount] = teamMounts;
                const drive = (await getHome(teamOwner)).drive;
                const root = await driveGet(token(), teamOwner, sourceMount, 'root');
                folder = await drivePost<DrivePath>(token(), teamOwner, sourceMount, `folder/${root.id}`, {
                    folderName: 'parity',
                });
                const uploaded = await driveUpload<DrivePath>(
                    token(),
                    teamOwner,
                    sourceMount,
                    folder.id,
                    new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' }),
                );
                // An upload gets its thumbnail in the background.
                image = await eventually(async () => {
                    const path = await drive.getPath(sourceMount, uploaded.id);
                    return path?.thumbnail ? path : undefined;
                }, 'the thumbnail of the source image');
                doc = await drivePost<DrivePath>(token(), teamOwner, sourceMount, `folder/${folder.id}/create/doc`, {
                    fileName: 'parity-doc',
                });
                const collab = await drive.getCollabDocument(sourceMount, doc.id);
                const paragraph = new Y.XmlElement('paragraph');
                paragraph.insert(0, [new Y.XmlText('quizzaciously written body')]);
                collab.doc.getXmlFragment('default').insert(0, [paragraph]);
                await drive.flushContainerDb(sourceMount, doc.id);
            });

            const targets: [string, () => { ownerId: string; mountId: string }][] = [
                ['in the same mount', () => ({ ownerId: teamOwner, mountId: teamMounts[0] })],
                ['to another mount of its owner', () => ({ ownerId: teamOwner, mountId: teamMounts[1] })],
                ["to another owner's drive", () => ({ ownerId: ctx.alice.user.id, mountId })],
            ];

            for (const [where, target] of targets) {
                test(`${where} has the source's history, thumbnail and search text, and shows once`, async () => {
                    const to = target();
                    const drive = (await getHome(to.ownerId)).drive;
                    const root = await driveGet(token(), to.ownerId, to.mountId, 'root');

                    const sse = await collectSSE(ctx.alice.user.id);
                    const res = await copyFile(token(), teamOwner, teamMounts[0], folder.id, {
                        targetOwnerId: to.ownerId,
                        targetMountId: to.mountId,
                        targetParentId: root.id,
                    });
                    const copied = await assertJson<DrivePath>(res);
                    await sse.next((event) => 'path' in event && event.path.id === copied.id);
                    await drainHomeDeliveries();
                    await Bun.sleep(50);
                    sse.stop();

                    const inside = await drive.getFolderContents(to.mountId, copied.id);
                    const copiedImage = findOrFail(inside, (child) => child.name === image.name);
                    const copiedDoc = findOrFail(inside, (child) => child.name === doc.name);

                    const pairs = [
                        [copied, folder],
                        [copiedImage, image],
                        [copiedDoc, doc],
                    ];
                    for (const [copy, source] of pairs) {
                        const events = (await drive.getFileHistory(to.mountId, copy.id))
                            .filter((event) => event.pathId === copy.id)
                            .map((event) => ({ eventType: event.eventType, details: event.details }));
                        expect(events).toEqual([
                            {
                                eventType: 'copied',
                                details: {
                                    sourceOwnerId: teamOwner,
                                    sourceMountId: teamMounts[0],
                                    sourcePathId: source.id,
                                },
                            },
                        ]);
                    }

                    const { mount } = await drive.resolveFile(to.mountId, copied.id);
                    const written = new Set([copied.id, ...mount.collectDescendantIds(copied.id)]);
                    const shown = sse.events
                        .filter((event) => 'path' in event && written.has(event.path.id))
                        .filter((event) => event.type !== SSEventType.DRIVE_FILE_HISTORY_UPDATED)
                        .map((event) => ('path' in event ? `${event.type} ${event.path.id}` : event.type));
                    expect(shown).toEqual([`${SSEventType.DRIVE_FOLDER_CREATED} ${copied.id}`]);

                    expect(copiedImage.thumbnail).toBe(`${copiedImage.id}.webp`);
                    expect(await getThumbnail(mount.thumbsDir, copiedImage.id)).not.toBeNull();
                    expect(copiedImage.details).toEqual({
                        width: image.details?.width,
                        height: image.details?.height,
                    });
                    expect(image.details?.originalName).toBe('photo.png');
                    expect(image.details?.width).toBe(4);

                    await flushContentReindex(drive);
                    const found = drive.search({ q: 'quizzaciously', limit: 20 }).map((hit) => hit.id);
                    expect(found).toContain(copiedDoc.id);
                });
            }
        });

        // A writer, and an owner who shares a folder with them for writing.
        async function writerAndInbox(): Promise<{ writer: TestUser; owner: TestUser; inbox: DrivePath }> {
            const id = crypto.randomUUID();
            const writer = await createTestUser(`copy-writer-${id}@test.eigen.is`, 'pw-12345678', 'W');
            const owner = await createTestUser(`copy-owner-${id}@test.eigen.is`, 'pw-12345678', 'O');
            const ownerRoot = await driveGet(owner.sessionToken, owner.id, mountId, 'root');
            const inbox = await drivePost<DrivePath>(owner.sessionToken, owner.id, mountId, `folder/${ownerRoot.id}`, {
                folderName: 'inbox',
            });
            await drivePut(owner.sessionToken, owner.id, mountId, `path/${inbox.id}/acl`, {
                add: [{ id: writer.email, read: true, write: true }],
            });
            return { writer, owner, inbox };
        }

        // A folder `half` in the user's root: a-kept.bin copies, and z-gone.bin has lost its bytes, so a
        // copy of the folder fails after its first file. putBackBytes makes it copyable again.
        async function folderWithLostFile(
            user: TestUser,
        ): Promise<{ half: DrivePath; putBackBytes: () => Promise<unknown> }> {
            const root = await driveGet(user.sessionToken, user.id, mountId, 'root');
            const half = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${root.id}`, {
                folderName: 'half',
            });
            const kept = new Uint8Array(1024 * 1024);
            await driveUpload(user.sessionToken, user.id, mountId, half.id, new File([kept], 'a-kept.bin'));
            const gone = await driveUpload(
                user.sessionToken,
                user.id,
                mountId,
                half.id,
                new File(['gone'], 'z-gone.bin'),
            );
            const { mount } = await (await getHome(user.id)).drive.resolveFile(mountId, gone.id);
            const key = await mount.getStorageKey(gone.id);
            expect(await mount.storage.delete(key)).toBe(true);
            return { half, putBackBytes: () => mount.storage.write(key, Buffer.from('gone')) };
        }

        // F holds S1 with one.txt in it, and an empty S2.
        async function sourceTree(user: TestUser, name: string): Promise<{ top: DrivePath; s2: DrivePath }> {
            const root = await driveGet(user.sessionToken, user.id, mountId, 'root');
            const top = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${root.id}`, {
                folderName: name,
            });
            const s1 = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${top.id}`, {
                folderName: 'S1',
            });
            await driveUpload(user.sessionToken, user.id, mountId, s1.id, new File(['one'], 'one.txt'));
            const s2 = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${top.id}`, {
                folderName: 'S2',
            });
            return { top, s2 };
        }

        // Every path under the folder, as names relative to it.
        async function treeOf(ownerId: string, folderId: string, prefix = ''): Promise<string[]> {
            const drive = (await getHome(ownerId)).drive;
            const names: string[] = [];
            for (const child of await drive.getFolderContents(mountId, folderId)) {
                names.push(`${prefix}${child.name}`);
                if (child.type === DRIVE_TYPE_FOLDER)
                    names.push(...(await treeOf(ownerId, child.id, `${prefix}${child.name}/`)));
            }
            return names.toSorted();
        }

        // The copy lists the source before it writes. Whatever lands in the source while it runs, its own
        // output included, is not part of it, so a copy can't keep copying what it just wrote.
        describe('a copy whose own output lands in its source', () => {
            test('in one drive, a target moved into the source meanwhile gets the source as it was', async () => {
                const user = await createTestUser(
                    `copy-chase-${crypto.randomUUID()}@test.eigen.is`,
                    'pw-12345678',
                    'C',
                );
                const { top, s2 } = await sourceTree(user, 'F');
                const root = await driveGet(user.sessionToken, user.id, mountId, 'root');
                const target = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${root.id}`, {
                    folderName: 'G',
                });

                const { mount } = await (await getHome(user.id)).drive.resolveFile(mountId, top.id);
                const createFileFromTemp = mount.createFileFromTemp.bind(mount);
                let moved = 0;
                const moveTarget = spyOn(mount, 'createFileFromTemp').mockImplementationOnce(async (...args) => {
                    const created = await createFileFromTemp(...args);
                    const move = await authedRequest(
                        user.sessionToken,
                        `/drive/${user.id}/${mountId}/path/${target.id}/move`,
                        {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ targetParentId: s2.id }),
                        },
                    );
                    moved = move.status;
                    return created;
                });
                // A walk that follows its own output never ends, so the listings are bounded here.
                const listFolder = mount.listFolder.bind(mount);
                let listings = 0;
                const bound = spyOn(mount, 'listFolder').mockImplementation(async (parentId) => {
                    listings++;
                    if (listings > 50) throw new Error('the copy follows its own output');
                    return listFolder(parentId);
                });
                let res: Response;
                try {
                    res = await copyFile(user.sessionToken, user.id, mountId, top.id, {
                        targetOwnerId: user.id,
                        targetMountId: mountId,
                        targetParentId: target.id,
                    });
                } finally {
                    moveTarget.mockRestore();
                    bound.mockRestore();
                }

                expect(moved).toBe(200);
                const copied = await assertJson<DrivePath>(res);
                expect(await treeOf(user.id, copied.id)).toEqual(['S1', 'S1/one.txt', 'S2']);
            });

            test('across drives, an opposite copy landing in the source meanwhile is not copied', async () => {
                const { writer, owner, inbox } = await writerAndInbox();
                const { top, s2 } = await sourceTree(writer, 'X');

                // The opposite copy runs once this one wrote its first file into the inbox, so it copies that
                // partial output back into the source.
                const { mount } = await (await getHome(owner.id)).drive.resolveFile(mountId, inbox.id);
                const createFileFromTemp = mount.createFileFromTemp.bind(mount);
                let opposite = 0;
                const copyBack = spyOn(mount, 'createFileFromTemp').mockImplementationOnce(async (...args) => {
                    const created = await createFileFromTemp(...args);
                    const back = await copyFile(writer.sessionToken, owner.id, mountId, inbox.id, {
                        targetOwnerId: writer.id,
                        targetMountId: mountId,
                        targetParentId: s2.id,
                    });
                    opposite = back.status;
                    return created;
                });
                let res: Response;
                try {
                    res = await copyFile(writer.sessionToken, writer.id, mountId, top.id, {
                        targetOwnerId: owner.id,
                        targetMountId: mountId,
                        targetParentId: inbox.id,
                    });
                } finally {
                    copyBack.mockRestore();
                }

                expect(opposite).toBe(200);
                const copied = await assertJson<DrivePath>(res);
                expect(await treeOf(owner.id, copied.id)).toEqual(['S1', 'S1/one.txt', 'S2']);
            });
        });

        // The writer can't empty another owner's trash, so a copy that fails there leaves nothing behind
        // that would count against that owner's space.
        test("a failed copy into another owner's folder leaves their trash and their space as they were", async () => {
            const { writer, owner, inbox } = await writerAndInbox();
            const { half, putBackBytes } = await folderWithLostFile(writer);

            const ownerDrive = (await getHome(owner.id)).drive;
            const used = await ownerDrive.size(mountId);
            const copyHalf = () =>
                copyFile(writer.sessionToken, writer.id, mountId, half.id, {
                    targetOwnerId: owner.id,
                    targetMountId: mountId,
                    targetParentId: inbox.id,
                });
            const statuses: number[] = [];
            for (let attempt = 0; attempt < 3; attempt++) statuses.push((await copyHalf()).status);

            expect(statuses).toEqual([410, 410, 410]);
            expect(await ownerDrive.listTrash(mountId)).toEqual([]);
            expect(await ownerDrive.size(mountId)).toBe(used);
            expect(await ownerDrive.getFolderContents(mountId, inbox.id)).toEqual([]);

            // Once the bytes are back, the retry lands under the name it asked for.
            await putBackBytes();
            const copied = await assertJson<DrivePath>(await copyHalf());
            expect(copied.name).toBe('half');
            expect(await treeOf(owner.id, copied.id)).toEqual(['a-kept.bin', 'z-gone.bin']);
        });

        // A failed copy deletes for good only what it wrote. A file the owner moved into the half-built
        // folder meanwhile goes to the trash with the folder, so the owner can still restore it.
        test("a failed copy into another owner's folder keeps a file the owner moved into it", async () => {
            const { writer, owner, inbox } = await writerAndInbox();
            const { half } = await folderWithLostFile(writer);

            const ownerRoot = await driveGet(owner.sessionToken, owner.id, mountId, 'root');
            const mine = await driveUpload<DrivePath>(
                owner.sessionToken,
                owner.id,
                mountId,
                ownerRoot.id,
                new File(['mine'], 'mine.txt'),
            );
            const ownerUser = await getUserById(owner.id);
            if (!ownerUser) throw new Error('the owner has no user row');
            const ownerDrive = (await getHome(owner.id)).drive;
            const { mount } = await ownerDrive.resolveFile(mountId, inbox.id);
            const createFileFromTemp = mount.createFileFromTemp.bind(mount);
            const moveIn = spyOn(mount, 'createFileFromTemp').mockImplementationOnce(async (parentId, ...rest) => {
                const created = await createFileFromTemp(parentId, ...rest);
                await ownerDrive.movePath(mountId, mine.id, parentId, ownerUser);
                return created;
            });
            let res: Response;
            try {
                res = await copyFile(writer.sessionToken, writer.id, mountId, half.id, {
                    targetOwnerId: owner.id,
                    targetMountId: mountId,
                    targetParentId: inbox.id,
                });
            } finally {
                moveIn.mockRestore();
            }

            expect(res.status).toBe(410);
            const trashed = await ownerDrive.listTrash(mountId);
            expect(trashed.map((path) => path.name)).toEqual(['half']);
            await ownerDrive.restorePath(mountId, trashed[0].id, ownerUser);
            expect(await treeOf(owner.id, inbox.id)).toEqual(['half', 'half/a-kept.bin', 'half/mine.txt']);
        });

        // The owner copies `half` into the inbox they share with the writer. Once the copy's first file has
        // landed, meanwhile runs with the half-built folder.
        async function copyIntoInbox(
            owner: TestUser,
            half: DrivePath,
            inbox: DrivePath,
            meanwhile: (folderId: string) => Promise<unknown>,
        ): Promise<Response> {
            const { mount } = await (await getHome(owner.id)).drive.resolveFile(mountId, half.id);
            const createFileFromTemp = mount.createFileFromTemp.bind(mount);
            const spy = spyOn(mount, 'createFileFromTemp').mockImplementationOnce(async (parentId, ...rest) => {
                const created = await createFileFromTemp(parentId, ...rest);
                await meanwhile(parentId);
                return created;
            });
            try {
                return await copyFile(owner.sessionToken, owner.id, mountId, half.id, {
                    targetOwnerId: owner.id,
                    targetMountId: mountId,
                    targetParentId: inbox.id,
                });
            } finally {
                spy.mockRestore();
            }
        }

        // A copy in one drive cleans up as a copy to another drive does. A file the writer moved into the
        // half-built folder goes to the trash with it, so it can still be restored.
        test('a failed copy in one drive keeps a file someone else moved into it', async () => {
            const { writer, owner, inbox } = await writerAndInbox();
            const { half } = await folderWithLostFile(owner);
            const mine = await driveUpload<DrivePath>(
                writer.sessionToken,
                owner.id,
                mountId,
                inbox.id,
                new File(['mine'], 'mine.txt'),
            );
            const writerUser = await getUserById(writer.id);
            const ownerUser = await getUserById(owner.id);
            if (!writerUser || !ownerUser) throw new Error('a test user has no user row');
            const ownerDrive = (await getHome(owner.id)).drive;

            const res = await copyIntoInbox(owner, half, inbox, (folderId) =>
                ownerDrive.movePath(mountId, mine.id, folderId, writerUser),
            );

            expect(res.status).toBe(410);
            const trashed = await ownerDrive.listTrash(mountId);
            expect(trashed.map((path) => path.name)).toEqual(['half']);
            await ownerDrive.restorePath(mountId, trashed[0].id, ownerUser);
            expect(await treeOf(owner.id, inbox.id)).toEqual(['half', 'half/a-kept.bin', 'half/mine.txt']);
        });

        // A part of the copy that got its own sharing meanwhile is no longer only the copy's.
        test('a failed copy whose half-built folder was shared meanwhile goes to the trash', async () => {
            const { owner, inbox } = await writerAndInbox();
            const { half } = await folderWithLostFile(owner);
            const ownerUser = await getUserById(owner.id);
            if (!ownerUser) throw new Error('the owner has no user row');
            const ownerDrive = (await getHome(owner.id)).drive;

            const res = await copyIntoInbox(owner, half, inbox, (folderId) =>
                drivePut(owner.sessionToken, owner.id, mountId, `path/${folderId}/acl`, {
                    add: [{ id: ctx.bob.user.email, read: true, write: false }],
                }),
            );

            expect(res.status).toBe(410);
            const trashed = await ownerDrive.listTrash(mountId);
            expect(trashed.map((path) => path.name)).toEqual(['half']);
            await ownerDrive.restorePath(mountId, trashed[0].id, ownerUser);
            expect(await treeOf(owner.id, inbox.id)).toEqual(['half', 'half/a-kept.bin']);
        });

        // A copy to another drive writes the same listing as a copy in one mount, so it leaves versions/
        // behind too. mount-copy.test.ts pins the copy in one mount.
        test('copying a container across drives starts the copy without the source versions/', async () => {
            const { writer, owner, inbox } = await writerAndInbox();
            const root = await driveGet(writer.sessionToken, writer.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                writer.sessionToken,
                writer.id,
                mountId,
                `folder/${root.id}/create/doc`,
                { fileName: 'copy-across-versions' },
            );
            const saved = await authedRequest(
                writer.sessionToken,
                `/drive/${writer.id}/${mountId}/file/${doc.id}/versions/save`,
                { method: 'POST' },
            );
            expect(saved.status).toBe(200);

            const res = await copyFile(writer.sessionToken, writer.id, mountId, doc.id, {
                targetOwnerId: owner.id,
                targetMountId: mountId,
                targetParentId: inbox.id,
            });
            const copied = await assertJson<DrivePath>(res);

            const sourceDrive = (await getHome(writer.id)).drive;
            const sourceNames = (await sourceDrive.getFolderContents(mountId, doc.id)).map((c) => c.name);
            expect(sourceNames).toContain('versions');
            const targetDrive = (await getHome(owner.id)).drive;
            const copiedNames = (await targetDrive.getFolderContents(mountId, copied.id)).map((c) => c.name);
            expect(copiedNames).toContain('data.db');
            expect(copiedNames).not.toContain('versions');
        });

        test("a copy into a stranger's folder is refused before the stranger's limits are read", async () => {
            const id = crypto.randomUUID();
            const caller = await createTestUser(`copy-stranger-${id}@test.eigen.is`, 'pw-12345678', 'C');
            const owner = await createTestUser(`copy-private-${id}@test.eigen.is`, 'pw-12345678', 'O');
            const ownerRoot = await driveGet(owner.sessionToken, owner.id, mountId, 'root');
            const callerRoot = await driveGet(caller.sessionToken, caller.id, mountId, 'root');
            const source = await driveUpload<DrivePath>(
                caller.sessionToken,
                caller.id,
                mountId,
                callerRoot.id,
                new File(['mine'], 'mine.txt', { type: 'text/plain' }),
            );
            const readLimit = spyOn(enforcement, 'enforceMountQuota');
            try {
                const res = await copyFile(caller.sessionToken, caller.id, mountId, source.id, {
                    targetOwnerId: owner.id,
                    targetMountId: mountId,
                    targetParentId: ownerRoot.id,
                });
                expect(res.status).toBe(403);
                expect(readLimit).not.toHaveBeenCalled();
            } finally {
                readLimit.mockRestore();
            }
        });

        // A copy into another owner's home can outlast both homes' idle timeout. It holds each until it ends, so
        // neither closes its databases under the copy.
        describe('a copy that outlasts the idle timeout', () => {
            const USER_IDLE_MS = 5 * 60_000;

            afterEach(() => jest.useRealTimers());

            test('lands in a folder another owner shared, and both homes idle after it', async () => {
                const id = crypto.randomUUID();
                const writer = await createTestUser(`copy-hold-writer-${id}@test.eigen.is`, 'pw-12345678', 'W');
                const owner = await createTestUser(`copy-hold-owner-${id}@test.eigen.is`, 'pw-12345678', 'O');
                const ownerRoot = await driveGet(owner.sessionToken, owner.id, mountId, 'root');
                const shared = await drivePost<DrivePath>(
                    owner.sessionToken,
                    owner.id,
                    mountId,
                    `folder/${ownerRoot.id}`,
                    {
                        folderName: 'shared-for-copy',
                    },
                );
                await drivePut(owner.sessionToken, owner.id, mountId, `path/${shared.id}/acl`, {
                    add: [{ id: writer.email, read: true, write: true }],
                });
                const writerRoot = await driveGet(writer.sessionToken, writer.id, mountId, 'root');
                const source = await driveUpload<DrivePath>(
                    writer.sessionToken,
                    writer.id,
                    mountId,
                    writerRoot.id,
                    new File(['slow-copy'], 'slow-copy.txt', { type: 'text/plain' }),
                );

                const sourceHome = await getHome(writer.id);
                const targetHome = await getHome(owner.id);
                const { mount } = await sourceHome.drive.resolveFile(mountId, source.id);
                const readFile = mount.readFile.bind(mount);
                let closingMidCopy: boolean[] | undefined;
                // The copy reads the source between its checks and its write, which is where the clock jumps.
                const slowDownload = spyOn(mount, 'readFile').mockImplementation(async (pathId) => {
                    jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                    closingMidCopy = [sourceHome.closing, targetHome.closing];
                    return readFile(pathId);
                });
                jest.useFakeTimers();
                // A request re-arms the idle on the fake clock, so only the copy's holds can keep the homes past it.
                sourceHome.touch();
                targetHome.touch();
                try {
                    const res = await copyFile(writer.sessionToken, writer.id, mountId, source.id, {
                        targetOwnerId: owner.id,
                        targetMountId: mountId,
                        targetParentId: shared.id,
                    });
                    expect((await assertJson<DrivePath>(res)).size).toBe('slow-copy'.length);
                } finally {
                    slowDownload.mockRestore();
                }
                expect(closingMidCopy).toEqual([false, false]);

                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                expect([sourceHome.closing, targetHome.closing]).toEqual([true, true]);
                jest.useRealTimers();
                await Promise.all([sourceHome.close(), targetHome.close()]);
            });
        });
    });

    describe('/import-from-drive', () => {
        let targetDocId: string;

        beforeAll(async () => {
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'Target doc' },
            );
            targetDocId = doc.id;
        });

        test("rejects Alice importing from Bob's private file", async () => {
            const file = new File(['bob-secret-docx'], 'bobs.docx', {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            const bobsFile = await driveUpload<DrivePath>(
                ctx.bob.user.sessionToken,
                ctx.bob.user.id,
                mountId,
                bobRootId,
                file,
            );

            const res = await importFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, targetDocId, {
                sourceOwnerId: bobsFile.ownerId,
                sourceMountId: bobsFile.mountId,
                sourcePathId: bobsFile.id,
            });
            expect([403, 404]).toContain(res.status);
        });

        test('returns 404 for a missing source', async () => {
            const res = await importFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, targetDocId, {
                sourceOwnerId: ctx.alice.user.id,
                sourceMountId: mountId,
                sourcePathId: 'nonexistent-id',
            });
            expect(res.status).toBe(404);
        });

        test('returns 400 for a folder source', async () => {
            const folder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${aliceRootId}`,
                { folderName: 'not-a-source.docx' },
            );
            const res = await importFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, targetDocId, {
                sourceOwnerId: folder.ownerId,
                sourceMountId: folder.mountId,
                sourcePathId: folder.id,
            });
            expect(res.status).toBe(400);
        });

        test('returns 413 when the source file exceeds the target quota', async () => {
            const content = 'x'.repeat(2 * 1024 * 1024);
            const file = new File([content], 'big.docx', {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                const res = await importFromDrive(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    targetDocId,
                    { sourceOwnerId: source.ownerId, sourceMountId: source.mountId, sourcePathId: source.id },
                );
                expect(res.status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
            }
        });

        // The recorded size is a claim: a source that grew since it was written must be refused as it is
        // read, not buffered whole into the heap of the thread that serves every app.
        test('returns 413 when the file outgrew the size its row claims', async () => {
            const file = new File(['small for now'], 'grew.docx', {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );
            const home = await getHome(ctx.alice.user.id);
            const mount = findOrFail(home.drive.getMounts(), (m) => m.id === mountId);
            await mount.storage.write(await mount.getStorageKey(source.id), Buffer.alloc(2 * 1024 * 1024, 0x41));

            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                const res = await importFromDrive(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    targetDocId,
                    { sourceOwnerId: source.ownerId, sourceMountId: source.mountId, sourcePathId: source.id },
                );
                expect(res.status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
            }
        });
    });
});
