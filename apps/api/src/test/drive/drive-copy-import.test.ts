import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { copyPathAcross, copySize } from '../../lib/drive/copy-across';
import { getHome } from '../../lib/home';
import { getUserById } from '../../lib/user';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import type { TestUser } from '../setup';
import {
    assertJson,
    authedRequest,
    createTestUser,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    findOrFail,
    getTestContext,
    setMaxUploadSizeMB,
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

        test('returns 413 when the source file exceeds the target quota', async () => {
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
                const res = await copyFile(ctx.alice.user.sessionToken, folder.ownerId, folder.mountId, folder.id, {
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: target.id,
                });
                expect(res.status).toBe(410);
                expect(await contents(target)).toEqual([]);
            });

            test('a copy to another drive fails and leaves no folder in the target', async () => {
                const target = await emptyFolder();
                const home = await getHome(ctx.alice.user.id);
                const user = await getUserById(ctx.alice.user.id);
                if (!user) throw new Error('alice has no user row');
                const copy = copyPathAcross(home.drive, folder, home.drive, mountId, target.id, folder.name, user);
                expect(copy).rejects.toThrow();
                await copy.catch(() => {});
                expect(await contents(target)).toEqual([]);
            });
        });

        // The per-file upload cap is for one file. A folder or a document is bounded by the free space.
        describe('the size limit of a folder copy', () => {
            let user: TestUser;
            let rootId: string;
            let folder: DrivePath;

            // A new home takes the server's default drive size, so this user's drive holds 100 MB.
            beforeAll(async () => {
                const before = getServerSettings().quotas.defaultMountMaxSizeMB;
                await updateServerSettings({ quotas: { defaultMountMaxSizeMB: 100 } });
                try {
                    user = await createTestUser(
                        `copy-size-${crypto.randomUUID()}@test.eigen.is`,
                        'testpassword123',
                        'Copy',
                    );
                    await getHome(user.id);
                } finally {
                    await updateServerSettings({ quotas: { defaultMountMaxSizeMB: before } });
                }
                rootId = (await driveGet(user.sessionToken, user.id, mountId, 'root')).id;
                folder = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${rootId}`, {
                    folderName: 'two-files',
                });
                for (const name of ['a.bin', 'b.bin']) {
                    const bytes = new Uint8Array(20 * 1024 * 1024);
                    await driveUpload(user.sessionToken, user.id, mountId, folder.id, new File([bytes], name));
                }
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
                const sized = await driveGet(user.sessionToken, user.id, mountId, `file/${doc.id}`);
                expect(await copySize(drive, sized)).toBe(sized.size - versions.size);
            });
        });

        // The cross-mount bridge walks a container's children itself, so its versions/ skip is
        // separate from the same-mount copy's (pinned in mount-copy.test.ts).
        test('copying a container across drives starts the copy without the source versions/', async () => {
            const token = ctx.alice.user.sessionToken;
            const ownerId = ctx.alice.user.id;
            const doc = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${aliceRootId}/create/doc`, {
                fileName: 'copy-across-versions',
            });
            const saved = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${doc.id}/versions/save`, {
                method: 'POST',
            });
            expect(saved.status).toBe(200);

            const home = await getHome(ownerId);
            const user = await getUserById(ownerId);
            if (!user) throw new Error('alice has no user row');
            const copied = await copyPathAcross(
                home.drive,
                doc,
                home.drive,
                mountId,
                aliceRootId,
                'copy-across-versions-copy',
                user,
            );

            const sourceNames = (await home.drive.getFolderContents(mountId, doc.id)).map((c) => c.name);
            expect(sourceNames).toContain('versions');
            const copiedNames = (await home.drive.getFolderContents(mountId, copied.id)).map((c) => c.name);
            expect(copiedNames).toContain('data.db');
            expect(copiedNames).not.toContain('versions');
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
                const download = sourceHome.drive.downloadFile.bind(sourceHome.drive);
                let closingMidCopy: boolean[] | undefined;
                // The copy reads the source between its checks and its write, which is where the clock jumps.
                const slowDownload = spyOn(sourceHome.drive, 'downloadFile').mockImplementation(
                    async (sourceMountId, pathId) => {
                        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                        closingMidCopy = [sourceHome.closing, targetHome.closing];
                        return download(sourceMountId, pathId);
                    },
                );
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
