import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { authedRequest, driveGet, drivePost, driveUpload, driveUploadMultiple, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Streaming Upload', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let folderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${root.id}`,
            { folderName: 'Streaming Tests' },
        );
        folderId = folder.id;
    });

    test('upload preserves file content', async () => {
        const content = 'streaming upload test content';
        const file = new File([content], 'stream-test.txt', { type: 'text/plain' });
        const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, file);

        expect(data.name).toBe('stream-test.txt');
        expect(data.size).toBe(content.length);
        expect(data.mimeType).toStartWith('text/plain');

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${data.id}/download`,
        );
        const downloaded = new TextDecoder().decode(await res.arrayBuffer());
        expect(downloaded).toBe(content);
    });

    test('upload binary file preserves content', async () => {
        const bytes = new Uint8Array(1024);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        const file = new File([bytes], 'binary.bin', { type: 'application/octet-stream' });
        const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, file);

        expect(data.size).toBe(1024);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${data.id}/download`,
        );
        const downloaded = new Uint8Array(await res.arrayBuffer());
        expect(downloaded.length).toBe(1024);
        for (let i = 0; i < 1024; i++) {
            expect(downloaded[i]).toBe(i % 256);
        }
    });

    test('duplicate filename gets unique name', async () => {
        const file1 = new File(['first'], 'duplicate.txt', { type: 'text/plain' });
        const file2 = new File(['second'], 'duplicate.txt', { type: 'text/plain' });

        const data1 = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, file1);
        const data2 = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, file2);

        expect(data1.name).toBe('duplicate.txt');
        expect(data2.name).toBe('duplicate (2).txt');
    });

    test('upload to non-existent folder returns 404', async () => {
        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/nonexistent-folder-id`,
            {
                method: 'POST',
                body: formData,
            },
        );
        expect(res.status).toBe(404);
    });

    test('Bob cannot upload to Alice folder without permission', async () => {
        const file = new File(['unauthorized'], 'hack.txt', { type: 'text/plain' });
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${folderId}`,
            {
                method: 'POST',
                body: formData,
            },
        );
        expect([403, 404, 500]).toContain(res.status);
    });

    test('empty request body returns 400', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${folderId}`,
            {
                method: 'POST',
                headers: { 'content-type': 'multipart/form-data; boundary=----TestBoundary' },
                body: '------TestBoundary--\r\n',
            },
        );
        expect(res.status).toBe(400);
    });

    test('originalName stored in details', async () => {
        const file = new File(['test'], 'original-name.txt', { type: 'text/plain' });
        const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, file);

        expect(data.details).toBeDefined();
        expect(data.details!.originalName).toBe('original-name.txt');
    });

    test('upload multiple files in one request', async () => {
        const file1 = new File(['content one'], 'multi-1.txt', { type: 'text/plain' });
        const file2 = new File(['content two'], 'multi-2.txt', { type: 'text/plain' });
        const file3 = new File(['content three'], 'multi-3.txt', { type: 'text/plain' });

        const results = await driveUploadMultiple(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folderId,
            [file1, file2, file3],
        );

        expect(results).toHaveLength(3);
        expect(results[0].name).toBe('multi-1.txt');
        expect(results[1].name).toBe('multi-2.txt');
        expect(results[2].name).toBe('multi-3.txt');

        // Verify all files appear in folder listing
        const contents = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${folderId}`,
        );
        const names = contents.map((c) => c.name);
        expect(names).toContain('multi-1.txt');
        expect(names).toContain('multi-2.txt');
        expect(names).toContain('multi-3.txt');
    });

    test('upload multiple files with duplicate names', async () => {
        const file1 = new File(['a'], 'same-name.txt', { type: 'text/plain' });
        const file2 = new File(['b'], 'same-name.txt', { type: 'text/plain' });

        const results = await driveUploadMultiple(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folderId,
            [file1, file2],
        );

        expect(results).toHaveLength(2);
        expect(results[0].name).toBe('same-name.txt');
        expect(results[1].name).toBe('same-name (2).txt');
    });

    test('upload exceeding the server max upload size returns 413', async () => {
        // Read-then-restore so the finally can't pin a stale default into the shared settings store.
        const before = await (await authedRequest(ctx.alice.user.sessionToken, '/settings/server')).json();
        const previousMax = before.quotas.maxUploadSizeMB;
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 1 } }),
        });
        try {
            const file = new File(['x'.repeat(2 * 1024 * 1024)], 'over-limit.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${folderId}`,
                { method: 'POST', body: formData },
            );
            expect(res.status).toBe(413);
            // The parser's MaxFileSizeExceededError mapping in streamFilesToTemp
            expect(await res.text()).toBe('File exceeds maximum upload size');
        } finally {
            await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quotas: { maxUploadSizeMB: previousMax } }),
            });
        }
    });

    test('upload to a mount already at quota returns 507 before the body is read', async () => {
        // Seed so the mount has bytes, then shrink the live mount quota to exactly what's used
        // (mirrors editor.test.ts — team overrides only *raise* the quota). remaining <= 0 makes
        // getUploadMaxSize throw up front: even this tiny file, which the parser's maxFileSize
        // would never reject, must bounce with 507.
        const seed = new File(['seed'], 'quota-seed.txt', { type: 'text/plain' });
        await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, seed);

        const home = await getHome(ctx.alice.user.id);
        const snapshot = { ...home.drive.getMountConfig(aliceMountId) };
        const usedMB = (await home.drive.size(aliceMountId)) / (1024 * 1024);
        await home.drive.updateMount({ ...snapshot, maxSizeMB: usedMB }, true);
        try {
            const file = new File(['tiny'], 'over-quota.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${folderId}`,
                { method: 'POST', body: formData },
            );
            expect(res.status).toBe(507);
            expect(await res.text()).toBe('Insufficient Storage');
        } finally {
            await home.drive.updateMount(snapshot, true);
        }
    });
});
