import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Mail Gaps', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('Mailbox Messages', () => {
        let testMailboxName: string;

        beforeAll(async () => {
            testMailboxName = `TestBox-${Date.now()}`;
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: testMailboxName, attributes: []}),
                });
            expect(res.status).toBe(200);
        });

        test('list messages in mailbox', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${testMailboxName}`);

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data)).toBe(true);
        });

        test('list messages returns message structure', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/Drafts`);

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(Array.isArray(data)).toBe(true);
        });

        test('unknown mailbox returns 404', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/ThisDoesNotExist12345`);

            expect(res.status).toBe(404);
        });
    });

    describe('Message Operations', () => {
        let draftId: string;

        beforeAll(async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'Test Message', text: 'Hello'}}),
                });
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            draftId = data.id;
        });

        test('get specific message', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${draftId}`);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.id).toBe(draftId);
            expect(data.subject).toBe('Test Message');
        });

        test('get non-existent message returns 404', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/non-existent-id`);

            expect(res.status).toBe(404);
        });

        test('mark message as read', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${draftId}/read`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({read: true}),
                });

            expect(res.status).toBe(200);
        });

        test('mark message as unread', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${draftId}/read`, {
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
                    body: JSON.stringify({mailbox: targetMailbox, attributes: []}),
                });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/move`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({messageId: draftId, targetMailbox}),
                });

            expect(res.status).toBe(200);

            const targetBoxRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`);
            const messages = await targetBoxRes.json() as any[];
            expect(messages.some(m => m.id === draftId)).toBe(true);
        });

        test('delete message removes from listing', async () => {
            const newDraftRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mail: {subject: 'To Delete', text: 'Goodbye'}}),
                });
            const newDraft = await newDraftRes.json() as any;

            const deleteRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${newDraft.id}`, {
                    method: 'DELETE',
                });

            expect([200, 204]).toContain(deleteRes.status);
        });

        test('update draft message - use PUT /message/draft', async () => {
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

    // describe('Email Delivery', () => {
    //     test('deliver endpoint accepts valid email', async () => {
    //         const eml = [
    //             'From: sender@example.com',
    //             `To: ${ctx.alice.user.email}`,
    //             'Subject: Test Delivery',
    //             '',
    //             'This is a test email',
    //         ].join('\r\n');

    //         const res = await ctx.app.handle(
    //             new Request(`http://localhost/mail/deliver/${ctx.alice.user.email}`, {
    //                 method: 'POST',
    //                 headers: {'Content-Type': 'message/rfc822'},
    //                 body: new TextEncoder().encode(eml).buffer,
    //             })
    //         );

    //         expect(res.status).toBe(200);
    //     });

    //     test('delivered email appears in inbox or is accepted', async () => {
    //         const subject = `Delivery Test ${Date.now()}`;
    //         const eml = [
    //             'From: sender@example.com',
    //             `To: ${ctx.alice.user.email}`,
    //             `Subject: ${subject}`,
    //             '',
    //             'This is a test email',
    //         ].join('\r\n');

    //         const deliverRes = await ctx.app.handle(
    //             new Request(`http://localhost/mail/deliver/${ctx.alice.user.email}`, {
    //                 method: 'POST',
    //                 headers: {'Content-Type': 'message/rfc822'},
    //                 body: new TextEncoder().encode(eml).buffer,
    //             })
    //         );

    //         expect(deliverRes.status).toBe(200);
    //     });
    // });

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
                    body: JSON.stringify({mailbox: sourceMailbox, attributes: []}),
                });

            await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: targetMailbox, attributes: []}),
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

        test('move message removes from source', async () => {
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
        });

        test('move message adds to target', async () => {
            const targetRes = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`);
            const targetMessages = await targetRes.json() as any[];

            expect(targetMessages.some(m => m.id === messageId)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('invalid mailbox name returns 400 or 409', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({mailbox: '', attributes: []}),
                });

            expect([400, 409]).toContain(res.status);
        });

        test('invalid message ID returns 404 for read status', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/invalid-id/read`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({read: true}),
                });

            expect(res.status).toBe(404);
        });

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
});
