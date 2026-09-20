import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { IMPORT_MAX_BYTES } from '@workspace/lib/constants/contact';
import { TEXT_PREVIEW_MAX_BYTES } from '@workspace/lib/constants/preview';
import { EML_MIME, ICS_MIME } from '@workspace/lib/types/drive';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { EmlPreview, IcsPreview, TextPreviewResult, VCardPreview } from '@workspace/lib/types/preview';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getHome } from '../../lib/home';
import { assertJson, authedRequest, findOrFail, getTestContext, putDraft, uploadDraftAttachment } from '../setup';

const isWindows = process.platform === 'win32';
const SUBJECT = 'Attachment route fixture';
const RANGED_BODY = '0123456789';
const ODD_NAME = 'räp"ort.txt';
const ATTACHED_SUBJECT = 'Attached message fixture';
const OVERSIZE_SUBJECT = 'Oversize vCard fixture';
const OVERSIZE_TEXT_SUBJECT = 'Oversize text fixture';
const INVITE_SUBJECT = 'Invitation fixture';
const OVERSIZE_ICS_SUBJECT = 'Oversize calendar fixture';
const NOTES_BODY = 'First line.\r\n\r\nSecond paragraph.';
// A sender names the parts, so one named after a preview route must still download as its own bytes.
const SHADOW_NAMED_BODY = 'bytes, not a preview';
// Latin-1 bytes: read as UTF-8 the 0xE9 comes back as a replacement character.
const LATIN_BODY = 'caf\u00e9 au lait';
const VCARD_BODY = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Ada Lovelace',
    'N:Lovelace;Ada;;;',
    'EMAIL:ada@example.com',
    'END:VCARD',
].join('\r\n');

