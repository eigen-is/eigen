import { beforeAll, describe, expect, test } from 'bun:test';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('Mail', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let draftMessageId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('list mailboxes returns structure', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailboxes`);
        const data = await assertJson<MaildirMailbox[]>(res);
        const inbox = findOrFail(data, (mailbox) => mailbox.path === '');
        expect(inbox.flags).toContain('\\Inbox');
    });

    test('create custom mailbox', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: 'Projects' }),
        });
        expect(res.status).toBe(200);
    });

    test('mailbox-exists returns mailbox metadata for created mailbox', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox-exists/Projects`,
        );
        const data = await assertJson<MaildirMailbox | false>(res);
        expect(data).not.toBe(false);
        expect((data as MaildirMailbox).path).toBe('Projects');
    });

    test('mailbox-exists returns false for unknown mailbox', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox-exists/does-not-exist`,
        );
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toBe(false);
    });

    test('create duplicate mailbox returns 409', async () => {
        const res1 = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: 'Duplicate' }),
        });
        expect(res1.status).toBe(200);

        const res2 = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: 'Duplicate' }),
        });
        expect(res2.status).toBe(409);
        const body = await res2.text();
        expect(body).toContain('already exists');
    });

    test('get unknown mailbox returns 404', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox/not-a-mailbox`,
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('not found');
    });

    test('set read on unknown message returns 404', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/non-existent-message/read`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ read: true }),
            },
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('not found');
    });

    test('draft creation returns draft with id', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: { subject: 'Integration draft', text: 'hello draft' } }),
        });

        const data = await assertJson<EmailSummary>(res);
        expect(data.id).toBeDefined();
        expect(data.mailbox).toBe('Drafts');
        draftMessageId = data.id;
    });

    test('draft appears in drafts mailbox listing', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/Drafts`);
        const data = await assertJson<EmailSummary[]>(res);
        findOrFail(data, (mail) => mail.id === draftMessageId);
    });

    test('public deliver endpoint returns 404 for unknown recipient', async () => {
        const eml = [
            'From: sender@example.com',
            'To: nobody@test.eigen.is',
            'Subject: Unknown recipient',
            '',
            'hello',
        ].join('\r\n');

        const res = await ctx.app.handle(
            new Request('http://localhost/mail/deliver/nobody@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );

        expect(res.status).toBe(404);
        expect(await res.text()).toContain('Recipient');
    });

    describe('Message Operations', () => {
        let operationDraftId: string;

        beforeAll(async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail: { subject: 'Operations Test', text: 'Hello' } }),
            });
            const data = await assertJson<EmailSummary>(res);
            operationDraftId = data.id;
        });

        test('get specific message', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}`,
            );
            const data = await assertJson<EmailSummary>(res);
            expect(data.id).toBe(operationDraftId);
            expect(data.subject).toBe('Operations Test');
        });

        test('get non-existent message returns 404', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/non-existent-id`,
            );
            expect(res.status).toBe(404);
        });

        test('mark message as read', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}/read`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ read: true }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('mark message as unread', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${operationDraftId}/read`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ read: false }),
                },
            );
            expect(res.status).toBe(200);
        });

        test('move message to different mailbox', async () => {
            const targetMailbox = `MoveTarget-${Date.now()}`;
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: targetMailbox }),
            });

            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId: operationDraftId, targetMailbox }),
            });
            expect(res.status).toBe(200);

            const targetBoxRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`,
            );
            const messages = await assertJson<EmailSummary[]>(targetBoxRes);
            expect(messages.some((m) => m.id === operationDraftId)).toBe(true);
        });

        test('delete message', async () => {
            const newDraftRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mail: { subject: 'To Delete', text: 'Goodbye' } }),
                },
            );
            const newDraft = await assertJson<EmailSummary>(newDraftRes);

            const deleteRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${newDraft.id}`,
                { method: 'DELETE' },
            );
            expect([200, 204]).toContain(deleteRes.status);
        });

        test('update draft message', async () => {
            const draftRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mail: { subject: 'Updated Draft', text: 'Updated body' } }),
                },
            );
            const draft = await assertJson<EmailSummary>(draftRes);
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

            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: sourceMailbox }),
            });
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: targetMailbox }),
            });

            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail: { subject: 'Move Test', text: 'Test' } }),
            });
            const data = await assertJson<EmailSummary>(res);
            messageId = data.id;

            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId, targetMailbox: sourceMailbox }),
            });
        });

        test('message exists in source mailbox', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${sourceMailbox}`,
            );
            const messages = await assertJson<EmailSummary[]>(res);
            expect(messages.some((m) => m.id === messageId)).toBe(true);
        });

        test('move message removes from source and adds to target', async () => {
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId, targetMailbox }),
            });

            const sourceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${sourceMailbox}`,
            );
            const sourceMessages = await assertJson<EmailSummary[]>(sourceRes);
            expect(sourceMessages.some((m) => m.id === messageId)).toBe(false);

            const targetRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/${targetMailbox}`,
            );
            const targetMessages = await assertJson<EmailSummary[]>(targetRes);
            expect(targetMessages.some((m) => m.id === messageId)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('move to non-existent mailbox returns 404', async () => {
            const draftRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mail: { subject: 'Move', text: 'Test' } }),
                },
            );
            const draft = await assertJson<EmailSummary>(draftRes);

            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId: draft.id, targetMailbox: 'NonExistentBox12345' }),
            });
            expect(res.status).toBe(404);
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob has his own mailboxes', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/mail/${ctx.bob.user.id}/mailboxes`);
            await assertJson<MaildirMailbox[]>(res);
        });

        test('ownerId spoofing is rejected with 403', async () => {
            const createRes = await authedRequest(ctx.bob.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: 'BobOnlyMailbox' }),
            });
            expect(createRes.status).toBe(403);
        });
    });

    describe('Regression: Path traversal in mailbox names', () => {
        test('create mailbox with .. traversal is rejected', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: '../../etc' }),
            });
            expect(res.status).not.toBe(200);
        });

        test('create mailbox with path separator traversal is rejected', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: '../../../etc/passwd' }),
            });
            expect(res.status).not.toBe(200);
        });

        test('mailbox-exists with traversal characters is rejected', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox-exists/..%2F..%2Fetc%2Fpasswd`,
            );
            // Should either return false or error, not leak file information
            if (res.status === 200) {
                const data = await res.json();
                expect(data).toBe(false);
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        });

        test('create mailbox with control characters is rejected', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: 'test\x00mailbox' }),
            });
            expect(res.status).not.toBe(200);
        });

        test('valid mailbox still works after rejected traversal attempts', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox: 'ValidAfterTraversal' }),
            });
            expect(res.status).toBe(200);

            const existsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox-exists/ValidAfterTraversal`,
            );
            const data = await assertJson<MaildirMailbox | false>(existsRes);
            expect(data).not.toBe(false);
            expect((data as MaildirMailbox).path).toBe('ValidAfterTraversal');
        });
    });
});
