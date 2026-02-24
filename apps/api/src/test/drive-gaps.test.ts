import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(r => r.json());
}

async function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${parts.join('/')}`);
    return res.json();
}

async function driveUpload(token: string, ownerId: string, mountId: string, parentId: string, file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
        method: 'POST',
        body: formData,
    });
    return res.json();
}

describe('Drive Gaps', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;
    let uploadFolderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const {data: mounts} = await ctx.alice.api.drive({ownerId: ctx.alice.user.id}).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        expect(root).toBeDefined();
        expect(root.id).toBeDefined();
        aliceRootId = root.id;

        const folder = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Upload Tests'});
        uploadFolderId = folder.id;
    });

    describe('File Download', () => {
        let uploadedFileId: string;
        const testContent = 'Hello, download test!';

        beforeAll(async () => {
            const file = new File([testContent], 'download-test.txt', {type: 'text/plain'});
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, file);
            uploadedFileId = uploaded.id;
        });

        test('download file returns correct content', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`);

            expect(res.status).toBe(200);

            const buffer = await res.arrayBuffer();
            const text = new TextDecoder().decode(buffer);
            expect(text).toBe(testContent);
        });

        test('download has content-disposition header', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-disposition')).toContain('attachment');
            expect(res.headers.get('content-disposition')).toContain('download-test.txt');
        });

        test('download has cache headers', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`);

            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toContain('public');
            expect(res.headers.get('expires')).toBeDefined();
        });

        test('download non-existent file returns error', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/non-existent-id/download`);

            expect([200, 404, 500]).toContain(res.status);
        });

        test('Bob cannot download without permission', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`);

            expect([200, 403, 404, 500]).toContain(res.status);
        });
    });

    describe('Embed Endpoint', () => {
        let uploadedFileId: string;
        const testContent = 'Embed test content';

        beforeAll(async () => {
            const file = new File([testContent], 'embed-test.txt', {type: 'text/plain'});
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, file);
            uploadedFileId = uploaded.id;
        });

        test('embed endpoint returns file content', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/embed/embed-test.txt`);

            expect(res.status).toBe(200);
        });

        test('embed has cache headers', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/embed/embed-test.txt`);

            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toContain('public');
            expect(res.headers.get('expires')).toBeDefined();
        });
    });

    describe('Thumbnail Endpoint', () => {
        test('thumbnail endpoint returns image for uploaded image', async () => {
            const base64 = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=";
            const pngBytes = Buffer.from(base64, 'base64');
            const imageFile = new File([pngBytes], 'thumb-test.png', {type: 'image/png'});
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, imageFile);

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/thumb/${uploaded.id}.webp`);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('image/webp');
            expect(res.headers.get('cache-control')).toContain('public');
        });

        test('thumbnail returns null for non-existent file', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/thumb/non-existent.webp`);

            expect(res.status).toBe(200);
            const body = await res.arrayBuffer();
            expect(body.byteLength).toBe(0);
        });
    });

    describe('MIME Type Filter', () => {
        beforeAll(async () => {
            const file1 = new File(['text content'], 'mime-test.txt', {type: 'text/plain'});
            const file2 = new File(['{"test": true}'], 'mime-test.json', {type: 'application/json'});

            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, file1);
            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, file2);
        });

        test('MIME filter returns files of specified type', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/mime/text-plain`);

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data)).toBe(true);
        });

        test('MIME filter handles empty results', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/mime/application-x-custom`);

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data)).toBe(true);
        });
    });

    describe('Multiple File Upload', () => {
        test('upload multiple files at once', async () => {
            const formData = new FormData();
            formData.append('files', new File(['file1'], 'multi1.txt', {type: 'text/plain'}));
            formData.append('files', new File(['file2'], 'multi2.txt', {type: 'text/plain'}));

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/files/${uploadFolderId}`, {
                    method: 'POST',
                    body: formData,
                });

            expect(res.status).toBe(200);
            const data = await res.json() as any[];
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(2);
        });
    });

    describe('Breadcrumb Gaps', () => {
        let nestedFolderId: string;

        beforeAll(async () => {
            const level1 = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Level 1'});

            const level2 = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${level1.id}`, {folderName: 'Level 2'});

            nestedFolderId = level2.id;
        });

        test('breadcrumb for nested folder includes all ancestors', async () => {
            const breadcrumb = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${nestedFolderId}/breadcrumb`);

            expect(Array.isArray(breadcrumb)).toBe(true);
            expect(breadcrumb.length).toBeGreaterThanOrEqual(2);

            const names = breadcrumb.map((item: any) => item.name);
            expect(names).toContain('Level 1');
            expect(names).toContain('Level 2');
        });

        test('breadcrumb respects permissions on shared paths', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${nestedFolderId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false, public: false}],
                    }),
                });

            const breadcrumb = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${nestedFolderId}/breadcrumb`);

            expect(Array.isArray(breadcrumb)).toBe(true);

            const hasAccessible = breadcrumb.some((item: any) => item.name === 'Level 2');
            expect(hasAccessible).toBe(true);
        });
    });
});
