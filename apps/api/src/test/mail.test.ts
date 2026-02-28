import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

describe('Mail', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let draftMessageId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('list mailboxes returns structure', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailboxes`);
        const data = await res.json() as any[];
        expect(data).toBeDefined();
        const inbox = data.find(mailbox => mailbox.path === '');
        expect(inbox).toBeDefined();
        expect(inbox.flags).toContain('\\Inbox');
    });

    test('create custom mailbox', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'Projects', attributes: []}),
            });
        expect(res.status).toBe(200);
    });

    test('mailbox-exists returns mailbox metadata for created mailbox', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox-exists/Projects`);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data).toBeDefined();
        expect(data).not.toBe(false);
        expect(data.path).toBe('Projects');
    });

    test('mailbox-exists returns false for unknown mailbox', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox-exists/does-not-exist`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toBe(false);
    });

    test('create duplicate mailbox returns 409', async () => {
        const res1 = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'Duplicate', attributes: []}),
            });
        expect(res1.status).toBe(200);

        const res2 = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'Duplicate', attributes: []}),
            });
        expect(res2.status).toBe(409);
        const body = await res2.text();
        expect(body).toContain('already exists');
    });

    test('create mailbox with case-only name difference also returns 409', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'projects', attributes: []}),
            });

        expect(res.status).toBe(409);
        expect(await res.text()).toContain('already exists');
    });

    test('get unknown mailbox returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox/not-a-mailbox`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('not found');
    });

    test('set read on unknown message returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/non-existent-message/read`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({read: true}),
            });
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('not found');
    });

    test('draft creation returns draft with id', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/draft`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mail: {subject: 'Integration draft', text: 'hello draft'}}),
            });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.id).toBeDefined();
        expect(data.mailbox).toBe('Drafts');
        draftMessageId = data.id;
    });

    test('draft appears in drafts mailbox listing', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox/Drafts`);
        expect(res.status).toBe(200);
        const data = await res.json() as any[];
        expect(data.find(mail => mail.id === draftMessageId)).toBeDefined();
    });

    test('public deliver endpoint returns 404 for unknown recipient', async () => {
        const eml = [
            'From: sender@example.com',
            'To: nobody@test.eigen.is',
            'Subject: Unknown recipient',
            '',
            'hello',
        ].join('\r\n');

        const res = await ctx.app.handle(new Request('http://localhost/mail/deliver/nobody@test.eigen.is', {
            method: 'POST',
            headers: {'Content-Type': 'message/rfc822'},
            body: new TextEncoder().encode(eml).buffer,
        }));

        expect(res.status).toBe(404);
        expect(await res.text()).toContain('Recipient');
    });

    describe('Cross-user isolation', () => {
        test('Bob has his own mailboxes', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.bob.user.id}/mailboxes`);
            const data = await res.json() as any[];
            expect(data).toBeDefined();
        });

        test('ownerId spoofing does not let Bob write mailboxes into Alice account', async () => {
            const createRes = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: 'BobOnlyMailbox', attributes: []}),
                });
            expect(createRes.status).toBe(200);

            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailboxes`);
            const aliceMailboxes = await aliceRes.json() as any[];

            const bobRes = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.bob.user.id}/mailboxes`);
            const bobMailboxes = await bobRes.json() as any[];

            const spoofRes = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailboxes`);
            const spoofMailboxes = await spoofRes.json() as any[];

            expect(aliceMailboxes.find(mailbox => mailbox.path === 'bobonlymailbox')).toBeUndefined();
            expect(bobMailboxes.find(mailbox => mailbox.path === 'bobonlymailbox')).toBeDefined();
            expect(spoofMailboxes.find(mailbox => mailbox.path === 'bobonlymailbox')).toBeDefined();
        });
    });
});
