import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import {
    assertJson,
    authedRequest,
    driveGet,
    drivePost,
    driveUpload,
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
            body: JSON.stringify(body),
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

            const { copyPathAcross } = await import('../../lib/drive/copy-across');
            const { getHome } = await import('../../lib/home');
            const { getUserById } = await import('../../lib/user');
            const home = await getHome(ownerId);
            const user = await getUserById(ownerId);
            const copied = await copyPathAcross(
                home.drive,
                mountId,
                doc.id,
                home.drive,
                mountId,
                aliceRootId,
                'copy-across-versions-copy',
                user!,
            );

            const sourceNames = (await home.drive.getFolderContents(mountId, doc.id)).map((c) => c.name);
            expect(sourceNames).toContain('versions');
            const copiedNames = (await home.drive.getFolderContents(mountId, copied.id)).map((c) => c.name);
            expect(copiedNames).toContain('data.db');
            expect(copiedNames).not.toContain('versions');
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
    });
});
