import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, EmailDraft, SentMailResult } from '@workspace/lib/types/mail';
import * as mailer from '../../lib/core/mailer';
import { assertJson, authedRequest, getTestContext } from '../setup';

const isWindows = process.platform === 'win32';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let sent: mailer.OutboundMail[] = [];
let spy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
    ctx = await getTestContext();
});

// Capture every OutboundMail handed to sendMail; `fail` decides which copies are rejected.
const startCapture = (fail: (m: mailer.OutboundMail) => boolean = () => false) => {
    sent = [];
    spy = spyOn(mailer, 'sendMail').mockImplementation(async (m) => {
        sent.push(m);
        return !fail(m);
    });
};
afterEach(() => spy?.mockRestore());

function addr(list: string): AddressObject {
    const value = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((address) => ({ address, name: '' }));
    return { value, text: list };
}

function makeRef(id: string): AttachmentReference {
    return {
        type: 'reference',
        ownerId: ctx.alice.user.id,
        mountId: 'default',
        id,
        name: 'Release Notes.eigendoc',
        driveType: 'doc',
        mimeType: 'application/eigendoc',
    };
}

async function uploadAttachment(bytes: number): Promise<string> {
    const form = new FormData();
    form.append('file', new File(['a'.repeat(bytes)], 'deck.pdf', { type: 'application/pdf' }));
    const res = await authedRequest(
        ctx.alice.user.sessionToken,
        `/mail/${ctx.alice.user.id}/message/draft/attachment`,
        {
            method: 'POST',
            body: form,
        },
    );
    return (await assertJson<{ tempId: string }>(res)).tempId;
}

async function sendMailBody(mail: Record<string, unknown>): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail }),
    });
}

// PUT a draft carrying a doc reference, then POST send. The send body is the same mail plus the saved
// id — never the PUT response — so the assertions never depend on the EML round-trip's field order.
async function sendDraftWithRef(
    to: string,
    opts: {
        cc?: string;
        bcc?: string;
        refs?: AttachmentReference[];
        inReplyTo?: string;
        references?: string | string[];
        tempAttachmentIds?: string[];
    } = {},
): Promise<{ draft: EmailDraft; res: Response }> {
    const mail = {
        subject: 'Ref send',
        to: addr(to),
        text: 'see attached doc',
        html: '<p>see attached doc</p>',
        driveReferences: opts.refs ?? [makeRef('doc-send')],
        ...(opts.cc ? { cc: addr(opts.cc) } : {}),
        ...(opts.bcc ? { bcc: addr(opts.bcc) } : {}),
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
        ...(opts.references ? { references: opts.references } : {}),
    };

    const putRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail, tempAttachmentIds: opts.tempAttachmentIds }),
    });
    const draft = await assertJson<EmailDraft>(putRes);

    const res = await sendMailBody({ ...mail, id: draft.id });
    return { draft, res };
}

const addresses = (list?: { address: string }[]) => (list ?? []).map((a) => a.address).sort();

