import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { MaildirStore } from '../../lib/mail/maildir-store';
// Static import of '../lib/core/mailer' would trigger server-config module evaluation
// before './setup' sets EIGEN_DATA_ROOT. Dynamic-import it inside the test instead.
import { assertJson, authedRequest, findOrFail, getTestContext } from '../setup';

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

    test('create mailbox with invalid name returns 400', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: 'Bad!Name' }),
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('Invalid mailbox');
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

    test('send with failing SMTP returns 500 and keeps draft in Drafts', async () => {
        const draftRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: {
                    subject: 'SMTP failure test',
                    text: 'body',
                    to: {
                        value: [{ address: 'target@example.com', name: '' }],
                        html: 'target@example.com',
                        text: 'target@example.com',
                    },
                },
            }),
        });
        const draft = await assertJson<EmailSummary>(draftRes);

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValueOnce(false);

        try {
            const sendRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/send`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mail: {
                            id: draft.id,
                            subject: 'SMTP failure test',
                            text: 'body',
                            to: {
                                value: [{ address: 'target@example.com', name: '' }],
                                html: 'target@example.com',
                                text: 'target@example.com',
                            },
                        },
                    }),
                },
            );

            expect(sendRes.status).toBe(500);
            expect(await sendRes.text()).toContain('Failed to send');

            const draftsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/Drafts`,
            );
            const drafts = await assertJson<EmailSummary[]>(draftsRes);
            expect(drafts.some((d) => d.id === draft.id)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    // Regression (audit P2-9): messageGet must return null (→404) ONLY for a genuine
    // cache-miss, and PROPAGATE real faults (unreadable/unparseable .eml, disk EIO) so
    // Elysia logs + 500s. Previously a triple swallow (messageGet/readAndParse/parseEml
    // → null) turned any fault on a visible message into a silent 404.
    describe('messageGet fault propagation', () => {
        test('unreadable .eml on a visible message returns 500, not a silent 404', async () => {
            // A draft gives us a summary row + a real .eml on disk (a message the user CAN see).
            const draftRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mail: { subject: 'Fault propagation', text: 'body' } }),
                },
            );
            const draft = await assertJson<EmailSummary>(draftRes);

            // Simulate the .eml being unreadable on disk (disk EIO / missing file) for the read
            // messageGet performs — a genuine fault, not a cache-miss.
            const spy = spyOn(MaildirStore.prototype, 'getMessageFile').mockReturnValue(
                Bun.file('/nonexistent/eigen-p2-9-missing.eml'),
            );
            try {
                const res = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/mail/${ctx.alice.user.id}/message/${draft.id}`,
                );
                expect(res.status).toBe(500);
            } finally {
                spy.mockRestore();
            }
        });

        test('genuine cache-miss (no summary row) still returns 404', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/no-such-message-id`,
            );
            expect(res.status).toBe(404);
        });
    });

    describe('Attachment download', () => {
        let messageId: string;

        beforeAll(async () => {
            const file = new File(['attachment-bytes'], 'download-me.txt', { type: 'text/plain' });
            const form = new FormData();
            form.append('file', file);
            const uploadRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft/attachment`,
                { method: 'POST', body: form },
            );
            const upload = await assertJson<{ tempId: string }>(uploadRes);

            const draftRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mail: { subject: 'Attachment download test', text: 'body' },
                        tempAttachmentIds: [upload.tempId],
                    }),
                },
            );
            const draft = await assertJson<EmailSummary>(draftRes);
            messageId = draft.id;
        });

        test('garbage :index is rejected with 422', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/abc/download-me.txt`,
            );
            expect(res.status).toBe(422);
        });

        test('valid :index still serves the attachment', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/0/download-me.txt`,
            );
            expect(res.status).toBe(200);
            expect(await res.text()).toBe('attachment-bytes');
        });
    });
});
