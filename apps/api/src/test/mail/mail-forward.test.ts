import { beforeAll, describe, expect, test } from 'bun:test';
import type { Email, EmailDraft, EmailSummary } from '@workspace/lib/types/mail';
import { mailAttachmentName } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, findOrFail, getTestContext, putDraft, uploadDraftAttachment } from '../setup';

// A forward carries the original's parts through two routes that already exist: the composer fetches each
// part from its download route and uploads it as a draft attachment, as if the user had picked the file.
// These tests pin that the round trip keeps each part's name, type and bytes all the way into Sent.

const isWindows = process.platform === 'win32';
const SUBJECT = 'Forward fixture';
const PLAIN_SUBJECT = 'Forward fixture without parts';
const PDF_BYTES = '%PDF-1.4 forwarded stub';
// Not valid UTF-8, so a part that went through a text decode on the way would come back changed.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

describe.skipIf(isWindows)('Mail — forwarding a message with its attachments', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let token: string;
    let ownerId: string;

    const deliver = async (eml: string): Promise<void> => {
        const res = await authedRequest(token, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        expect(res.status).toBe(200);
    };

    const messageBySubject = async (mailbox: string, subject: string): Promise<Email> => {
        const list = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${mailbox}`),
        );
        const id = findOrFail(list, (m) => m.subject === subject).id;
        return assertJson<Email>(await authedRequest(token, `/mail/${ownerId}/message/${id}`));
    };

    const partBytes = async (messageId: string, index: number, name: string): Promise<Buffer> => {
        const res = await authedRequest(
            token,
            `/mail/${ownerId}/message/${messageId}/attachment/${index}/${encodeURIComponent(name)}`,
        );
        expect(res.status).toBe(200);
        return Buffer.from(await res.arrayBuffer());
    };

    // What the composer does for each part it forwards: download, then upload under the chip's name and type.
    const stagePart = async (original: Email, index: number): Promise<string> => {
        const att = findOrFail(original.attachments, (a) => a.index === index);
        const name = mailAttachmentName(att, att.index);
        const bytes = await partBytes(original.id, att.index, name);
        const file = new File([new Uint8Array(bytes)], name, { type: att.contentType });
        return (await uploadDraftAttachment(token, ownerId, file)).tempId;
    };

    const sendForward = async (original: Email, tempAttachmentIds: string[]): Promise<Email> => {
        const subject = `FW: ${original.subject} ${crypto.randomUUID()}`;
        const draft: EmailDraft = await putDraft(
            token,
            ownerId,
            {
                subject,
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' },
                text: 'forwarded',
                html: '<p>forwarded</p>',
            },
            { tempAttachmentIds },
        );
        const res = await authedRequest(token, `/mail/${ownerId}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: draft }),
        });
        expect(res.status).toBe(200);
        return messageBySubject('Sent', subject);
    };

    beforeAll(async () => {
        ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;

        const boundary = 'fwd-mixed';
        const related = 'fwd-related';
        await deliver(
            [
                'From: sender@external.com',
                `To: ${ctx.alice.user.email}`,
                `Subject: ${SUBJECT}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                `Content-Type: multipart/related; boundary="${related}"`,
                '',
                `--${related}`,
                'Content-Type: text/html; charset=utf-8',
                '',
                '<p>Our logo: <img src="cid:logo@fixture"></p>',
                `--${related}`,
                'Content-Type: image/png',
                'Content-ID: <logo@fixture>',
                'Content-Disposition: inline; filename="logo.png"',
                'Content-Transfer-Encoding: base64',
                '',
                PNG_BYTES.toString('base64'),
                `--${related}--`,
                `--${boundary}`,
                'Content-Type: application/pdf',
                'Content-Disposition: attachment; filename="invoice.pdf"',
                '',
                PDF_BYTES,
                `--${boundary}--`,
            ].join('\r\n'),
        );
        await deliver(
            [
                'From: sender@external.com',
                `To: ${ctx.alice.user.email}`,
                `Subject: ${PLAIN_SUBJECT}`,
                'Content-Type: text/plain',
                '',
                'Nothing attached.',
            ].join('\r\n'),
        );
    });

    test('a forward of a message with two parts sends both, each with its name, type and bytes', async () => {
        const original = await messageBySubject('inbox', SUBJECT);
        // The inline logo is a part like the invoice: the reader shows it as a chip, so a forward carries it.
        expect(original.attachments.map((a) => a.filename)).toEqual(['logo.png', 'invoice.pdf']);

        const tempIds = [];
        for (const att of original.attachments) tempIds.push(await stagePart(original, att.index));
        const sent = await sendForward(original, tempIds);

        expect(sent.attachments.map((a) => [a.filename, a.contentType])).toEqual([
            ['logo.png', 'image/png'],
            ['invoice.pdf', 'application/pdf'],
        ]);
        expect(await partBytes(sent.id, 0, 'logo.png')).toEqual(PNG_BYTES);
        expect((await partBytes(sent.id, 1, 'invoice.pdf')).toString()).toBe(PDF_BYTES);
    });

    test('a part removed in the composer is not sent', async () => {
        const original = await messageBySubject('inbox', SUBJECT);
        const invoice = findOrFail(original.attachments, (a) => a.filename === 'invoice.pdf');
        const sent = await sendForward(original, [await stagePart(original, invoice.index)]);
        expect(sent.attachments.map((a) => a.filename)).toEqual(['invoice.pdf']);
    });

    test('a forward of a message without attachments still sends', async () => {
        const original = await messageBySubject('inbox', PLAIN_SUBJECT);
        expect(original.attachments).toEqual([]);
        const sent = await sendForward(original, []);
        expect(sent.attachments).toEqual([]);
    });
});
