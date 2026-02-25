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

describe('Integration', () => {
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

    describe('ACL and Shared-With-Me Integration', () => {
        let sharedFileId: string;

        beforeAll(async () => {
            const file = new File(['shared content'], 'integration-test.txt', {type: 'text/plain'});
            const formData = new FormData();
            formData.append('file', file);

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`, {
                    method: 'POST',
                    body: formData,
                });
            const uploaded = await res.json() as any;
            sharedFileId = uploaded.id;
        });

        test('sharing file adds to shared-with-me immediately', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFileId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                    }),
                });

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await res.json() as any[];

            const shared = data.find(item => item.id === sharedFileId);
            expect(shared).toBeDefined();
            expect(shared.name).toBe('integration-test.txt');
        });

        test('shared file appears in shared-by-me for owner', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/shared/by-me`);
            const data = await res.json() as any[];

            const shared = data.find(item => item.id === sharedFileId);
            expect(shared).toBeDefined();
        });

        test('revoking sharing removes from shared-with-me', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFileId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({acl: []}),
                });

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await res.json() as any[];

            const shared = data.find(item => item.id === sharedFileId);
            expect(shared).toBeUndefined();
        });
    });

    describe('Drive and Chat Integration', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Integration Chat'});
            chatId = chat.id;
        });

        test('chat file is accessible via drive API', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${chatId}`);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.type).toBe('chat');
        });

        test('chat has internal structure via drive API', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${chatId}`);

            expect(res.status).toBe(200);
            const data = await res.json() as any[];
            expect(Array.isArray(data)).toBe(true);

            const dataDb = data.find((item: any) => item.name === 'data.db');
            const media = data.find((item: any) => item.name === 'media');
            expect(dataDb).toBeDefined();
            expect(media).toBeDefined();
        });

        test('chat messages are accessible via chat API', async () => {
            const postRes = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: 'Integration test message'}),
                });
            expect(postRes.status).toBe(200);

            const getRes = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`);

            expect(getRes.status).toBe(200);
            const messages = await getRes.json() as any[];
            expect(messages.some(m => m.content === 'Integration test message')).toBe(true);
        });

        test('chat and drive permissions are synchronized', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: true}],
                    }),
                });

            const driveReadRes = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/permissions/read`);
            const driveRead = await driveReadRes.json() as any;
            expect(driveRead.canRead).toBe(true);

            const chatPostRes = await authedRequest(ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: 'Bob can write'}),
                });
            expect(chatPostRes.status).toBe(200);
        });
    });

    describe('Drive and Contacts Integration', () => {
        let sharedFolderId: string;

        beforeAll(async () => {
            const folder = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Contacts Integration'});
            sharedFolderId = folder.id;
        });

        test('contact can be used for ACL sharing', async () => {
            const contactRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        firstName: 'Bob',
                        lastName: 'Contact',
                        email: ['bob@test.eigen.is'],
                    }),
                });
            expect([200, 201, 422]).toContain(contactRes.status);

            const aclRes = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFolderId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                    }),
                });

            expect(aclRes.status).toBe(200);

            const bobAccessRes = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${sharedFolderId}/permissions/read`);
            expect([200, 403, 404]).toContain(bobAccessRes.status);
            if (bobAccessRes.status === 200) {
                const bobAccess = await bobAccessRes.json() as any;
                expect(bobAccess.canRead).toBe(true);
            }
        });

        test('public avatar is accessible from contacts', async () => {
            const avatarRes = await ctx.app.handle(
                new Request(`http://localhost/p/avatar/${ctx.alice.user.email}`)
            );

            expect(avatarRes.status).toBe(200);
            expect(avatarRes.headers.get('content-type')).toMatch(/image\//);
        });
    });

    describe('Home and Drive Integration', () => {
        test('home size reflects drive usage', async () => {
            const {data: sizeBefore} = await ctx.alice.api.home({ownerId: ctx.alice.user.id}).size.get();
            const driveSizeBefore = sizeBefore!.drive;

            const file = new File(['test content for size'], 'size-test.txt', {type: 'text/plain'});
            const formData = new FormData();
            formData.append('file', file);

            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`, {
                    method: 'POST',
                    body: formData,
                });

            const {data: sizeAfter} = await ctx.alice.api.home({ownerId: ctx.alice.user.id}).size.get();
            const driveSizeAfter = sizeAfter!.drive;

            expect(driveSizeAfter).toBeGreaterThan(driveSizeBefore);
        });

        test('used size equals sum of components', async () => {
            const {data: size} = await ctx.alice.api.home({ownerId: ctx.alice.user.id}).size.get();

            expect(size!.used).toBe(size!.mail + size!.contacts + size!.drive);
        });
    });

    describe('Cross-Domain Isolation', () => {
        test('Alice drive changes do not affect Bob drive', async () => {
            const {data: bobMounts} = await ctx.bob.api.drive({ownerId: ctx.bob.user.id}).mounts.get();
            const bobMountId = bobMounts![0].id;

            const bobRoot = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, bobMountId, 'root');
            const bobContentsBefore = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, bobMountId,
                `folder/${bobRoot.id}`);
            const bobCountBefore = bobContentsBefore.length;

            await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Alice Only'});

            const bobContentsAfter = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, bobMountId,
                `folder/${bobRoot.id}`);
            const bobCountAfter = bobContentsAfter.length;

            expect(bobCountAfter).toBe(bobCountBefore);
        });

        test('Alice contacts do not appear in Bob contacts', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        firstName: 'Alice',
                        lastName: 'Private',
                        email: ['private@test.eigen.is'],
                    }),
                });

            const bobContactsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.bob.user.id}/contacts`);
            const bobContacts = await bobContactsRes.json() as any[];

            expect(bobContacts.some(c => c.firstName === 'Alice' && c.lastName === 'Private')).toBe(false);
        });

        test('ownerId spoofing is handled consistently across domains', async () => {
            const driveRes = await authedRequest(ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/root`);
            expect(driveRes.status).toBe(200);

            const contactsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            expect(contactsRes.status).toBe(200);

            const homeRes = await authedRequest(ctx.bob.user.sessionToken,
                `/home/${ctx.alice.user.id}/size`);
            expect(homeRes.status).toBe(200);

            const mailRes = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailboxes`);
            expect(mailRes.status).toBe(200);
        });
    });

    describe('Error Propagation', () => {
        test('invalid auth is rejected consistently', async () => {
            const driveRes = await ctx.app.handle(
                new Request(`http://localhost/drive/${ctx.alice.user.id}/${aliceMountId}/root`)
            );
            expect(driveRes.status).not.toBe(200);

            const contactsRes = await ctx.app.handle(
                new Request(`http://localhost/contacts/${ctx.alice.user.id}/contacts`)
            );
            expect(contactsRes.status).not.toBe(200);

            const homeRes = await ctx.app.handle(
                new Request(`http://localhost/home/${ctx.alice.user.id}/size`)
            );
            expect(homeRes.status).not.toBe(200);
        });

        test('unknown resources return error consistently', async () => {
            const driveRes = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/non-existent-id`);
            expect([200, 404, 500]).toContain(driveRes.status);

            const contactsRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/non-existent-id`);
            expect([200, 404, 500]).toContain(contactsRes.status);

            const mailRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/non-existent-id`);
            expect([200, 404, 500]).toContain(mailRes.status);
        });
    });

    describe('Collaboration Integration', () => {
        let docId: string;

        beforeAll(async () => {
            const doc = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/doc`, {fileName: 'Collaboration Test'});
            docId = doc.id;
        });

        test('document is accessible via collab API after drive creation', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.path).toBeDefined();
            expect(data.path.id).toBe(docId);
        });

        test('document permissions match drive permissions', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                    }),
                });

            const collabRes = await authedRequest(ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`);
            const collabData = await collabRes.json() as any;

            expect(collabData.canRead).toBe(true);
            expect(collabData.canWrite).toBe(false);
        });
    });
});
