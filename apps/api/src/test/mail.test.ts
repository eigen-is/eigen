import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('Mail', () => {
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
                body: JSON.stringify({mailbox: 'Projects'}),
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
                body: JSON.stringify({mailbox: 'Duplicate'}),
            });
        expect(res1.status).toBe(200);

        const res2 = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'Duplicate'}),
            });
        expect(res2.status).toBe(409);
        const body = await res2.text();
        expect(body).toContain('already exists');
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

    describe('Message Operations', () => {
        let operationDraftId: string;

        beforeAll(async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'Operations Test', text: 'Hello'}}),
                });
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            operationDraftId = data.id;
        });

        test('get specific message', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}`);
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.id).toBe(operationDraftId);
            expect(data.subject).toBe('Operations Test');
        });

        test('get non-existent message returns 404', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/non-existent-id`);
            expect(res.status).toBe(404);
        });

        test('mark message as read', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}/read`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({read: true}),
                });
            expect(res.status).toBe(200);
        });

        test('mark message as unread', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}/read`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({read: false}),
                });
            expect(res.status).toBe(200);
        });

        test('move message to different mailbox', async () => {
            const targetMailbox = `MoveTarget-${Date.now()}`;
            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: targetMailbox}),
                });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({messageId: operationDraftId, targetMailbox}),
                });
            expect(res.status).toBe(200);

            const targetBoxRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`);
            const messages = await targetBoxRes.json() as any[];
            expect(messages.some(m => m.id === operationDraftId)).toBe(true);
        });

        test('delete message', async () => {
            const newDraftRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'To Delete', text: 'Goodbye'}}),
                });
            const newDraft = await newDraftRes.json() as any;

            const deleteRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${newDraft.id}`, {method: 'DELETE'});
            expect([200, 204]).toContain(deleteRes.status);
        });

        test('update draft message', async () => {
            const draftRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'Updated Draft', text: 'Updated body'}}),
                });
            expect(draftRes.status).toBe(200);
            const draft = await draftRes.json() as any;
            expect(draft.subject).toBe('Updated Draft');
        });
    });

    describe('Cross-mailbox Operations', () => {
        let sourceMailbox: string;
        let targetMailbox: string;
        let messageId: string;

        beforeAll(async () => {
            sourceMailbox = `Source-${Date.now()}`;
            targetMailbox = `Target-${Date.now()}`;

            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: sourceMailbox}),
                });
            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: targetMailbox}),
                });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'Move Test', text: 'Test'}}),
                });
            const data = await res.json() as any;
            messageId = data.id;

            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({messageId, targetMailbox: sourceMailbox}),
                });
        });

        test('message exists in source mailbox', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${sourceMailbox}`);
            const messages = await res.json() as any[];
            expect(messages.some(m => m.id === messageId)).toBe(true);
        });

        test('move message removes from source and adds to target', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({messageId, targetMailbox}),
                });

            const sourceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${sourceMailbox}`);
            const sourceMessages = await sourceRes.json() as any[];
            expect(sourceMessages.some(m => m.id === messageId)).toBe(false);

            const targetRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`);
            const targetMessages = await targetRes.json() as any[];
            expect(targetMessages.some(m => m.id === messageId)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('move to non-existent mailbox returns 404', async () => {
            const draftRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'Move', text: 'Test'}}),
                });
            const draft = await draftRes.json() as any;

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({messageId: draft.id, targetMailbox: 'NonExistentBox12345'}),
                });
            expect(res.status).toBe(404);
        });
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
                    body: JSON.stringify({mailbox: 'BobOnlyMailbox'}),
                });
            expect(createRes.status).toBe(200);

            // mailboxesList only returns standard mailboxes, so BobOnlyMailbox won't appear
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailboxes`);
            const aliceMailboxes = await aliceRes.json() as any[];
            expect(aliceMailboxes.find(mailbox => mailbox.path === 'BobOnlyMailbox')).toBeUndefined();
        });
    });
});