describe.skipIf(isWindows)('Mail — per-recipient send copies', () => {
    test('mixed recipients produce one internal copy plus one personalised copy per external', async () => {
        startCapture();
        const { draft, res } = await sendDraftWithRef('bob@test.eigen.is, ext1@x.com', { cc: 'ext2@y.com' });
        expect(res.status).toBe(200);

        expect(sent.length).toBe(3);
        const expectedId = `<${draft.id}@test.eigen.is>`;
        for (const m of sent) {
            expect(addresses(m.to)).toEqual(['bob@test.eigen.is', 'ext1@x.com']);
            expect(addresses(m.cc)).toEqual(['ext2@y.com']);
            expect(m.messageId).toBe(expectedId);
            expect(m.bcc).toBeUndefined();
            expect(m.envelope?.from).toBe(ctx.alice.user.email);
        }

        const internal = sent.find((m) => m.envelope?.to.includes('bob@test.eigen.is'));
        const ext1 = sent.find((m) => m.envelope?.to.includes('ext1@x.com'));
        const ext2 = sent.find((m) => m.envelope?.to.includes('ext2@y.com'));

        expect(internal!.envelope!.to).toEqual(['bob@test.eigen.is']);
        expect(internal!.html).not.toContain('email=');
        expect(internal!.text).not.toContain('email=');

        expect(ext1!.envelope!.to).toEqual(['ext1@x.com']);
        expect(ext1!.html).toContain('email=ext1%40x.com');
        expect(ext1!.text).toContain('email=ext1%40x.com');
        expect(ext1!.html).not.toContain('ext2%40y.com');

        expect(ext2!.envelope!.to).toEqual(['ext2@y.com']);
        expect(ext2!.html).toContain('email=ext2%40y.com');
        expect(ext2!.text).toContain('email=ext2%40y.com');

        // The envelope + pinned Message-ID must land on the final nodemailer options.
        const options = mailer.buildMailOptions(ext1!);
        expect(options.envelope).toEqual({ from: ctx.alice.user.email, to: ['ext1@x.com'] });
        expect(options.messageId).toBe(expectedId);
    });

    test('the Sent EML stays bare — no per-recipient email prefill baked into it', async () => {
        startCapture();
        const { draft, res } = await sendDraftWithRef('bob@test.eigen.is, ext1@x.com');
        expect(res.status).toBe(200);

        const getRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${draft.id}`,
        );
        const stored = await assertJson<EmailDraft>(getRes);
        expect(String(stored.html)).toContain('doc-send');
        expect(String(stored.html)).not.toContain('email=');
    });

    test('internal-only mail with refs sends exactly once, with no envelope', async () => {
        startCapture();
        const { res } = await sendDraftWithRef('bob@test.eigen.is');
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].envelope).toBeUndefined();
        expect(sent[0].html).not.toContain('email=');
        expect(sent[0].text).toContain('doc-send');
    });

    test('mail without refs sends exactly once, with no envelope', async () => {
        startCapture();
        const { res } = await sendDraftWithRef('ext1@x.com', { refs: [] });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].envelope).toBeUndefined();
    });

    test('a small attachment stays inside the personalisation budget', async () => {
        startCapture();
        const tempId = await uploadAttachment(1024);
        const { res } = await sendDraftWithRef('ext1@x.com, ext2@y.com', { tempAttachmentIds: [tempId] });
        expect(res.status).toBe(200);

        expect(sent.length).toBe(2);
        for (const m of sent) {
            expect(m.envelope).toBeDefined();
            expect(m.attachments?.length).toBe(1);
        }
        expect(sent.find((m) => m.envelope!.to[0] === 'ext1@x.com')!.html).toContain('email=ext1%40x.com');
        expect(sent.find((m) => m.envelope!.to[0] === 'ext2@y.com')!.html).toContain('email=ext2%40y.com');
    });

    test('past the personalisation byte budget every recipient gets one bare-link copy', async () => {
        startCapture();
        // 50 externals x 512 KB of attachment = 25 MB of fan-out, past the 20 MB budget.
        const tempId = await uploadAttachment(512 * 1024);
        const to = Array.from({ length: 50 }, (_, i) => `bulk${i}@x.com`).join(', ');
        const { res } = await sendDraftWithRef(to, { tempAttachmentIds: [tempId] });
        expect(res.status).toBe(200);

        expect(sent.length).toBe(1);
        expect(sent[0].envelope).toBeUndefined();
        expect(sent[0].to.length).toBe(50);
        expect(sent[0].html).not.toContain('email=');
        expect(sent[0].text).not.toContain('email=');
        expect(sent[0].text).toContain('doc-send');
    });

    test('a bcc external gets a personalised copy whose envelope and headers hide the bcc', async () => {
        startCapture();
        const { res } = await sendDraftWithRef('bob@test.eigen.is', { bcc: 'bcc-ext@z.com' });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(2);

        const bccCopy = sent.find((m) => m.envelope?.to.includes('bcc-ext@z.com'));
        expect(bccCopy).toBeDefined();
        expect(bccCopy!.envelope!.to).toEqual(['bcc-ext@z.com']);
        expect(bccCopy!.html).toContain('email=bcc-ext%40z.com');
        expect(bccCopy!.bcc).toBeUndefined();
        expect(addresses(bccCopy!.to)).not.toContain('bcc-ext@z.com');
        expect(addresses(bccCopy!.cc)).not.toContain('bcc-ext@z.com');

        const options = mailer.buildMailOptions(bccCopy!);
        expect('bcc' in options).toBe(false);
    });

    test('partial delivery failure still sends, reports failedRecipients, moves to Sent', async () => {
        startCapture((m) => m.envelope?.to.includes('ext1@x.com') ?? false);
        const { draft, res } = await sendDraftWithRef('bob@test.eigen.is, ext1@x.com', { cc: 'ext2@y.com' });
        const body = await assertJson<SentMailResult>(res);
        expect(body.failedRecipients).toEqual(['ext1@x.com']);

        const getRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${draft.id}`,
        );
        const stored = await assertJson<EmailDraft>(getRes);
        expect(stored.isDraft).toBe(false);
    });

    test('total delivery failure keeps the draft in Drafts and 500s', async () => {
        startCapture(() => true);
        const { draft, res } = await sendDraftWithRef('bob@test.eigen.is, ext1@x.com');
        expect(res.status).toBe(500);

        const getRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${draft.id}`,
        );
        const stored = await assertJson<EmailDraft>(getRes);
        expect(stored.isDraft).toBe(true);
    });

    // Bounded at the schema (maxItems) on both the draft PUT and the send POST, so the TypeBox
    // violation surfaces as a 422 before the handler renders a pill per reference.
    test('too many drive references is rejected with 422, before any save or send', async () => {
        startCapture();
        const driveReferences = Array.from({ length: 21 }, (_, i) => makeRef(`doc-${i}`));
        const mail = { subject: 'Too many refs', to: addr('bob@test.eigen.is'), text: 'hi', driveReferences };

        const putRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail }),
        });
        expect(putRes.status).toBe(422);
        expect((await sendMailBody(mail)).status).toBe(422);
        expect(sent.length).toBe(0);
    });

    test('too many recipients is rejected with 400', async () => {
        startCapture();
        const many = Array.from({ length: 101 }, (_, i) => `r${i}@x.com`).join(', ');
        const { res } = await sendDraftWithRef(many);
        expect(res.status).toBe(400);
    });

    test('threading headers survive the full-save round-trip', async () => {
        startCapture();
        const { draft, res } = await sendDraftWithRef('ext1@x.com', {
            inReplyTo: '<parent@x.com>',
            references: ['<r1@x.com>'],
        });
        expect(res.status).toBe(200);

        expect(sent.length).toBe(1);
        expect(sent[0].inReplyTo).toBe('<parent@x.com>');
        expect(sent[0].references).toEqual(['<r1@x.com>']);

        const rawRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${draft.id}/download`,
        );
        const raw = await rawRes.text();
        expect(raw).toMatch(/In-Reply-To/i);
    });

    test('an RFC 2822 group in To is flattened into the delivered recipients on the send path', async () => {
        startCapture();
        const groupTo: AddressObject = {
            value: [
                {
                    name: 'Team',
                    group: [
                        { name: 'Alpha', address: 'alpha@x.com' },
                        { name: 'Beta', address: 'beta@x.com' },
                    ],
                },
            ],
            text: 'Team: alpha@x.com, beta@x.com;',
        };
        const res = await sendMailBody({ subject: 'Group send', to: groupTo, text: 'hi team', html: '<p>hi team</p>' });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(addresses(sent[0].to)).toEqual(['alpha@x.com', 'beta@x.com']);
    });

    // No prior PUT, so the wire header and the Sent EML are minted in one shot — the path that used
    // to hand them two different ids.
    test('an id-less send pins the wire Message-ID to the Sent EML header', async () => {
        startCapture();
        const res = await sendMailBody({
            subject: 'No prior save',
            to: addr('ext1@x.com'),
            text: 'hi',
            html: '<p>hi</p>',
        });
        expect(res.status).toBe(200);
        const result = await assertJson<SentMailResult>(res);

        expect(sent.length).toBe(1);
        const wireId = sent[0].messageId;
        expect(wireId).toBe(`<${result.id}@test.eigen.is>`);

        const rawRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${result.id}/download`,
        );
        const raw = await rawRes.text();
        const headerId = raw.match(/^Message-ID:\s*(<[^>]+>)/im)?.[1];
        expect(headerId).toBe(wireId);
    });

    test('an empty-string draft id does not mint a <@domain> Message-ID', async () => {
        startCapture();
        const res = await sendMailBody({
            id: '',
            subject: 'Empty id',
            to: addr('ext1@x.com'),
            text: 'hi',
            html: '<p>hi</p>',
        });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].messageId).not.toBe('<@test.eigen.is>');
        expect(sent[0].messageId).toMatch(/^<.+@test\.eigen\.is>$/);
    });

    test('a ref-only send with empty subject and body is allowed and carries the pills', async () => {
        startCapture();
        const res = await sendMailBody({
            subject: '',
            to: addr('bob@test.eigen.is'),
            text: '',
            html: '',
            driveReferences: [makeRef('doc-refonly')],
        });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].text).toContain('Release Notes');
        expect(String(sent[0].html)).toContain('doc-refonly');
    });

    test('a truly empty send (no subject, body, or refs) is rejected with 400', async () => {
        startCapture();
        const res = await sendMailBody({ subject: '', to: addr('bob@test.eigen.is'), text: '', html: '' });
        expect(res.status).toBe(400);
        expect(sent.length).toBe(0);
    });

    test('an empty-subject send with a body goes out with an empty Subject, not a placeholder', async () => {
        startCapture();
        const res = await sendMailBody({
            subject: '',
            to: addr('ext1@x.com'),
            text: 'has a body',
            html: '<p>has a body</p>',
        });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].subject).toBe('');
    });

    // Clearing a recipient field on an existing draft (the FE sends `undefined` for a cleared
    // field) must not be resurrected from the draft-meta sidecar on the next full save or send.
    test('clearing Cc on a saved draft drops it from the reloaded draft and the sent copies', async () => {
        startCapture();
        const put = (mail: Record<string, unknown>) =>
            authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail }),
            });

        // 1. Save a draft addressed To + Cc — a full save that writes the sidecar with cc=bob.
        const first = await assertJson<EmailDraft>(
            await put({
                subject: 'Clear cc',
                to: addr('to@x.com'),
                cc: addr('bob@x.com'),
                text: 'hi',
                html: '<p>hi</p>',
            }),
        );
        expect(first.cc?.value.map((a) => a.address)).toEqual(['bob@x.com']);

        // 2. Save again with Cc cleared (omitted → undefined).
        const cleared = await assertJson<EmailDraft>(
            await put({ id: first.id, subject: 'Clear cc', to: addr('to@x.com'), text: 'hi', html: '<p>hi</p>' }),
        );
        expect(cleared.cc?.value ?? []).toEqual([]);

        // 3. Reloading the draft still shows no Cc.
        const reloaded = await assertJson<EmailDraft>(
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${first.id}`),
        );
        expect(reloaded.cc?.value ?? []).toEqual([]);

        // 4. Sending the cleared draft must not deliver to the removed Cc recipient.
        const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: { id: first.id, subject: 'Clear cc', to: addr('to@x.com'), text: 'hi', html: '<p>hi</p>' },
            }),
        });
        expect(res.status).toBe(200);
        expect(sent.length).toBe(1);
        expect(sent[0].cc).toBeUndefined();
        expect(addresses(sent[0].to)).toEqual(['to@x.com']);
    });

    // The read-side sibling of the test above: a fast save rewrites only the sidecar, leaving the
    // EML stale, so a cleared Cc survives the reload only if messageGet takes the sidecar verbatim.
    test('a Cc cleared on the fast-save path stays cleared when the draft is reloaded', async () => {
        const tempId = await uploadAttachment(16);
        const put = (mail: Record<string, unknown>, options: Record<string, unknown>) =>
            authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail, ...options }),
            });

        // 1. Full save with an attachment: bakes Cc into the EML and arms the fast path.
        const first = await assertJson<EmailDraft>(
            await put(
                { subject: 'Fast clear', to: addr('to@x.com'), cc: addr('bob@x.com'), text: 'hi', html: '<p>hi</p>' },
                { tempAttachmentIds: [tempId] },
            ),
        );
        expect(first.attachments.length).toBe(1);

        // 2. Fast save with Cc omitted (cleared) — attachments untouched, so no EML rebuild.
        const cleared = await assertJson<EmailDraft>(
            await put(
                { id: first.id, subject: 'Fast clear', to: addr('to@x.com'), text: 'hi', html: '<p>hi</p>' },
                { keepAttachmentIndexes: [0] },
            ),
        );
        expect(cleared.cc?.value ?? []).toEqual([]);

        // 3. The EML on disk is indeed stale and still carries the Cc — that is what must not win.
        const rawRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${first.id}/download`,
        );
        expect(await rawRes.text()).toMatch(/^Cc:.*bob@x\.com/im);

        // 4. Reloading the draft still shows no Cc.
        const reloaded = await assertJson<EmailDraft>(
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${first.id}`),
        );
        expect(reloaded.cc?.value ?? []).toEqual([]);
    });
});
