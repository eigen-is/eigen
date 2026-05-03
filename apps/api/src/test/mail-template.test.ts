import { describe, expect, test } from 'bun:test';
import { renderEigenEmail } from '../lib/core/mail-template';

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
            attachmentLinks: [
                {
                    type: 'reference',
                    id: 'p1',
                    ownerId: 'u1',
                    mountId: 'm1',
                    name: 'doc.eigendoc',
                    driveType: 'doc',
                    mimeType: 'application/eigendoc',
                },
            ],
        });
        expect(html).toContain('doc'); // .eigendoc stripped
        expect(html).toMatch(/svg/i); // paperclip
    });

    test('emits footer line when present', () => {
        const html = renderEigenEmail({ title: 'T', bodyHtml: '', footerLine: 'From Alice' });
        expect(html).toContain('From Alice');
    });
});
