import { beforeAll, describe, expect, test } from 'bun:test';
import type { EmailDraft } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, getTestContext } from './setup';

const isWindows = process.platform === 'win32';

async function uploadDraftAttachment(
    sessionToken: string,
    ownerId: string,
    file: File,
): Promise<{ tempId: string; filename: string; size: number; contentType: string }> {
    const form = new FormData();
    form.append('file', file);
    const res = await authedRequest(sessionToken, `/mail/${ownerId}/message/draft/attachment`, {
        method: 'POST',
        body: form,
    });
    return assertJson(res);
}

async function putDraft(
    sessionToken: string,
    ownerId: string,
    mail: Partial<EmailDraft>,
    options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] } = {},
): Promise<EmailDraft> {
    const res = await authedRequest(sessionToken, `/mail/${ownerId}/message/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mail,
            tempAttachmentIds: options.tempAttachmentIds,
            keepAttachmentIndexes: options.keepAttachmentIndexes,
        }),
    });
    return assertJson(res);
}

describe.skipIf(isWindows)('Mail — Draft Attachments', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('upload returns tempId, filename, size, contentType', async () => {
        const file = new File(['hello-upload'], 'hello.txt', { type: 'text/plain' });
        const result = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);
        expect(result.tempId).toBeString();
        expect(result.tempId.length).toBeGreaterThan(8);
        expect(result.filename).toBe('hello.txt');
        expect(result.size).toBe('hello-upload'.length);
        expect(result.contentType).toStartWith('text/plain');
    });

    test('upload rejects empty request with 400', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/draft/attachment`,
            {
                method: 'POST',
                body: new FormData(),
            },
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('saving a draft with tempAttachmentIds embeds the attachment into the EML', async () => {
        const file = new File(['pdf-bytes-stub'], 'invoice.pdf', { type: 'application/pdf' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const draft = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'With attachment',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                    html: '',
                },
                text: 'see attached',
                html: '<p>see attached</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        expect(draft.mailbox).toBe('Drafts');
        expect(draft.attachments).toBeArray();
        expect(draft.attachments.length).toBe(1);
        const att = draft.attachments[0];
        expect(att.filename).toBe('invoice.pdf');
        expect(att.contentType).toStartWith('application/pdf');
    });

    test('re-saving a draft without tempIds preserves existing attachments', async () => {
        const file = new File(['keep-me'], 'keep.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Will re-save',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                    html: '',
                },
                text: 'first',
                html: '<p>first</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(first.attachments.length).toBe(1);

        const second = await putDraft(ctx.alice.user.sessionToken, ctx.alice.user.id, {
            ...first,
            subject: 'Will re-save',
            text: 'second body',
            html: '<p>second body</p>',
            isDraft: true,
            mailbox: 'Drafts',
        });
        expect(second.id).toBe(first.id);
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('keep.txt');
        expect(second.text?.trim()).toBe('second body');
    });

    test('sending a draft preserves attachments into the Sent mailbox', async () => {
        // In test env (localhost domain, non-production), sendMail() in ../lib/core/mailer
        // short-circuits to a console.log and returns true — no SMTP mock needed.
        const file = new File(['sent-bytes'], 'report.csv', { type: 'text/csv' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const draft = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Please review',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                    html: '',
                },
                text: 'csv attached',
                html: '<p>csv attached</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(draft.attachments.length).toBe(1);

        const sendRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: draft }),
        });
        expect(sendRes.status).toBe(200);

        const sentList = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/Sent`);
        const sent = await assertJson<Array<{ id: string; hasAttachments: boolean }>>(sentList);
        const found = sent.find((m) => m.id === draft.id);
        expect(found).toBeTruthy();
        expect(found?.hasAttachments).toBe(true);
    });

    test('keepAttachmentIndexes drops attachments the user removed', async () => {
        const a = new File(['a-bytes'], 'a.txt', { type: 'text/plain' });
        const b = new File(['b-bytes'], 'b.txt', { type: 'text/plain' });
        const uploadA = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, a);
        const uploadB = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, b);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Two attachments',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                    html: '',
                },
                text: 'both',
                html: '<p>both</p>',
            },
            { tempAttachmentIds: [uploadA.tempId, uploadB.tempId] },
        );
        expect(first.attachments.length).toBe(2);

        // User removes the second attachment in the UI, then auto-save fires with only index 0 kept.
        const second = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Two attachments',
                to: first.to,
                text: 'both',
                html: '<p>both</p>',
            },
            { keepAttachmentIndexes: [0] },
        );
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('a.txt');

        // Removing all attachments (empty keep list) must also be respected.
        const third = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: second.id,
                subject: 'Two attachments',
                to: second.to,
                text: 'none',
                html: '<p>none</p>',
            },
            { keepAttachmentIndexes: [] },
        );
        expect(third.attachments.length).toBe(0);
    });
});
