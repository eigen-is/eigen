import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EmailDraft, EmailSummary } from '@workspace/lib/types/mail';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { assertJson, authedRequest, findOrFail, getTestContext } from '../setup';

const isWindows = process.platform === 'win32';
const SUBJECT = 'Attachment route fixture';
const RANGED_BODY = '0123456789';
const ODD_NAME = 'räp"ort.txt';

async function uploadDraftAttachment(sessionToken: string, ownerId: string, file: File): Promise<{ tempId: string }> {
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
    options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] },
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

describe.skipIf(isWindows)('Mail attachment routes', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let messageId: string;
    let guestToken: string;
    let guestId: string;

    const downloadUrl = (index: number, fileName: string): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/${fileName}`;
    const embedUrl = (index: number, fileName: string): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/embed/${fileName}`;

    beforeAll(async () => {
        ctx = await getTestContext();

        const boundary = 'att-routes';
        const eml = [
            'From: sender@external.com',
            `To: ${ctx.alice.user.email}`,
            `Subject: ${SUBJECT}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain',
            '',
            'See the parts.',
            `--${boundary}`,
            'Content-Type: text/html; charset=utf-8',
            'Content-Disposition: attachment; filename="page.html"',
            '',
            '<p>hello</p>',
            `--${boundary}`,
            'Content-Type: application/pdf',
            'Content-Disposition: attachment',
            '',
            '%PDF-1.4 stub',
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            'Content-Disposition: attachment; filename="ranged.txt"',
            '',
            RANGED_BODY,
            `--${boundary}`,
            'Content-Type: application/xml',
            'Content-Disposition: attachment; filename="feed.xml"',
            '',
            '<?xml version="1.0"?><rss/>',
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            `Content-Disposition: attachment; filename="=?UTF-8?B?${Buffer.from(ODD_NAME).toString('base64')}?="`,
            '',
            'odd name',
            `--${boundary}--`,
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        expect(deliverRes.status).toBe(200);

        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);
        const list = await assertJson<EmailSummary[]>(listRes);
        messageId = findOrFail(list, (m) => m.subject === SUBJECT).id;

        const email = `attachment-route-guest-${randomUUID()}@external.com`;
        const password = randomUUID();
        const created = await auth.api.createUser({ body: { email, password, name: 'Route Guest', role: 'user' } });
        // Set to 'guest' directly — the admin plugin only allows 'user'/'admin' via the API.
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        guestToken = (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';
        guestId = created.user.id;
    });

    test("another user's message is refused with 403 on both routes", async () => {
        const download = await authedRequest(ctx.bob.user.sessionToken, downloadUrl(0, 'page.html'));
        expect(download.status).toBe(403);
        const embed = await authedRequest(ctx.bob.user.sessionToken, embedUrl(0, 'page.html'));
        expect(embed.status).toBe(403);
    });

    test('a guest is refused with 403 on both routes', async () => {
        const download = await authedRequest(
            guestToken,
            `/mail/${guestId}/message/${messageId}/attachment/0/page.html`,
        );
        expect(download.status).toBe(403);
        const embed = await authedRequest(
            guestToken,
            `/mail/${guestId}/message/${messageId}/attachment/0/embed/page.html`,
        );
        expect(embed.status).toBe(403);
    });

    test('an out-of-range index is 404 on both routes', async () => {
        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(9, 'page.html'));
        expect(download.status).toBe(404);
        const embed = await authedRequest(ctx.alice.user.sessionToken, embedUrl(9, 'page.html'));
        expect(embed.status).toBe(404);
    });

    test('the download route serves the real content type, nosniff and an attachment disposition', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'ignored-url-name.bin'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(res.headers.get('content-length')).toBe('12');
        expect(await res.text()).toBe('<p>hello</p>');
    });

    test('the download route carries no sandbox CSP', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'page.html'));
        expect(res.headers.get('content-security-policy')).toBeNull();
    });

    test('the embed route serves inline with the sandbox CSP for a scriptable part', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, embedUrl(0, 'page.html'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html');
        expect(res.headers.get('content-disposition')).toBe('inline; filename="page.html"');
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await res.text()).toBe('<p>hello</p>');
    });

    test('a filename-less part falls back to its 1-based name on both routes', async () => {
        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(1, 'whatever.pdf'));
        expect(download.status).toBe(200);
        expect(download.headers.get('content-type')).toBe('application/pdf');
        expect(download.headers.get('content-disposition')).toBe('attachment; filename="attachment-2"');
        const embed = await authedRequest(ctx.alice.user.sessionToken, embedUrl(1, 'whatever.pdf'));
        expect(embed.headers.get('content-disposition')).toBe('inline; filename="attachment-2"');
        expect(embed.headers.get('content-security-policy')).toBeNull();
    });

    test('a range request returns 206 with the matching slice', async () => {
        const full = await authedRequest(ctx.alice.user.sessionToken, embedUrl(2, 'ranged.txt'));
        expect(await full.text()).toBe(RANGED_BODY);

        const res = await authedRequest(ctx.alice.user.sessionToken, embedUrl(2, 'ranged.txt'), {
            headers: { range: 'bytes=2-5' },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(`bytes 2-5/${RANGED_BODY.length}`);
        expect(res.headers.get('content-length')).toBe('4');
        expect(await res.text()).toBe('2345');
    });

    test('an unsatisfiable range returns 416', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, embedUrl(2, 'ranged.txt'), {
            headers: { range: 'bytes=99-120' },
        });
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe(`bytes */${RANGED_BODY.length}`);
    });

    test('If-None-Match with the served ETag returns 304 on both routes', async () => {
        const first = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'page.html'));
        const etag = first.headers.get('etag');
        expect(etag).toBeString();

        const second = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'page.html'), {
            headers: { 'if-none-match': etag ?? '' },
        });
        expect(second.status).toBe(304);
        expect(second.headers.get('etag')).toBe(etag);

        const embedRes = await authedRequest(ctx.alice.user.sessionToken, embedUrl(0, 'page.html'), {
            headers: { 'if-none-match': etag ?? '' },
        });
        expect(embedRes.status).toBe(304);
    });

    test('the ETag differs per part index', async () => {
        const first = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'page.html'));
        const second = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(1, 'attachment-2'));
        expect(first.headers.get('etag')).not.toBe(second.headers.get('etag'));
    });

    test('a rewritten draft serves a new ETag for the same part index', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const uploadA = await uploadDraftAttachment(token, ownerId, new File(['AAA'], 'a.txt', { type: 'text/plain' }));
        const draft = await putDraft(
            token,
            ownerId,
            { subject: 'Rewritten draft', text: 'first', html: '<p>first</p>', isDraft: true, mailbox: 'Drafts' },
            { tempAttachmentIds: [uploadA.tempId] },
        );
        const partUrl = `/mail/${ownerId}/message/${draft.id}/attachment/0/part.txt`;

        const before = await authedRequest(token, partUrl);
        expect(await before.text()).toBe('AAA');
        const staleEtag = before.headers.get('etag') ?? '';
        expect(staleEtag).not.toBe('');

        const uploadB = await uploadDraftAttachment(
            token,
            ownerId,
            new File(['BBBBBB'], 'b.txt', { type: 'text/plain' }),
        );
        const resaved = await putDraft(
            token,
            ownerId,
            { ...draft, text: 'second', html: '<p>second</p>' },
            { tempAttachmentIds: [uploadB.tempId], keepAttachmentIndexes: [] },
        );
        expect(resaved.id).toBe(draft.id);

        const after = await authedRequest(token, partUrl);
        expect(await after.text()).toBe('BBBBBB');
        expect(after.headers.get('etag')).not.toBe(staleEtag);

        const revalidated = await authedRequest(token, partUrl, { headers: { 'if-none-match': staleEtag } });
        expect(revalidated.status).toBe(200);
        expect(await revalidated.text()).toBe('BBBBBB');
    });

    test('the download route serves a range as 206', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(2, 'ranged.txt'), {
            headers: { range: 'bytes=4-' },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(`bytes 4-9/${RANGED_BODY.length}`);
        expect(res.headers.get('content-length')).toBe('6');
        expect(await res.text()).toBe('456789');
    });

    test('an XML part is sandboxed on the embed route', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, embedUrl(3, 'feed.xml'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/xml');
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    });

    test('a non-ASCII filename with a quote is served as an RFC 5987 disposition', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(4, 'odd.txt'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe(
            `attachment; filename="r_p_ort.txt"; filename*=UTF-8''${encodeURIComponent(ODD_NAME)}`,
        );
    });

    test('a negative index is refused at the schema boundary on both routes', async () => {
        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(-1, 'page.html'));
        expect(download.status).toBe(422);
        const embed = await authedRequest(ctx.alice.user.sessionToken, embedUrl(-1, 'page.html'));
        expect(embed.status).toBe(422);
    });
});
