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

// The index, the sync and the part routes read summary fields and attachments, never a body. Handing them
// no html at all is what makes "forgot to sanitize" impossible: there is nothing to forget.
describe('parseEmlBytes', () => {
    test('a message with a body carries no html out of the parse', async () => {
        const bytes = eml('<p>Hi</p><script>alert(1)</script>');
        const mail = await parseEmlBytes('m1', 'INBOX', bytes, bytes.length);

        expect(mail.html).toBeNull();
        expect(mail.subject).toBe('t');
        expect(mail.text).toContain('Hi');
    });
});
