import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

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
                        firstName: 'Charlie',
                        lastName: 'Test',
                        email: ['charlie@test.eigen.is'],
                        phone: ['+1234567890'],
                        company: 'Eigen',
                        jobTitle: 'Tester',
                    }),
                });
            expect(res.status).toBe(200);
            contactId = await res.text();
            expect(contactId).toBeDefined();
            expect(typeof contactId).toBe('string');
            expect(contactId.length).toBeGreaterThan(0);
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
            expect(contacts.find(c => c.firstName === 'Charlie')).toBeUndefined();
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
            labelId = await res.text();
            expect(labelId).toBeDefined();
            expect(typeof labelId).toBe('string');
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

        test('delete label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${labelId}`, {method: 'DELETE'});
            expect(res.status).toBe(200);
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
    });

    describe('Me endpoint', () => {
        test('Alice can get her own profile', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/me`);
            const data = await res.json() as any;
            expect(data).toBeDefined();
            expect(data.eigenId).toBe(ctx.alice.user.id);
        });
    });
});
