import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

describe('Contacts', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let contactId: string;
    let labelId: string;
    let initialContactCount: number;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/contacts/${ctx.alice.user.id}/contacts`);
        const data = await res.json() as any[];
        initialContactCount = data.length;
    });

    describe('Contact CRUD', () => {
        test('create contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        firstName: '  Charlie  ',
                        lastName: '  Test  ',
                        email: ['charlie@test.eigen.is'],
                        phone: ['+1234567890'],
                        company: 'Eigen',
                        jobTitle: 'Tester',
                    }),
                });
            expect(res.status).toBe(200);

            const listRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            const all = await listRes.json() as any[];
            const charlie = all.find(c => c.firstName === 'Charlie');
            expect(charlie).toBeDefined();
            expect(charlie.firstName).toBe('Charlie');
            expect(charlie.lastName).toBe('Test');
            contactId = charlie.id;
        });

        test('list contacts includes new contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            const data = await res.json() as any[];
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(initialContactCount + 1);
            const contact = data.find(c => c.firstName === 'Charlie');
            expect(contact).toBeDefined();
            expect(contact.lastName).toBe('Test');
        });

        test('get contact by id', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`);
            const data = await res.json() as any;
            expect(data).toBeDefined();
            expect(data.firstName).toBe('Charlie');
        });

        test('update contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        firstName: 'Charlie',
                        lastName: 'Updated',
                        email: ['charlie@test.eigen.is'],
                        phone: [],
                    }),
                });
            expect(res.status).toBe(200);

            const getRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`);
            const updated = await getRes.json() as any;
            expect(updated.lastName).toBe('Updated');
        });

        test('delete contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`, {method: 'DELETE'});
            expect(res.status).toBe(200);

            const listRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            const contacts = await listRes.json() as any[];
            expect(contacts.find((c: any) => c.id === contactId)).toBeUndefined();
        });

        test('delete contact is idempotent for non-existing contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`, {method: 'DELETE'});
            expect(res.status).toBe(200);
        });
    });

    describe('Labels', () => {
        let initialLabelCount: number;

        beforeAll(async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels`);
            const data = await res.json() as any[];
            initialLabelCount = data.length;
        });

        test('create label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'VIP', color: '#ff0000'}),
                });
            expect(res.status).toBe(200);
            const raw = await res.text();
            labelId = raw.replace(/^"|"$/g, '');
            expect(labelId.length).toBeGreaterThan(0);
        });

        test('list labels includes new label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels`);
            const data = await res.json() as any[];
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(initialLabelCount + 1);
            const label = data.find((l: any) => l.name === 'VIP');
            expect(label).toBeDefined();
        });

        test('update label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${labelId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'VIP Updated', color: '#00ff00'}),
                });
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.name).toBe('VIP Updated');
            expect(data.color).toBe('#00ff00');
        });

        test('list labels reflects updated label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels`);
            const data = await res.json() as any[];
            const label = data.find((l: any) => l.id === labelId);
            expect(label).toBeDefined();
            expect(label.name).toBe('VIP Updated');
            expect(label.color).toBe('#00ff00');
        });

        test('delete label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${labelId}`, {method: 'DELETE'});
            expect(res.status).toBe(200);
        });

        test('deleted label is removed from labels list', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels`);
            const data = await res.json() as any[];
            expect(data.find((l: any) => l.id === labelId)).toBeUndefined();
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob contacts are separate from Alice', async () => {
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            const aliceContacts = await aliceRes.json() as any[];

            const bobRes = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.bob.user.id}/contacts`);
            const bobContacts = await bobRes.json() as any[];

            const aliceIds = new Set(aliceContacts.map((c: any) => c.id));
            const bobIds = new Set(bobContacts.map((c: any) => c.id));
            const overlap = [...aliceIds].filter(id => bobIds.has(id));
            expect(overlap.length).toBe(0);
        });

        test('ownerId spoofing still returns Bob contacts for Bob token', async () => {
            const spoofRes = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`);
            const spoofContacts = await spoofRes.json() as any[];

            const bobRes = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.bob.user.id}/contacts`);
            const bobContacts = await bobRes.json() as any[];

            const spoofIds = spoofContacts.map((c: any) => c.id).sort();
            const bobIds = bobContacts.map((c: any) => c.id).sort();

            expect(spoofIds).toEqual(bobIds);
        });
    });

    describe('Me endpoint', () => {
        test('Alice can get her own profile', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/me`);
            const data = await res.json() as any;
            expect(data).toBeDefined();
            expect(data.eigenId).toBe(ctx.alice.user.id);
        });

        test('ownerId spoofing on me endpoint still resolves authenticated user', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/me`);
            const data = await res.json() as any;
            expect(data).toBeDefined();
            expect(data.eigenId).toBe(ctx.bob.user.id);
        });

        test('cannot delete own profile contact', async () => {
            const meRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/me`);
            const me = await meRes.json() as any;

            const deleteRes = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${me.id}`, {method: 'DELETE'});

            expect(deleteRes.status).toBe(400);
            expect(await deleteRes.text()).toContain('You cannot delete yourself');
        });
    });
});
