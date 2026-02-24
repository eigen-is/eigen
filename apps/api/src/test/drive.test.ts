import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';

function driveUrl(ownerId: string, mountId: string, ...parts: string[]) {
    return `/drive/${ownerId}/${mountId}/${parts.join('/')}`;
}

async function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    const res = await authedRequest(token, driveUrl(ownerId, mountId, ...parts));
    return res.json();
}

async function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

async function drivePut(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

async function driveDelete(token: string, ownerId: string, mountId: string, path: string): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {method: 'DELETE'});
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

describe('Drive', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;

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
    });

    describe('Mounts', () => {
        test('list mounts returns default mount', async () => {
            const {data, error} = await ctx.alice.api.drive({ownerId: ctx.alice.user.id}).mounts.get();
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
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Test Folder'});

            expect(data).toBeDefined();
            expect(data.name).toBe('Test Folder');
            expect(data.type).toBe('folder');
            folderId = data.id;
        });

        test('folder appears in listing', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`);

            expect(Array.isArray(contents)).toBe(true);
            const folder = contents.find((item: any) => item.id === folderId);
            expect(folder).toBeDefined();
            expect(folder.name).toBe('Test Folder');
        });

        test('rename folder', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${folderId}/rename`, {newName: 'Renamed Folder'});

            const path = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${folderId}`);
            expect(path.name).toBe('Renamed Folder');
        });

        test('delete folder', async () => {
            await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${folderId}`);

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`);
            const deleted = contents.find((item: any) => item.id === folderId);
            expect(deleted).toBeUndefined();
        });
    });

    describe('File Upload & Management', () => {
        let uploadFolderId: string;
        let uploadedFileId: string;
        const testFileContent = 'Hello, Eigen test!';
        const testFileName = 'test-file.txt';

        beforeAll(async () => {
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Upload Tests'});
            uploadFolderId = data.id;
        });

        test('upload file', async () => {
            const file = new File([testFileContent], testFileName, {type: 'text/plain'});
            const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, file);

            expect(data).toBeDefined();
            expect(data.name).toBe(testFileName);
            expect(data.size).toBe(testFileContent.length);
            expect(data.mimeType).toStartWith('text/plain');
            uploadedFileId = data.id;
        });

        test('file appears in folder listing', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${uploadFolderId}`);

            const file = contents.find((item: any) => item.id === uploadedFileId);
            expect(file).toBeDefined();
            expect(file.name).toBe(testFileName);
        });

        test('storage size increased after upload', async () => {
            const {data: size} = await ctx.alice.api.home({ownerId: ctx.alice.user.id}).size.get();

            expect(size).toBeDefined();
            expect(size!.drive).toBeGreaterThan(0);
            expect(size!.used).toBeGreaterThan(0);
        });

        test('download file returns correct content', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}/download`);
            const buffer = await res.arrayBuffer();
            const text = new TextDecoder().decode(buffer);
            expect(text).toBe(testFileContent);
        });

        test('upload image generates thumbnail', async () => {
            const base64 = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=";
            const pngBytes = Buffer.from(base64, 'base64');
            const imageFile = new File([pngBytes], 'test-image.png', {type: 'image/png'});
            const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, imageFile);

            expect(data).toBeDefined();
            expect(data.name).toBe('test-image.png');
        });

        test('upload invalid image has no thumbnail', async () => {
            const invalidPng = Buffer.from('not-a-png', 'utf-8');
            const imageFile = new File([invalidPng], 'invalid.png', {type: 'image/png'});
            const data = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                uploadFolderId, imageFile);

            expect(data).toBeDefined();
            expect(data.name).toBe('invalid.png');
            expect(data.thumbnail).toBeNull(); // No thumbnail for invalid image
        });

        test('rename file', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${uploadedFileId}/rename`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({newName: 'renamed-file.txt'}),
                });
            expect(res.status).toBe(200);

            const file = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `file/${uploadedFileId}`);
            expect(file.name).toBe('renamed-file.txt');
        });

        test('move file to different folder', async () => {
            const targetFolder = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Move Target'});

            const moveRes = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${uploadedFileId}/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({targetParentId: targetFolder.id}),
                });
            expect(moveRes.status).toBe(200);

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${targetFolder.id}`);
            expect(contents.find((item: any) => item.id === uploadedFileId)).toBeDefined();
        });

        test('delete file', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${uploadedFileId}`, {method: 'DELETE'});
            expect(res.status).toBe(200);
        });
    });

    describe('Sharing & ACL', () => {
        let sharedFolderId: string;
        let bobSharedFileId: string;

        beforeAll(async () => {
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Shared With Bob'});
            sharedFolderId = data.id;
        });

        test('Bob cannot access Alice folder before sharing', async () => {
            const contents = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${sharedFolderId}`);
            expect(contents).toEqual([]);
        });

        test('Bob has no read/write permissions before sharing', async () => {
            const read = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/read`);
            const write = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/write`);
            expect(read.canRead).toBe(false);
            expect(write.canWrite).toBe(false);
        });

        test('Alice shares folder with Bob (read)', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/acl`, {
                    acl: [{email: BOB_EMAIL.toUpperCase(), read: true, write: false, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob can read shared folder', async () => {
            const contents = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${sharedFolderId}`);
            expect(Array.isArray(contents)).toBe(true);
        });

        test('Bob has read but no write permission on shared folder', async () => {
            const read = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/read`);
            const write = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/write`);
            expect(read.canRead).toBe(true);
            expect(write.canWrite).toBe(false);
        });

        test('Bob sees folder in shared-with-me with normalized ACL', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await res.json() as any[];
            const shared = data.find(item => item.id === sharedFolderId);
            expect(shared).toBeDefined();
            expect(shared.acl).toEqual([{email: BOB_EMAIL, read: true, write: false, public: false}]);
        });

        test('Alice sees folder in shared-by-me', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/shared/by-me`);
            const data = await res.json() as any[];
            const shared = data.find(item => item.id === sharedFolderId);
            expect(shared).toBeDefined();
        });

        test('Bob cannot upload file while folder is read-only', async () => {
            const formData = new FormData();
            formData.append('file', new File(['no write'], 'read-only-blocked.txt', {type: 'text/plain'}));
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${sharedFolderId}`, {
                    method: 'POST',
                    body: formData,
                });

            expect(res.status).not.toBe(200);

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${sharedFolderId}`);
            expect(contents.find((item: any) => item.name === 'read-only-blocked.txt')).toBeUndefined();
        });

        test('Bob cannot change ACL while read-only', async () => {
            await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFolderId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: BOB_EMAIL, read: true, write: true, public: false}],
                    }),
                });

            const folder = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}`);
            expect(folder.acl).toEqual([{email: BOB_EMAIL, read: true, write: false, public: false}]);
        });

        test('Alice upgrades Bob to write access', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/acl`, {
                    acl: [{email: BOB_EMAIL, read: true, write: true, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob has write permission after upgrade', async () => {
            const write = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/write`);
            expect(write.canWrite).toBe(true);
        });

        test('Bob can create folder inside shared folder', async () => {
            const data = await drivePost(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${sharedFolderId}`, {folderName: 'Bobs Subfolder'});
            expect(data.name).toBe('Bobs Subfolder');
        });

        test('Bob can upload file to shared folder', async () => {
            const file = new File(['shared content'], 'shared-file.txt', {type: 'text/plain'});
            const data = await driveUpload(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                sharedFolderId, file);
            expect(data.name).toBe('shared-file.txt');
            bobSharedFileId = data.id;
        });

        test('Bob can change ACL of shared item when he has write access', async () => {
            const result = await drivePut(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/acl`, {
                    acl: [{email: BOB_EMAIL, read: true, write: false, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob loses write access after downgrading ACL', async () => {
            const write = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/write`);
            expect(write.canWrite).toBe(false);
        });

        test('shared-with-me reflects ACL downgrade', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await res.json() as any[];
            const shared = data.find(item => item.id === sharedFolderId);
            expect(shared).toBeDefined();
            expect(shared.acl).toEqual([{email: BOB_EMAIL, read: true, write: false, public: false}]);
        });

        test('Alice restores Bob write access', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/acl`, {
                    acl: [{email: BOB_EMAIL, read: true, write: true, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob can rename shared file after write is restored', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${bobSharedFileId}/rename`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({newName: 'shared-file-renamed.txt'}),
                });
            expect(res.status).toBe(200);

            const file = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `file/${bobSharedFileId}`);
            expect(file.name).toBe('shared-file-renamed.txt');
        });

        test('Alice revokes sharing', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/acl`, {acl: []});
            expect(result.success).toBe(true);
        });

        test('Bob can no longer access after revoke', async () => {
            const contents = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${sharedFolderId}`);
            expect(contents).toEqual([]);
        });

        test('Bob has no read permission after revoke', async () => {
            const read = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${sharedFolderId}/permissions/read`);
            expect(read.canRead).toBe(false);
        });

        test('Bob no longer sees folder in shared-with-me after revoke', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await res.json() as any[];
            const shared = data.find(item => item.id === sharedFolderId);
            expect(shared).toBeUndefined();
        });
    });

    describe('ACL inheritance on nested paths', () => {
        let inheritedParentId: string;
        let inheritedChildFolderId: string;
        let inheritedChildFileId: string;

        beforeAll(async () => {
            const parent = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Inherited ACL Parent'});
            inheritedParentId = parent.id;

            const childFolder = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${inheritedParentId}`, {folderName: 'Inherited ACL Child'});
            inheritedChildFolderId = childFolder.id;

            const childFile = new File(['inheritance'], 'inherited.txt', {type: 'text/plain'});
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                inheritedChildFolderId, childFile);
            inheritedChildFileId = uploaded.id;
        });

        test('Bob cannot read nested file before parent is shared', async () => {
            const read = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`);
            expect(read.canRead).toBe(false);
        });

        test('Alice shares parent folder with Bob (read-only)', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedParentId}/acl`, {
                    acl: [{email: BOB_EMAIL, read: true, write: false, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob can read nested folder and file through inherited ACL', async () => {
            const folderRead = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedChildFolderId}/permissions/read`);
            const fileRead = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`);
            expect(folderRead.canRead).toBe(true);
            expect(fileRead.canRead).toBe(true);
        });

        test('Bob cannot write nested folder while inherited ACL is read-only', async () => {
            const folderWrite = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedChildFolderId}/permissions/write`);
            expect(folderWrite.canWrite).toBe(false);
        });

        test('Alice upgrades parent ACL to write', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedParentId}/acl`, {
                    acl: [{email: BOB_EMAIL, read: true, write: true, public: false}],
                });
            expect(result.success).toBe(true);
        });

        test('Bob can create folder in nested folder through inherited write ACL', async () => {
            const data = await drivePost(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${inheritedChildFolderId}`, {folderName: 'Inherited ACL Writable Child'});
            expect(data.name).toBe('Inherited ACL Writable Child');
        });

        test('Revoking parent ACL removes inherited access for Bob', async () => {
            const result = await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedParentId}/acl`, {acl: []});
            expect(result.success).toBe(true);

            const fileRead = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${inheritedChildFileId}/permissions/read`);
            const contents = await driveGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${inheritedChildFolderId}`);
            expect(fileRead.canRead).toBe(false);
            expect(contents).toEqual([]);
        });
    });

    describe('Doc & Stickies Creation', () => {
        test('create doc', async () => {
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/doc`, {fileName: 'Test Document'});
            expect(data.name).toBe('Test Document.eigendoc');
            expect(data.type).toBe('doc');
        });

        test('create stickies', async () => {
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/stickies`, {fileName: 'Test Board'});
            expect(data.name).toBe('Test Board.eigenstickies');
            expect(data.type).toBe('stickies');
        });
    });

    describe('Breadcrumb', () => {
        test('breadcrumb for root folder', async () => {
            const data = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${aliceRootId}/breadcrumb`);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBeGreaterThan(0);
        });
    });

    describe('Permissions', () => {
        test('Alice has read permission on root', async () => {
            const data = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${aliceRootId}/permissions/read`);
            expect(data.canRead).toBe(true);
        });

        test('Alice has write permission on root', async () => {
            const data = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `path/${aliceRootId}/permissions/write`);
            expect(data.canWrite).toBe(true);
        });
    });
});
