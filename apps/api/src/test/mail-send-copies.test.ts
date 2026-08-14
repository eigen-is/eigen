import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, EmailDraft } from '@workspace/lib/types/mail';
import * as mailer from '../lib/core/mailer';
import { assertJson, authedRequest, getTestContext } from './setup';

const isWindows = process.platform === 'win32';

type SentResult = EmailDraft & { failedRecipients?: string[] };

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
    return { value, html: '', text: list };
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

// PUT a draft carrying a doc reference, then POST send. to/cc/bcc are re-applied on the send
// body from the known inputs so the assertions never depend on the EML round-trip's field order.
async function sendDraftWithRef(
    to: string,
    opts: {
        cc?: string;
        bcc?: string;
        refs?: AttachmentReference[];
        inReplyTo?: string;
        references?: string | string[];
    } = {},
): Promise<{ draft: EmailDraft; res: Response }> {
    const refs = opts.refs ?? [makeRef('doc-send')];
    const fields = {
        ...(opts.cc ? { cc: addr(opts.cc) } : {}),
        ...(opts.bcc ? { bcc: addr(opts.bcc) } : {}),
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
        ...(opts.references ? { references: opts.references } : {}),
    };
    const mail = {
        subject: 'Ref send',
        to: addr(to),
        text: 'see attached doc',
        html: '<p>see attached doc</p>',
        driveReferences: refs,
        ...fields,
    };

    const putRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail }),
    });
    const draft = await assertJson<EmailDraft>(putRes);

    const sendBody = { ...draft, to: addr(to), driveReferences: refs, ...fields };

    const res = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail: sendBody }),
    });
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
        const body = await assertJson<SentResult>(res);
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

    test('too many drive references is rejected with 400', async () => {
        startCapture();
        const refs = Array.from({ length: 21 }, (_, i) => makeRef(`doc-${i}`));
        const { res } = await sendDraftWithRef('bob@test.eigen.is', { refs });
        expect(res.status).toBe(400);
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
});
