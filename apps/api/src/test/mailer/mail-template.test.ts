import { describe, expect, test } from 'bun:test';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { buildAttachmentUrl, renderEigenEmail } from '../../lib/mailer/mail-template';

describe('renderEigenEmail', () => {
    test('renders title in an h2', () => {
        const html = renderEigenEmail({ title: 'Hello', bodyHtml: '<p>body</p>' });
        expect(html).toContain('<h2');
        expect(html).toContain('Hello');
        expect(html).toContain('<p>body</p>');
    });

    test('escapes title', () => {
        const html = renderEigenEmail({ title: '<script>x</script>', bodyHtml: '' });
        expect(html).not.toContain('<script>x</script>');
        expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    test('emits banner when present', () => {
        const html = renderEigenEmail({ title: 'T', bodyHtml: '', banner: 'Updated' });
        expect(html).toContain('Updated');
        expect(html).toMatch(/background:\s*#fce8e6/);
    });

    test('omits banner when absent', () => {
        const html = renderEigenEmail({ title: 'T', bodyHtml: '' });
        expect(html).not.toMatch(/background:\s*#fce8e6/);
    });

    test('emits attachment pills when present', () => {
        const html = renderEigenEmail({
            title: 'T',
            bodyHtml: '',
            links: [{ name: 'doc', href: 'http://localhost:3006/docs/doc/u1/m1/p1' }],
        });
        expect(html).toContain('Open doc →');
        expect(html).toMatch(/svg/i); // paperclip
        expect(html).toContain('target="_blank"'); // open eigen doc in a new tab
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test('emits footer line when present', () => {
        const html = renderEigenEmail({ title: 'T', bodyHtml: '', footerLine: 'From Alice' });
        expect(html).toContain('From Alice');
    });

    test('autolinks bare http(s) URLs in body so admin plaintext templates render clickable', () => {
        const html = renderEigenEmail({
            title: 'T',
            bodyHtml: 'Click https://eigen.is/space/signup?token=abc to continue',
        });
        expect(html).toContain('<a href="https://eigen.is/space/signup?token=abc"');
        expect(html).toMatch(/>https:\/\/eigen\.is\/space\/signup\?token=abc<\/a>/);
    });

    test('does not double-wrap URLs that already sit inside an anchor', () => {
        const html = renderEigenEmail({
            title: 'T',
            bodyHtml: '<a href="https://eigen.is">https://eigen.is</a>',
        });
        // The anchor tag should appear exactly once — no nested <a><a>...</a></a>.
        expect(html.match(/<a\s/g)?.length).toBe(1);
    });
});

describe('buildAttachmentUrl', () => {
    const ownerId = '7OEwianTfhULu6iG8wQz4G2dO5G2w0B4';
    const id = '3f2c9c1e-7a10-4b1f-9d7e-2a1c0b9e8f7a';
    const ref = (driveType: AttachmentReference['driveType']): AttachmentReference => ({
        type: 'reference',
        ownerId,
        mountId: 'default',
        id,
        name: 'x',
        driveType,
        mimeType: 'x/y',
    });

    test('names the owner, mount and id in the app that opens the document', () => {
        const path = `${ownerId}/default/${id}`;
        expect(buildAttachmentUrl(ref('doc'))).toEndWith(`/docs/doc/${path}`);
        expect(buildAttachmentUrl(ref('stickies'))).toEndWith(`/stickies/board/${path}`);
        expect(buildAttachmentUrl(ref('slides'))).toEndWith(`/slides/slide/${path}`);
        expect(buildAttachmentUrl(ref('sheets'))).toEndWith(`/sheets/sheet/${path}`);
        expect(buildAttachmentUrl(ref('vector'))).toEndWith(`/vector/vector/${path}`);
        expect(buildAttachmentUrl(ref('chat'))).toEndWith(`/chat/${path}`);
        expect(buildAttachmentUrl(ref('folder'))).toEndWith(`/drive/fs/${path}`);
    });
});
