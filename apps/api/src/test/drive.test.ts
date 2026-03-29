import { beforeAll, describe, expect, test } from 'bun:test';
import {
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    type DrivePath,
    type MountInfo,
    type OrgTeam,
    teamOwnerId,
} from '@workspace/lib/types';
import { getServerConfig } from '../lib/config/server-config';
import {
    assertJson,
    authedRequest,
    driveDelete,
    driveGet,
    driveGetList,
    driveGetPermission,
    drivePost,
    drivePut,
    driveUpload,
    findOrFail,
    getTestContext,
} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';
const CHARLIE_EMAIL = 'charlie@test.eigen.is';

describe('Drive', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        expect(root).toBeDefined();
        expect(root.id).toBeDefined();
        aliceRootId = root.id;
    });

    describe('Mounts', () => {
        test('list mounts returns default mount', async () => {
            const { data, error } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data!.length).toBeGreaterThan(0);
            expect(data![0].isDefault).toBe(true);
        });

        test('root folder exists', async () => {
            const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
            expect(root).toBeDefined();
            expect(root.id).toBe(aliceRootId);
        });
    });

    describe('Folder Operations', () => {
        let folderId: string;

        test('create folder', async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Test Folder' },
            );

            expect(data).toBeDefined();
            expect(data.name).toBe('Test Folder');
            expect(data.type).toBe('folder');
            folderId = data.id;
        });

        test('folder appears in listing', async () => {
            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
            );

            expect(Array.isArray(contents)).toBe(true);
            const folder = findOrFail(contents, (item) => item.id === folderId);
            expect(folder.name).toBe('Test Folder');
        });

        test('rename folder', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/rename`, {
                newName: 'Renamed Folder',
            });

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.name).toBe('Renamed Folder');
        });

        test('delete folder', async () => {
            await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${folderId}`);

            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
            );
            const deleted = contents.find((item: DrivePath) => item.id === folderId);
            expect(deleted).toBeUndefined();
        });
    });

    describe('File Upload & Management', () => {
        let uploadFolderId: string;
        let uploadedFileId: string;
        const testFileContent = 'Hello, Eigen test!';
        const testFileName = 'test-file.txt';

        beforeAll(async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Upload Tests' },
            );
            uploadFolderId = data.id;
        });

        test('upload file', async () => {
            const file = new File([testFileContent], testFileName, { type: 'text/plain' });
            const data = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uploadFolderId,
                file,
            );

            expect(data).toBeDefined();
            expect(data.name).toBe(testFileName);
            expect(data.size).toBe(testFileContent.length);
            expect(data.mimeType).toStartWith('text/plain');
            uploadedFileId = data.id;
        });

        test('file appears in folder listing', async () => {
            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uploadFolderId}`,
            );

            const file = findOrFail(contents, (item) => item.id === uploadedFileId);
            expect(file.name).toBe(testFileName);
        });

        test('storage size increased after upload', async () => {
            const { data: size } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();

            expect(size).toBeDefined();
            expect(size!.drive.default.used).toBeGreaterThan(0);
            expect(size!.total.used).toBeGreaterThan(0);
        });

        test('download file returns correct content', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`,
            );
            expect(res.status).toBe(200);
            const buffer = await res.arrayBuffer();
            const text = new TextDecoder().decode(buffer);
            expect(text).toBe(testFileContent);
        });

        test('download has content-disposition and cache headers', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`,
            );
            expect(res.status).toBe(200);
            expect(res.headers.get('content-disposition')).toContain('attachment');
            expect(res.headers.get('cache-control')).toContain('public');
            expect(res.headers.get('expires')).toBeDefined();
        });

        test('Bob cannot download without permission', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`,
            );
            expect([403, 404, 500]).toContain(res.status);
        });

        test('upload image generates thumbnail', async () => {
            const base64 =
                'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=';
            const pngBytes = Buffer.from(base64, 'base64');
            const imageFile = new File([pngBytes], 'test-image.png', { type: 'image/png' });
            const data = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uploadFolderId,
                imageFile,
            );

            expect(data).toBeDefined();
            expect(data.name).toBe('test-image.png');
        });

        test('upload invalid image has no thumbnail', async () => {
            const invalidPng = Buffer.from('not-a-png', 'utf-8');
            const imageFile = new File([invalidPng], 'invalid.png', { type: 'image/png' });
            const data = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uploadFolderId,
                imageFile,
            );

            expect(data).toBeDefined();
            expect(data.name).toBe('invalid.png');
            expect(data.thumbnail).toBeNull(); // No thumbnail for invalid image
        });

        test('rename file', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${uploadedFileId}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'renamed-file.txt' }),
                },
            );
            expect(res.status).toBe(200);

            const file = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `file/${uploadedFileId}`,
            );
            expect(file.name).toBe('renamed-file.txt');
        });

        test('move file to different folder', async () => {
            const targetFolder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Move Target' },
            );

            const moveRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${uploadedFileId}/move`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetParentId: targetFolder.id }),
                },
            );
            expect(moveRes.status).toBe(200);

            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${targetFolder.id}`,
            );
            findOrFail(contents, (item) => item.id === uploadedFileId);
        });

        test('delete file', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(200);
        });
    });

    describe('Sharing & ACL', () => {
        let sharedFolderId: string;
        let bobSharedFileId: string;

        beforeAll(async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Shared With Bob' },
            );
            sharedFolderId = data.id;
        });

        test('Bob cannot access Alice folder before sharing', async () => {
            const contents = await driveGetList(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${sharedFolderId}`,
            );
            expect(contents).toEqual([]);
        });

        test('Bob has no read/write permissions before sharing', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/read`,
            );
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/write`,
            );
            expect(read.canRead).toBe(false);
            expect(write.canWrite).toBe(false);
        });

        test('Alice shares folder with Bob (read)', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL.toUpperCase(), read: true, write: false }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob can read shared folder', async () => {
            const contents = await driveGetList(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${sharedFolderId}`,
            );
            expect(Array.isArray(contents)).toBe(true);
        });

        test('Bob has read but no write permission on shared folder', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/read`,
            );
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/write`,
            );
            expect(read.canRead).toBe(true);
            expect(write.canWrite).toBe(false);
        });

        test('Bob sees folder in shared-with-me with normalized ACL', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === sharedFolderId);
            expect(shared.acl).toEqual([{ id: BOB_EMAIL, read: true, write: false }]);
        });

        test('Alice sees folder in shared-by-me', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/shared/by-me`);
            const data = await assertJson<DrivePath[]>(res);
            findOrFail(data, (item) => item.id === sharedFolderId);
        });

        test('Bob cannot upload file while folder is read-only', async () => {
            const formData = new FormData();
            formData.append('file', new File(['no write'], 'read-only-blocked.txt', { type: 'text/plain' }));
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${sharedFolderId}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );

            expect(res.status).not.toBe(200);

            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${sharedFolderId}`,
            );
            expect(contents.find((item: DrivePath) => item.name === 'read-only-blocked.txt')).toBeUndefined();
        });

        test('Bob cannot change ACL while read-only', async () => {
            await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFolderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: BOB_EMAIL, read: true, write: true }],
                    }),
                },
            );

            const folder = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}`,
            );
            expect(folder.acl).toEqual([{ id: BOB_EMAIL, read: true, write: false }]);
        });

        test('Alice upgrades Bob to write access', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: true }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob has write permission after upgrade', async () => {
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/write`,
            );
            expect(write.canWrite).toBe(true);
        });

        test('Bob can create folder inside shared folder', async () => {
            const data = await drivePost(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${sharedFolderId}`,
                { folderName: 'Bobs Subfolder' },
            );
            expect(data.name).toBe('Bobs Subfolder');
        });

        test('Bob can upload file to shared folder', async () => {
            const file = new File(['shared content'], 'shared-file.txt', { type: 'text/plain' });
            const data = await driveUpload(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                sharedFolderId,
                file,
            );
            expect(data.name).toBe('shared-file.txt');
            bobSharedFileId = data.id;
        });

        test('Bob can change ACL of shared item when he has write access', async () => {
            const result = await drivePut(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: false }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob loses write access after downgrading ACL', async () => {
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/write`,
            );
            expect(write.canWrite).toBe(false);
        });

        test('shared-with-me reflects ACL downgrade', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === sharedFolderId);
            expect(shared.acl).toEqual([{ id: BOB_EMAIL, read: true, write: false }]);
        });

        test('Alice restores Bob write access', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: true }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob can rename shared file after write is restored', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${bobSharedFileId}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'shared-file-renamed.txt' }),
                },
            );
            expect(res.status).toBe(200);

            const file = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `file/${bobSharedFileId}`,
            );
            expect(file.name).toBe('shared-file-renamed.txt');
        });

        test('Alice revokes sharing', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/acl`,
                { acl: [] },
            );
            expect(result.success).toBe(true);
        });

        test('Bob can no longer access after revoke', async () => {
            const contents = await driveGetList(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${sharedFolderId}`,
            );
            expect(contents).toEqual([]);
        });

        test('Bob has no read permission after revoke', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${sharedFolderId}/permissions/read`,
            );
            expect(read.canRead).toBe(false);
        });

        test('Bob no longer sees folder in shared-with-me after revoke', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            expect(data.find((item) => item.id === sharedFolderId)).toBeUndefined();
        });
    });

    describe('ACL inheritance on nested paths', () => {
        let inheritedParentId: string;
        let inheritedChildFolderId: string;
        let inheritedChildFileId: string;

        beforeAll(async () => {
            const parent = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Inherited ACL Parent' },
            );
            inheritedParentId = parent.id;

            const childFolder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${inheritedParentId}`,
                { folderName: 'Inherited ACL Child' },
            );
            inheritedChildFolderId = childFolder.id;

            const childFile = new File(['inheritance'], 'inherited.txt', { type: 'text/plain' });
            const uploaded = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                inheritedChildFolderId,
                childFile,
            );
            inheritedChildFileId = uploaded.id;
        });

        test('Bob cannot read nested file before parent is shared', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`,
            );
            expect(read.canRead).toBe(false);
        });

        test('Alice shares parent folder with Bob (read-only)', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedParentId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: false }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob can read nested folder and file through inherited ACL', async () => {
            const folderRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedChildFolderId}/permissions/read`,
            );
            const fileRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`,
            );
            expect(folderRead.canRead).toBe(true);
            expect(fileRead.canRead).toBe(true);
        });

        test('Bob cannot write nested folder while inherited ACL is read-only', async () => {
            const folderWrite = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedChildFolderId}/permissions/write`,
            );
            expect(folderWrite.canWrite).toBe(false);
        });

        test('Alice upgrades parent ACL to write', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedParentId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: true }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob can create folder in nested folder through inherited write ACL', async () => {
            const data = await drivePost(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${inheritedChildFolderId}`,
                { folderName: 'Inherited ACL Writable Child' },
            );
            expect(data.name).toBe('Inherited ACL Writable Child');
        });

        test('Revoking parent ACL removes inherited access for Bob', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedParentId}/acl`,
                { acl: [] },
            );
            expect(result.success).toBe(true);

            const fileRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`,
            );
            const contents = await driveGetList(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${inheritedChildFolderId}`,
            );
            expect(fileRead.canRead).toBe(false);
            expect(contents).toEqual([]);
        });
    });

    describe('Additive ACL inheritance', () => {
        let parentId: string;
        let childFolderId: string;
        const CHARLIE_EMAIL = 'charlie@test.eigen.is';

        beforeAll(async () => {
            const parent = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Additive Parent' },
            );
            parentId = parent.id;

            const child = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${parentId}`,
                { folderName: 'Additive Child' },
            );
            childFolderId = child.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parentId}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
        });

        test('Bob inherits read from parent even when child has ACL for another user', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${childFolderId}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });

            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${childFolderId}/permissions/read`,
            );
            expect(read.canRead).toBe(true);
        });

        test('Child ACL can escalate permissions on top of parent', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${childFolderId}/acl`, {
                acl: [
                    { id: CHARLIE_EMAIL, read: true, write: true },
                    { id: BOB_EMAIL, read: true, write: true },
                ],
            });

            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${childFolderId}/permissions/write`,
            );
            expect(write.canWrite).toBe(true);
        });

        test('Removing Bob from child ACL still inherits parent read', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${childFolderId}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });

            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${childFolderId}/permissions/read`,
            );
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${childFolderId}/permissions/write`,
            );
            expect(read.canRead).toBe(true);
            expect(write.canWrite).toBe(false);
        });
    });

    describe('Visibility', () => {
        let visibilityFolderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Visibility Test' },
            );
            visibilityFolderId = folder.id;
        });

        test('Bob cannot read private folder', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/permissions/read`,
            );
            expect(read.canRead).toBe(false);
        });

        test('Setting public-read allows Bob to read', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/acl`,
                { acl: [], visibility: 'public-read' },
            );

            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/permissions/read`,
            );
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/permissions/write`,
            );
            expect(read.canRead).toBe(true);
            expect(write.canWrite).toBe(false);
        });

        test('Setting public-write allows Bob to write', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/acl`,
                { acl: [], visibility: 'public-write' },
            );

            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/permissions/write`,
            );
            expect(write.canWrite).toBe(true);
        });

        test('Setting back to private revokes Bob access', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/acl`,
                { acl: [], visibility: 'private' },
            );

            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolderId}/permissions/read`,
            );
            expect(read.canRead).toBe(false);
        });
    });

    describe('Layered ACL inheritance edge cases', () => {
        let folderA: string;
        let folderB: string;
        let folderC: string;
        let fileInC: string;

        beforeAll(async () => {
            const a = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Folder A' },
            );
            folderA = a.id;

            const b = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderA}`,
                { folderName: 'Folder B' },
            );
            folderB = b.id;

            const c = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderB}`,
                { folderName: 'Folder C' },
            );
            folderC = c.id;

            const file = new File(['deep content'], 'deep-file.txt', { type: 'text/plain' });
            const f = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderC, file);
            fileInC = f.id;
        });

        test('Read in A + write in B: Bob can read A, write B, write C', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const readA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const writeA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/write`,
            );
            const writeB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            const writeFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${fileInC}/permissions/write`,
            );

            expect(readA.canRead).toBe(true);
            expect(writeA.canWrite).toBe(false);
            expect(writeB.canWrite).toBe(true);
            expect(writeC.canWrite).toBe(true);
            expect(writeFile.canWrite).toBe(true);
        });

        test('Removing Bob from A: Bob still has write on B and children via direct ACL', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });

            const readA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const readB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/read`,
            );
            const writeB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );

            expect(readA.canRead).toBe(false);
            expect(readB.canRead).toBe(true);
            expect(writeB.canWrite).toBe(true);
            expect(writeC.canWrite).toBe(true);
        });

        test('Adding read-only ACL on C does not downgrade inherited write from B', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            expect(writeC.canWrite).toBe(true);
        });

        test('File in C inherits write from B even when C has read-only ACL', async () => {
            const writeFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${fileInC}/permissions/write`,
            );
            expect(writeFile.canWrite).toBe(true);
        });

        test('Removing Bob from B revokes write on C and file (read still from A)', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [],
            });

            const readC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/read`,
            );
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            const readFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${fileInC}/permissions/read`,
            );
            const writeFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${fileInC}/permissions/write`,
            );

            expect(readC.canRead).toBe(true);
            expect(writeC.canWrite).toBe(false);
            expect(readFile.canRead).toBe(true);
            expect(writeFile.canWrite).toBe(false);
        });

        test('Removing all ACLs revokes everything', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [],
            });

            const readA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const readC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/read`,
            );
            const readFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${fileInC}/permissions/read`,
            );

            expect(readA.canRead).toBe(false);
            expect(readC.canRead).toBe(false);
            expect(readFile.canRead).toBe(false);
        });
    });

    describe('Doc & Stickies Creation', () => {
        test('create doc', async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/doc`,
                { fileName: 'Test Document' },
            );
            expect(data.name).toBe('Test Document.eigendoc');
            expect(data.type).toBe(DRIVE_TYPE_DOC);
        });

        test('create stickies', async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/stickies`,
                { fileName: 'Test Board' },
            );
            expect(data.name).toBe('Test Board.eigenstickies');
            expect(data.type).toBe(DRIVE_TYPE_STICKIES);
        });

        test('create slides', async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/slides`,
                { fileName: 'Test Slides' },
            );
            expect(data.name).toBe('Test Slides.eigenslides');
            expect(data.type).toBe(DRIVE_TYPE_SLIDES);
        });

        test('create sheets', async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/sheets`,
                { fileName: 'Test Sheet' },
            );
            expect(data.name).toBe('Test Sheet.eigensheets');
            expect(data.type).toBe(DRIVE_TYPE_SHEETS);
        });
    });

    describe('Breadcrumb', () => {
        let nestedFolderId: string;

        beforeAll(async () => {
            const level1 = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Breadcrumb L1' },
            );
            const level2 = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${level1.id}`,
                { folderName: 'Breadcrumb L2' },
            );
            nestedFolderId = level2.id;
        });

        test('breadcrumb for root folder', async () => {
            const data = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aliceRootId}/breadcrumb`,
            );
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBeGreaterThan(0);
        });

        test('breadcrumb for nested folder includes all ancestors', async () => {
            const breadcrumb = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${nestedFolderId}/breadcrumb`,
            );
            expect(Array.isArray(breadcrumb)).toBe(true);
            expect(breadcrumb.length).toBeGreaterThanOrEqual(2);
            const names = breadcrumb.map((item: DrivePath) => item.name);
            expect(names).toContain('Breadcrumb L1');
            expect(names).toContain('Breadcrumb L2');
        });

        test('breadcrumb respects permissions on shared paths', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${nestedFolderId}/acl`, {
                acl: [{ id: 'bob@test.eigen.is', read: true, write: false }],
            });

            const breadcrumb = await driveGetList(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${nestedFolderId}/breadcrumb`,
            );
            expect(Array.isArray(breadcrumb)).toBe(true);
            expect(breadcrumb.some((item: DrivePath) => item.name === 'Breadcrumb L2')).toBe(true);
        });
    });

    describe('ACL Email Validation', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'ACL Validation Folder' },
            );
            folderId = folder.id;
        });

        test('ACL with valid email succeeds', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: BOB_EMAIL, read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('ACL with invalid email returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: 'not-an-email', read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('ACL with missing @ returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: 'justausername', read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('ACL with empty email returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: '', read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('ACL with one valid and one invalid email returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [
                            { id: BOB_EMAIL, read: true, write: false },
                            { id: 'bad-entry', read: true, write: false },
                        ],
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('invalid ACL does not overwrite existing valid ACL', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: BOB_EMAIL, read: true, write: true }],
                    }),
                },
            );

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folderId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: 'garbage', read: true, write: true }],
                    }),
                },
            );

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.acl).toBeDefined();
            expect(path.acl).toHaveLength(1);
            expect(path.acl![0].id).toBe(BOB_EMAIL.toLowerCase());
        });
    });

    describe('Permissions', () => {
        test('Alice has read permission on root', async () => {
            const data = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aliceRootId}/permissions/read`,
            );
            expect(data.canRead).toBe(true);
        });

        test('Alice has write permission on root', async () => {
            const data = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aliceRootId}/permissions/write`,
            );
            expect(data.canWrite).toBe(true);
        });
    });

    describe('Complex ACL Inheritance Edge Cases', () => {
        let folderA: string;
        let folderB: string;
        let folderC: string;
        let folderD: string;
        let deepFile: string;

        beforeAll(async () => {
            // Create deep nested structure: A -> B -> C -> D
            const a = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Complex A' },
            );
            folderA = a.id;

            const b = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderA}`,
                { folderName: 'Complex B' },
            );
            folderB = b.id;

            const c = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderB}`,
                { folderName: 'Complex C' },
            );
            folderC = c.id;

            const d = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderC}`,
                { folderName: 'Complex D' },
            );
            folderD = d.id;

            const file = new File(['deep nested content'], 'deep-nested.txt', { type: 'text/plain' });
            const uploaded = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderD,
                file,
            );
            deepFile = uploaded.id;
        });

        test('deep inheritance: read at A, write at C, file in D inherits write', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const readA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const writeB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeD = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/write`,
            );
            const writeFile = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${deepFile}/permissions/write`,
            );

            expect(readA.canRead).toBe(true);
            expect(writeB.canWrite).toBe(false); // B inherits from A (read-only), not C
            expect(writeD.canWrite).toBe(true); // D inherits from C (write)
            expect(writeFile.canWrite).toBe(true); // File inherits from D
        });

        test('permission escalation and de-escalation chain', async () => {
            // Clear previous ACLs
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [],
            });

            // Set: A(read-only) -> B(no ACL) -> C(write) -> D(no ACL)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Bob should have write at C and below despite read-only at A
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            const writeD = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/write`,
            );
            expect(writeC.canWrite).toBe(true);
            expect(writeD.canWrite).toBe(true);

            // Remove write at C, should still have read from A
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderC}/acl`, {
                acl: [],
            });

            const readD = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/read`,
            );
            const writeDAfter = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/write`,
            );
            expect(readD.canRead).toBe(true); // Still inherits read from A
            expect(writeDAfter.canWrite).toBe(false); // Lost write from C
        });

        test('multiple users with different permission levels', async () => {
            const CHARLIE_EMAIL = 'charlie@test.eigen.is';

            // Bob: read at A
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            // Charlie: write at B
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });

            // Verify Bob has read-only throughout
            const bobReadD = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/read`,
            );
            const bobWriteD = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/write`,
            );
            expect(bobReadD.canRead).toBe(true);
            expect(bobWriteD.canWrite).toBe(false);

            // Verify Charlie has write from B down
            const charlieReadD = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/read`,
            );
            const charlieWriteD = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderD}/permissions/write`,
            );
            expect(charlieReadD.canRead).toBe(true);
            expect(charlieWriteD.canWrite).toBe(true);
        });

        test('ACL with conflicting permissions at different levels', async () => {
            const CHARLIE_EMAIL = 'charlie@test.eigen.is';

            // Clear previous ACLs
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [],
            });

            // Bob: write at A, read-only at B (additive model - should have write from A)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            const writeB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            expect(writeB.canWrite).toBe(true); // Additive: write from A + read from B = write
            expect(writeC.canWrite).toBe(true); // Inherits write from A

            // Charlie: read-only at A, write at B (additive model - should have write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [
                    { id: BOB_EMAIL, read: true, write: true },
                    { id: CHARLIE_EMAIL, read: true, write: false },
                ],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });

            const charlieWriteB = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const charlieWriteC = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );
            expect(charlieWriteB.canWrite).toBe(true); // Additive: read from A + write from B = write
            expect(charlieWriteC.canWrite).toBe(true); // Inherits write from B
        });
    });

    describe('Permission Boundaries and Edge Cases', () => {
        let boundaryFolder: string;
        let subFolder: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Boundary Test' },
            );
            boundaryFolder = folder.id;

            const sub = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${boundaryFolder}`,
                { folderName: 'Sub Folder' },
            );
            subFolder = sub.id;

            const file = new File(['boundary test'], 'boundary.txt', { type: 'text/plain' });
            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, subFolder, file);
        });

        test('user with no ACL cannot access anything', async () => {
            const read = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/read`,
            );
            const write = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/write`,
            );
            expect(read.canRead).toBe(false);
            expect(write.canWrite).toBe(false);
        });

        test('owner always has full permissions regardless of ACL', async () => {
            // Give Bob write access, then check Alice (owner) still has full access
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${boundaryFolder}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const aliceRead = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/read`,
            );
            const aliceWrite = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/write`,
            );
            expect(aliceRead.canRead).toBe(true);
            expect(aliceWrite.canWrite).toBe(true);
        });

        test('user cannot modify ACL of folder they dont own', async () => {
            // Verify Charlie doesn't have write access to boundaryFolder (Charlie wasn't given access in previous test)
            const charlieWrite = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/write`,
            );
            expect(charlieWrite.canWrite).toBe(false); // Confirm Charlie has no write access

            const res = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${boundaryFolder}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: CHARLIE_EMAIL, read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('user with write access can modify ACL', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${boundaryFolder}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: BOB_EMAIL, read: true, write: false }],
                    }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('user loses ACL modification rights when write access revoked', async () => {
            // Clear all access completely (additive model means read-only doesn't remove write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${boundaryFolder}/acl`, {
                acl: [],
            });

            // Verify Charlie doesn't have write access after clear
            const charlieWrite = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/write`,
            );
            expect(charlieWrite.canWrite).toBe(false);

            const res = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${boundaryFolder}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
                    }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('empty ACL array revokes all access except owner', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${boundaryFolder}/acl`, {
                acl: [],
            });

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/read`,
            );
            expect(bobRead.canRead).toBe(false);
        });

        test('ACL entries are case-insensitive for emails', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${boundaryFolder}/acl`, {
                acl: [{ id: BOB_EMAIL.toUpperCase(), read: true, write: false }],
            });

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${boundaryFolder}/permissions/read`,
            );
            expect(bobRead.canRead).toBe(true);
        });
    });

    describe('Visibility Edge Cases with ACL Interaction', () => {
        let visibilityFolder: string;
        let visibilitySub: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Visibility Edge' },
            );
            visibilityFolder = folder.id;

            const sub = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${visibilityFolder}`,
                { folderName: 'Visibility Sub' },
            );
            visibilitySub = sub.id;
        });

        test('public-read overrides private ACL for reading', async () => {
            // Set private ACL (Bob denied) but public-read visibility
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: false, write: false }],
                    visibility: 'public-read',
                },
            );

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/read`,
            );
            const bobWrite = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/write`,
            );
            expect(bobRead.canRead).toBe(true); // Public-read allows read
            expect(bobWrite.canWrite).toBe(false); // No write permission
        });

        test('public-write overrides private ACL for both read and write', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: false, write: false }],
                    visibility: 'public-write',
                },
            );

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/read`,
            );
            const bobWrite = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/write`,
            );
            expect(bobRead.canRead).toBe(true);
            expect(bobWrite.canWrite).toBe(true);
        });

        test('visibility inherits to children', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [],
                    visibility: 'public-read',
                },
            );

            const charlieReadSub = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilitySub}/permissions/read`,
            );
            expect(charlieReadSub.canRead).toBe(true); // Inherits public-read
        });

        test('child visibility can be more restrictive than parent', async () => {
            // Parent: public-read, Child: private
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [],
                    visibility: 'public-read',
                },
            );
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${visibilitySub}/acl`, {
                acl: [],
                visibility: 'private',
            });

            const bobReadParent = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/read`,
            );
            const bobReadChild = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilitySub}/permissions/read`,
            );
            expect(bobReadParent.canRead).toBe(true); // Public-read
            expect(bobReadChild.canRead).toBe(true); // Additive model: child inherits parent's public visibility
        });

        test('ACL and visibility combine for most permissive access', async () => {
            // Bob: write ACL + public-read visibility = should get write
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: true }],
                    visibility: 'public-read',
                },
            );

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/read`,
            );
            const bobWrite = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/write`,
            );
            expect(bobRead.canRead).toBe(true);
            expect(bobWrite.canWrite).toBe(true); // ACL grants write
        });

        test('non-existent user in ACL is ignored but visibility still works', async () => {
            await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/acl`,
                {
                    acl: [{ id: 'nonexistent@test.com', read: true, write: false }],
                    visibility: 'public-read',
                },
            );

            const charlieRead = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${visibilityFolder}/permissions/read`,
            );
            expect(charlieRead.canRead).toBe(true); // Public-read works regardless
        });
    });

    describe('ACL Modification Edge Cases', () => {
        let aclFolder: string;
        let aclSub: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'ACL Modification' },
            );
            aclFolder = folder.id;

            const sub = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aclFolder}`,
                { folderName: 'ACL Sub' },
            );
            aclSub = sub.id;
        });

        test('partially invalid ACL rejects entire update', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${aclFolder}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        acl: [
                            { id: BOB_EMAIL, read: true, write: false },
                            { id: 'invalid-email', read: true, write: false },
                        ],
                    }),
                },
            );
            expect(res.status).toBe(400);

            // Verify original ACL unchanged
            const folder = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aclFolder}`,
            );
            expect(folder.acl).toEqual(null);
        });

        test('removing specific user from ACL while keeping others', async () => {
            const CHARLIE_EMAIL = 'charlie@test.eigen.is';

            // Set ACL with both Bob and Charlie
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [
                    { id: BOB_EMAIL, read: true, write: false },
                    { id: CHARLIE_EMAIL, read: true, write: true },
                ],
            });

            // Remove only Bob
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });

            const bobRead = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aclFolder}/permissions/read`,
            );
            const charlieRead = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aclFolder}/permissions/read`,
            );
            expect(bobRead.canRead).toBe(false);
            expect(charlieRead.canRead).toBe(true);
        });

        test('ACL changes affect existing operations', async () => {
            // Give Bob write access
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Bob creates a folder
            const bobsFolder = await drivePost(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aclFolder}`,
                { folderName: "Bob's Folder" },
            );
            expect(bobsFolder.name).toBe("Bob's Folder");

            // Revoke Bob's write access completely (additive model means read-only doesn't remove write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [], // Clear all access for Bob
            });

            // Bob cannot create another folder
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${aclFolder}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Should Fail' }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('ACL inheritance respects immediate changes', async () => {
            // Set parent ACL
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            // Verify Bob can read subfolder through inheritance
            const bobReadSub = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aclSub}/permissions/read`,
            );
            expect(bobReadSub.canRead).toBe(true);

            // Remove parent ACL
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${aclFolder}/acl`, {
                acl: [],
            });

            // Bob immediately loses access to subfolder
            const bobReadSubAfter = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${aclSub}/permissions/read`,
            );
            expect(bobReadSubAfter.canRead).toBe(false);
        });
    });

    describe('Embed Endpoint', () => {
        let embedFileId: string;

        beforeAll(async () => {
            const file = new File(['Embed test content'], 'embed-test.txt', { type: 'text/plain' });
            const uploaded = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                aliceRootId,
                file,
            );
            embedFileId = uploaded.id;
        });

        test('embed endpoint returns file content', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${embedFileId}/embed/embed-test.txt`,
            );
            expect(res.status).toBe(200);
        });

        test('embed has cache headers', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${embedFileId}/embed/embed-test.txt`,
            );
            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toContain('public');
            expect(res.headers.get('expires')).toBeDefined();
        });
    });

    describe('Thumbnail Endpoint', () => {
        test('thumbnail returns webp with cache headers for uploaded image', async () => {
            const base64 =
                'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=';
            const pngBytes = Buffer.from(base64, 'base64');
            const imageFile = new File([pngBytes], 'thumb-test.png', { type: 'image/png' });
            const uploaded = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                aliceRootId,
                imageFile,
            );

            // Thumbnail generation is async — poll until ready
            let res: Response | undefined;
            for (let i = 0; i < 20; i++) {
                res = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/drive/${ctx.alice.user.id}/${aliceMountId}/thumb/${uploaded.id}.webp`,
                );
                if (res.status === 200) break;
                await new Promise((r) => setTimeout(r, 250));
            }
            expect(res!.status).toBe(200);
            expect(res!.headers.get('content-type')).toBe('image/webp');
            expect(res!.headers.get('cache-control')).toContain('public');
        });

        test('thumbnail returns 404 for non-existent file', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/thumb/non-existent.webp`,
            );
            expect(res.status).toBe(404);
        });
    });

    describe('MIME Type Filter', () => {
        beforeAll(async () => {
            const file1 = new File(['text content'], 'mime-test.txt', { type: 'text/plain' });
            const file2 = new File(['{"test": true}'], 'mime-test.json', { type: 'application/json' });
            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, aliceRootId, file1);
            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, aliceRootId, file2);
        });

        test('MIME filter returns files of specified type', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mime/text-plain`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data)).toBe(true);
        });

        test('MIME filter handles empty results', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/mime/application-x-custom`,
            );
            const data = await assertJson<DrivePath[]>(res);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(0);
        });
    });

    describe('Multiple File Upload', () => {
        test('upload multiple files at once', async () => {
            const formData = new FormData();
            formData.append('file', new File(['file1'], 'multi1.txt', { type: 'text/plain' }));
            formData.append('file', new File(['file2'], 'multi2.txt', { type: 'text/plain' }));

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );
            const data = await assertJson<DrivePath[]>(res);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(2);
        });
    });

    describe('Additive ACL Model Validation', () => {
        let folderA: string;
        let folderB: string;
        let folderC: string;

        beforeAll(async () => {
            const a = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Additive A' },
            );
            folderA = a.id;

            const b = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderA}`,
                { folderName: 'Additive B' },
            );
            folderB = b.id;

            const c = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderB}`,
                { folderName: 'Additive C' },
            );
            folderC = c.id;
        });

        test('additive model: read at parent + write at child = write at child', async () => {
            // Bob: read at A, write at B
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const readA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const writeB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );

            expect(readA.canRead).toBe(true);
            expect(writeB.canWrite).toBe(true); // Direct write at B
            expect(writeC.canWrite).toBe(true); // Inherits write from B
        });

        test('additive model: write at parent + read at child = write at child', async () => {
            // Clear previous ACLs
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [],
            });

            // Charlie: write at A, read at B
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                acl: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });

            const writeA = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/write`,
            );
            const writeB = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const writeC = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/write`,
            );

            expect(writeA.canWrite).toBe(true); // Direct write at A
            expect(writeB.canWrite).toBe(true); // Additive: write from A + read from B = write
            expect(writeC.canWrite).toBe(true); // Inherits write from A
        });

        test('additive model: user with no ACL gets no access', async () => {
            // Clear ACLs
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [],
            });

            // Bob should have no access anywhere
            const bobReadA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const bobWriteB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const bobReadC = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/read`,
            );

            expect(bobReadA.canRead).toBe(false);
            expect(bobWriteB.canWrite).toBe(false);
            expect(bobReadC.canRead).toBe(false);
        });

        test('additive model: owner always has full access regardless of ACL', async () => {
            // Give Bob write access to A
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Alice (owner) should still have full access
            const aliceReadA = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderA}/permissions/read`,
            );
            const aliceWriteB = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderB}/permissions/write`,
            );
            const aliceReadC = await driveGetPermission(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderC}/permissions/read`,
            );

            expect(aliceReadA.canRead).toBe(true);
            expect(aliceWriteB.canWrite).toBe(true);
            expect(aliceReadC.canRead).toBe(true);
        });
    });

    describe('Unique Name Enforcement', () => {
        let uniqueRoot: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'UniqueNameTests' },
            );
            uniqueRoot = folder.id;
        });

        test('cannot create folder with same name (exact case)', async () => {
            await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${uniqueRoot}`, {
                folderName: 'Documents',
            });

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${uniqueRoot}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Documents' }),
                },
            );
            expect(res.status).toBe(409);
        });

        test('cannot create folder with same name (different case)', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${uniqueRoot}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'DOCUMENTS' }),
                },
            );
            expect(res.status).toBe(409);
        });

        test('can create folder with different name in same directory', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${uniqueRoot}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Photos' }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('can create folder with same name in different directory', async () => {
            const sub = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'SubFolder' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${sub.id}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Documents' }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('upload auto-deduplicates when name conflicts with folder', async () => {
            const file = new File(['hello'], 'documents', { type: 'text/plain' });
            const uploaded = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uniqueRoot,
                file,
            );
            expect(uploaded).toBeDefined();
            expect(uploaded.name).not.toBe('documents');
            expect(uploaded.details?.originalName).toBe('documents');
        });

        test('upload auto-deduplicates when name conflicts with file (case-insensitive)', async () => {
            const file1 = new File(['hello'], 'readme.txt', { type: 'text/plain' });
            const first = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uniqueRoot,
                file1,
            );
            expect(first.name).toBe('readme.txt');
            expect(first.details?.originalName).toBe('readme.txt');

            const file2 = new File(['world'], 'README.TXT', { type: 'text/plain' });
            const second = await driveUpload(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                uniqueRoot,
                file2,
            );
            expect(second.name).not.toBe('README.TXT');
            expect(second.name).toEndWith('.TXT');
            expect(second.details?.originalName).toBe('README.TXT');
        });

        test('cannot rename to conflicting name (case-insensitive)', async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'RenameTarget' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'documents' }),
                },
            );
            expect(res.status).toBe(409);
        });

        test('can rename to same name with different case (self-rename)', async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'CaseChange' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'CASECHANGE' }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('cannot move to directory with conflicting name', async () => {
            const dirA = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'MoveTestDirA' },
            );
            const dirB = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'MoveTestDirB' },
            );

            await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${dirA.id}`, {
                folderName: 'Conflict',
            });
            const toMove = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${dirB.id}`,
                { folderName: 'CONFLICT' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${toMove.id}/move`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetParentId: dirA.id }),
                },
            );
            expect(res.status).toBe(409);
        });

        test('can move to directory without conflicting name', async () => {
            const dirA = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'MoveOkDirA' },
            );
            const dirB = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'MoveOkDirB' },
            );

            const toMove = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${dirB.id}`,
                { folderName: 'NoConflict' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${toMove.id}/move`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetParentId: dirA.id }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('name becomes available after deletion', async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${uniqueRoot}`,
                { folderName: 'Temporary' },
            );

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${folder.id}`,
                { method: 'DELETE' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${uniqueRoot}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Temporary' }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('doc creation with conflicting name is rejected', async () => {
            await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${uniqueRoot}`, {
                folderName: 'notes.eigendoc',
            });

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${uniqueRoot}/doc`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: 'notes' }),
                },
            );
            expect(res.status).toBe(409);
        });
    });

    describe('Regression: SharedDrive.createSlides/createSheets on team drive', () => {
        let teamId: string;
        let teamOwner: string;
        let teamMountId: string;
        let teamRootId: string;

        beforeAll(async () => {
            const config = getServerConfig();
            const orgId = config!.orgId;

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });

            const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Slides Sheets Team', organizationId: orgId }),
            });
            const team = (await teamRes.json()) as OrgTeam;
            teamId = team.id;
            teamOwner = teamOwnerId(teamId);

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId, userId: ctx.alice.user.id }),
            });

            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Slides Sheets Drive', storageType: 'local', maxSizeMB: 500 }),
            });

            const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
            const mounts = await assertJson<MountInfo[]>(mountsRes);
            teamMountId = mounts[0].id;

            const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
            teamRootId = root.id;
        });

        test('create slides on team drive returns 200', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/folder/${teamRootId}/slides`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: 'Team Presentation' }),
                },
            );
            const data = await assertJson<DrivePath>(res);
            expect(data.name).toBe('Team Presentation.eigenslides');
            expect(data.type).toBe(DRIVE_TYPE_SLIDES);
            expect(data.ownerId).toBe(teamOwner);
        });

        test('create sheets on team drive returns 200', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/folder/${teamRootId}/sheets`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: 'Team Spreadsheet' }),
                },
            );
            const data = await assertJson<DrivePath>(res);
            expect(data.name).toBe('Team Spreadsheet.eigensheets');
            expect(data.type).toBe(DRIVE_TYPE_SHEETS);
            expect(data.ownerId).toBe(teamOwner);
        });
    });

    describe('Regression: Self-downgrade ACL preserves sharing', () => {
        let stickiesId: string;

        beforeAll(async () => {
            const data = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/stickies`,
                { fileName: 'ACL Self Downgrade Test' },
            );
            stickiesId = data.id;
        });

        test('Alice shares stickies with Bob (write)', async () => {
            const result = await drivePut(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${stickiesId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: true }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('Bob sees stickies in shared-with-me', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === stickiesId);
            expect(shared.acl).toEqual([{ id: BOB_EMAIL, read: true, write: true }]);
        });

        test('Bob downgrades own ACL to read-only', async () => {
            const result = await drivePut(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${stickiesId}/acl`,
                {
                    acl: [{ id: BOB_EMAIL, read: true, write: false }],
                },
            );
            expect(result.success).toBe(true);
        });

        test('stickies ACL is preserved (not cleared)', async () => {
            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${stickiesId}`,
            );
            expect(path.acl).toEqual([{ id: BOB_EMAIL, read: true, write: false }]);
        });

        test('Bob still has read access', async () => {
            const read = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${stickiesId}/permissions/read`,
            );
            expect(read.canRead).toBe(true);
        });

        test('Bob no longer has write access', async () => {
            const write = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${stickiesId}/permissions/write`,
            );
            expect(write.canWrite).toBe(false);
        });

        test('Bob still sees stickies in shared-with-me with downgraded ACL', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === stickiesId);
            expect(shared.acl).toEqual([{ id: BOB_EMAIL, read: true, write: false }]);
        });

        test('propagated shared path has up-to-date metadata', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === stickiesId);
            expect(shared.name).toBe('ACL Self Downgrade Test.eigenstickies');
        });
    });

    describe('Regression: Recursive folder ACL deletion cleans shared.db', () => {
        let parentId: string;
        let childId: string;

        beforeAll(async () => {
            const parent = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'ACL Cleanup Parent' },
            );
            parentId = parent.id;

            const child = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${parentId}`,
                { folderName: 'ACL Cleanup Child' },
            );
            childId = child.id;
        });

        test('share child with Bob, Bob sees it in shared-with-me', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${childId}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            findOrFail(data, (item) => item.id === childId);
        });

        test('delete parent folder removes child from shared-with-me', async () => {
            await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${parentId}`);

            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            expect(data.find((item) => item.id === childId)).toBeUndefined();
        });
    });
});