describe.skipIf(isWindows)('Mail attachment routes', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let messageId: string;
    let guestToken: string;
    let guestId: string;

    const downloadUrl = (index: number, fileName: string): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/${fileName}`;
    const embedUrl = (index: number, fileName: string): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/embed/${fileName}`;
    const textPreviewUrl = (index: number): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/preview/text`;
    const vcardPreviewUrl = (index: number): string =>
        `/mail/${ctx.alice.user.id}/message/${messageId}/attachment/${index}/preview/vcard`;

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
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            'Content-Disposition: attachment; filename="notes.txt"',
            '',
            NOTES_BODY,
            `--${boundary}`,
            'Content-Type: text/markdown; charset=utf-8',
            'Content-Disposition: attachment; filename="readme.md"',
            '',
            '# Title',
            '',
            'A paragraph.',
            `--${boundary}`,
            'Content-Type: text/vcard; charset=utf-8',
            'Content-Disposition: attachment; filename="card.vcf"',
            '',
            VCARD_BODY,
            `--${boundary}`,
            'Content-Type: application/eigendoc',
            'Content-Disposition: attachment; filename="spoof.txt"',
            '',
            'Plain text wearing a document mime.',
            `--${boundary}`,
            'Content-Type:',
            'Content-Disposition: attachment; filename="typeless.bin"',
            '',
            'no type here',
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            'Content-Disposition: attachment; filename="text-preview"',
            '',
            SHADOW_NAMED_BODY,
            `--${boundary}`,
            'Content-Type: text/plain; charset=iso-8859-1',
            'Content-Disposition: attachment; filename="latin.txt"',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(LATIN_BODY, 'latin1').toString('base64'),
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
        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(12, 'page.html'));
        expect(download.status).toBe(404);
        const embed = await authedRequest(ctx.alice.user.sessionToken, embedUrl(12, 'page.html'));
        expect(embed.status).toBe(404);
    });

    test('the download route serves the real content type, nosniff and an attachment disposition', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(0, 'ignored-url-name.bin'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
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
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
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

    test('a multi-range header is ignored, so the whole body comes back as a 200', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, embedUrl(2, 'ranged.txt'), {
            headers: { range: 'bytes=0-1,4-5' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-range')).toBeNull();
        expect(await res.text()).toBe(RANGED_BODY);
    });

    test('a part with no Content-Type header is served as application/octet-stream', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(9, 'typeless.bin'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(await res.text()).toBe('no type here');
    });

    test('a negative index is refused by the domain method, never dereferenced', async () => {
        const home = await getHome(ctx.alice.user.id);
        await expect(home.mail.messageGetAttachment(messageId, -1)).rejects.toThrow(/not found/);
    });

    test('a negative index is refused at the schema boundary on both routes', async () => {
        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(-1, 'page.html'));
        expect(download.status).toBe(422);
        const embed = await authedRequest(ctx.alice.user.sessionToken, embedUrl(-1, 'page.html'));
        expect(embed.status).toBe(422);
    });
    test('a text part previews as a plaintext body', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(5));
        const preview = await assertJson<TextPreviewResult>(res);
        expect(preview.mode).toBe('plaintext');
        expect(preview.body).toContain('<p>First line.</p>');
        expect(preview.body).toContain('Second paragraph.');
    });

    test('a markdown part previews as rendered markdown', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(6));
        const preview = await assertJson<TextPreviewResult>(res);
        expect(preview.mode).toBe('markdown');
        expect(preview.body).toContain('<h1>Title</h1>');
    });

    // A sender picks the content type, so a part wearing an eigen mime is still only its own bytes: it
    // renders as the mode its name deserves, and is labelled with that mode — never inside a document frame.
    test('a part wearing an eigen mime previews as the mode its bytes deserve', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(8));
        const preview = await assertJson<TextPreviewResult>(res);
        expect(preview.mode).toBe('plaintext');
        expect(preview.body).toContain('Plain text wearing a document mime.');
    });

    test('a .vcf part previews as its cards', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, vcardPreviewUrl(7));
        const preview = await assertJson<VCardPreview>(res);
        expect(preview.total).toBe(1);
        expect(preview.dropped).toBe(0);
        expect(preview.cards).toHaveLength(1);
        expect(preview.cards[0].contact.firstName).toBe('Ada');
        expect(preview.cards[0].contact.lastName).toBe('Lovelace');
    });

    // A sender names the part, so one named after a preview route still has to download as its own bytes:
    // the preview routes sit two segments past the index, where no single-segment name reaches them.
    test('a part named after the preview route downloads its own bytes', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(10, 'text-preview'));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(SHADOW_NAMED_BODY);
    });

    test('a part is decoded and served in the charset it declares', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(11));
        const preview = await assertJson<TextPreviewResult>(res);
        expect(preview.body).toContain(LATIN_BODY);

        const download = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(11, 'latin.txt'));
        expect(download.headers.get('content-type')).toBe('text/plain; charset=iso-8859-1');
    });

    test('a part no text mode covers has no text preview', async () => {
        const pdf = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(1));
        expect(pdf.status).toBe(404);
        // A .vcf reads as cards, never as raw text — the same gate the Drive route runs.
        const vcf = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(7));
        expect(vcf.status).toBe(404);
    });

    test('an out-of-range part carries no preview caching headers with its 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(12));
        expect(res.status).toBe(404);
        expect(res.headers.get('etag')).toBeNull();
        expect(res.headers.get('cache-control')).toBeNull();
    });

    test('a part that is not a vCard is refused by the vcard preview', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, vcardPreviewUrl(5));
        expect(res.status).toBe(400);
    });

    test('the preview routes revalidate on every use and answer If-None-Match with 304', async () => {
        const first = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(5));
        expect(first.headers.get('cache-control')).toBe('private, no-cache');
        const etag = first.headers.get('etag') ?? '';
        expect(etag).not.toBe('');

        const revalidated = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(5), {
            headers: { 'if-none-match': etag },
        });
        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.get('etag')).toBe(etag);

        const cards = await authedRequest(ctx.alice.user.sessionToken, vcardPreviewUrl(7));
        const cardsEtag = cards.headers.get('etag') ?? '';
        const cardsRevalidated = await authedRequest(ctx.alice.user.sessionToken, vcardPreviewUrl(7), {
            headers: { 'if-none-match': cardsEtag },
        });
        expect(cardsRevalidated.status).toBe(304);
    });

    // The renderer's format tag rides in the ETag, so a renderer fix is not answered with a 304 on a part
    // whose own bytes never changed — the same rule the .eml preview follows.
    test('a text preview carries a different ETag than the bytes of the same part', async () => {
        const preview = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(5));
        const bytes = await authedRequest(ctx.alice.user.sessionToken, downloadUrl(5, 'notes.txt'));

        expect(preview.headers.get('etag')).not.toBe(bytes.headers.get('etag'));
        const stale = await authedRequest(ctx.alice.user.sessionToken, textPreviewUrl(5), {
            headers: { 'if-none-match': bytes.headers.get('etag') ?? '' },
        });
        expect(stale.status).toBe(200);
    });

    test("another user's message is refused with 403 on both preview routes", async () => {
        const text = await authedRequest(ctx.bob.user.sessionToken, textPreviewUrl(5));
        expect(text.status).toBe(403);
        const vcard = await authedRequest(ctx.bob.user.sessionToken, vcardPreviewUrl(7));
        expect(vcard.status).toBe(403);
    });

    test('a text part past the preview ceiling has no preview', async () => {
        const boundary = 'att-oversize-text';
        const line = 'x'.repeat(TEXT_PREVIEW_MAX_BYTES / 8).concat('\r\n');
        const eml = [
            'From: sender@external.com',
            `To: ${ctx.alice.user.email}`,
            `Subject: ${OVERSIZE_TEXT_SUBJECT}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            'Content-Disposition: attachment; filename="huge.txt"',
            '',
            line.repeat(9),
            `--${boundary}--`,
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        expect(deliverRes.status).toBe(200);

        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);
        const list = await assertJson<EmailSummary[]>(listRes);
        const bigId = findOrFail(list, (m) => m.subject === OVERSIZE_TEXT_SUBJECT).id;

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${bigId}/attachment/0/preview/text`,
        );
        expect(res.status).toBe(404);
    });

    // A forwarded message rides along as a message/rfc822 part, which is a part with its own bytes: it
    // previews as the message it holds, through the renderer the Drive route ends in.
    describe('an attached message', () => {
        let attachedId: string;
        const emlPreviewUrl = (index: number): string =>
            `/mail/${ctx.alice.user.id}/message/${attachedId}/attachment/${index}/preview/eml`;

        beforeAll(async () => {
            const boundary = 'att-message';
            const forwarded = [
                'From: Ada Lovelace <ada@external.com>',
                'To: alice@example.com',
                'Subject: Engine notes',
                'Date: Tue, 15 Aug 2026 10:30:00 +0000',
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=utf-8',
                '',
                '<p>The engine <img src="https://tracker.example/pixel.png"> weaves patterns.</p>',
            ].join('\r\n');
            const eml = [
                'From: sender@external.com',
                `To: ${ctx.alice.user.email}`,
                `Subject: ${ATTACHED_SUBJECT}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                '',
                'Forwarding this.',
                `--${boundary}`,
                `Content-Type: ${EML_MIME}`,
                'Content-Disposition: attachment; filename="forwarded.eml"',
                '',
                forwarded,
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                'Content-Disposition: attachment; filename="note.txt"',
                '',
                'Not a message.',
                `--${boundary}--`,
            ].join('\r\n');

            const deliverRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/deliver/${ctx.alice.user.email}`,
                { method: 'POST', body: new TextEncoder().encode(eml).buffer },
            );
            expect(deliverRes.status).toBe(200);

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/inbox`,
            );
            const list = await assertJson<EmailSummary[]>(listRes);
            attachedId = findOrFail(list, (m) => m.subject === ATTACHED_SUBJECT).id;
        });

        test('previews as the message it holds, with a body that fetches nothing', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(0));
            const preview = await assertJson<EmlPreview>(res);

            expect(preview.subject).toBe('Engine notes');
            expect(preview.from?.value[0]?.address).toBe('ada@external.com');
            expect(preview.date).toBe('2026-08-15T10:30:00.000Z');
            expect(preview.html).toContain('weaves patterns');
            expect(preview.html).not.toContain('tracker.example');
        });

        test('revalidates on every use and answers If-None-Match with 304', async () => {
            const first = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(0));
            expect(first.headers.get('cache-control')).toBe('private, no-cache');
            const etag = first.headers.get('etag') ?? '';
            expect(etag).not.toBe('');

            const revalidated = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(0), {
                headers: { 'if-none-match': etag },
            });
            expect(revalidated.status).toBe(304);
            expect(revalidated.headers.get('etag')).toBe(etag);
        });

        // The renderer's format tag rides in the ETag, so a sanitizer or payload fix is not answered with
        // a 304 on a message whose own bytes never changed.
        test('carries a different ETag than the bytes of the same part', async () => {
            const preview = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(0));
            const bytes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${attachedId}/attachment/0/forwarded.eml`,
            );

            expect(preview.headers.get('etag')).not.toBe(bytes.headers.get('etag'));
            const stale = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(0), {
                headers: { 'if-none-match': bytes.headers.get('etag') ?? '' },
            });
            expect(stale.status).toBe(200);
        });

        test('a part that is not a message is refused by the eml preview', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, emlPreviewUrl(1));
            expect(res.status).toBe(400);
        });

        test("another user's message is refused with 403", async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, emlPreviewUrl(0));
            expect(res.status).toBe(403);
        });
    });

    // An invitation rides along as a text/calendar part, which the reader draws as its own widget: it
    // previews as the events it holds, through the renderer the Drive route ends in.
    describe('a calendar part', () => {
        let inviteId: string;
        const icsPreviewUrl = (index: number): string =>
            `/mail/${ctx.alice.user.id}/message/${inviteId}/attachment/${index}/preview/ics`;

        beforeAll(async () => {
            const boundary = 'att-invite';
            const invite = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'METHOD:REQUEST',
                'BEGIN:VEVENT',
                'UID:invite@external.com',
                'DTSTART:20260420T140000Z',
                'DTEND:20260420T150000Z',
                'SUMMARY:Design review',
                'ORGANIZER;CN=Ada Lovelace:mailto:ada@external.com',
                'ATTACH:https://tracker.example/agenda.pdf',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n');
            const eml = [
                'From: sender@external.com',
                `To: ${ctx.alice.user.email}`,
                `Subject: ${INVITE_SUBJECT}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                '',
                'Please join.',
                `--${boundary}`,
                // A sender names the part's purpose in the type's parameters and gives it no filename at
                // all, so the mime is everything the route's guard has to go on.
                `Content-Type: ${ICS_MIME}; method=REQUEST; charset=utf-8`,
                '',
                invite,
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                'Content-Disposition: attachment; filename="note.txt"',
                '',
                'Not a calendar.',
                `--${boundary}--`,
            ].join('\r\n');

            const deliverRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/deliver/${ctx.alice.user.email}`,
                { method: 'POST', body: new TextEncoder().encode(eml).buffer },
            );
            expect(deliverRes.status).toBe(200);

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/inbox`,
            );
            const list = await assertJson<EmailSummary[]>(listRes);
            inviteId = findOrFail(list, (m) => m.subject === INVITE_SUBJECT).id;
        });

        test('previews as the events it holds, with nothing the file points at', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(0));
            const preview = await assertJson<IcsPreview>(res);

            expect(preview.method).toBe('REQUEST');
            expect(preview.total).toBe(1);
            expect(preview.events[0]?.title).toBe('Design review');
            expect(preview.events[0]?.start).toBe('2026-04-20T14:00:00.000Z');
            expect(preview.events[0]?.organizer?.email).toBe('ada@external.com');
            expect(JSON.stringify(preview)).not.toContain('tracker.example');
        });

        test('revalidates on every use and answers If-None-Match with 304', async () => {
            const first = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(0));
            expect(first.headers.get('cache-control')).toBe('private, no-cache');
            const etag = first.headers.get('etag') ?? '';
            expect(etag).not.toBe('');

            const revalidated = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(0), {
                headers: { 'if-none-match': etag },
            });
            expect(revalidated.status).toBe(304);
            expect(revalidated.headers.get('etag')).toBe(etag);
        });

        // The renderer's format tag rides in the ETag, so a payload fix is not answered with a 304 on a
        // message whose own bytes never changed.
        test('carries a different ETag than the bytes of the same part', async () => {
            const preview = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(0));
            const bytes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${inviteId}/attachment/0/attachment-1`,
            );

            expect(preview.headers.get('etag')).not.toBe(bytes.headers.get('etag'));
            const stale = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(0), {
                headers: { 'if-none-match': bytes.headers.get('etag') ?? '' },
            });
            expect(stale.status).toBe(200);
        });

        test('a part that is not a calendar is refused by the ics preview', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, icsPreviewUrl(1));
            expect(res.status).toBe(400);
        });

        test("another user's message is refused with 403", async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, icsPreviewUrl(0));
            expect(res.status).toBe(403);
        });
    });

    test('a calendar part past the preview ceiling is refused with 413', async () => {
        const boundary = 'att-oversize-ics';
        const filler = 'DESCRIPTION:'.concat('x'.repeat(ICS_MAX_BYTES / 8), '\r\n');
        const bigCalendar = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:huge@eigen',
            'DTSTART:20260420T140000Z',
            filler.repeat(9),
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const eml = [
            'From: sender@external.com',
            `To: ${ctx.alice.user.email}`,
            `Subject: ${OVERSIZE_ICS_SUBJECT}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            `Content-Type: ${ICS_MIME}; charset=utf-8`,
            'Content-Disposition: attachment; filename="huge.ics"',
            '',
            bigCalendar,
            `--${boundary}--`,
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        expect(deliverRes.status).toBe(200);

        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);
        const list = await assertJson<EmailSummary[]>(listRes);
        const bigId = findOrFail(list, (m) => m.subject === OVERSIZE_ICS_SUBJECT).id;

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${bigId}/attachment/0/preview/ics`,
        );
        expect(res.status).toBe(413);
    });

    test('a vCard part past the import ceiling is refused with 413', async () => {
        const boundary = 'att-oversize';
        const filler = 'NOTE:'.concat('x'.repeat(IMPORT_MAX_BYTES / 8), '\r\n');
        const bigCard = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Too Big', filler.repeat(9), 'END:VCARD'].join('\r\n');
        const eml = [
            'From: sender@external.com',
            `To: ${ctx.alice.user.email}`,
            `Subject: ${OVERSIZE_SUBJECT}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/vcard; charset=utf-8',
            'Content-Disposition: attachment; filename="huge.vcf"',
            '',
            bigCard,
            `--${boundary}--`,
        ].join('\r\n');

        const deliverRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${ctx.alice.user.email}`, {
            method: 'POST',
            body: new TextEncoder().encode(eml).buffer,
        });
        expect(deliverRes.status).toBe(200);

        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);
        const list = await assertJson<EmailSummary[]>(listRes);
        const bigId = findOrFail(list, (m) => m.subject === OVERSIZE_SUBJECT).id;

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${bigId}/attachment/0/preview/vcard`,
        );
        expect(res.status).toBe(413);
    });
});
