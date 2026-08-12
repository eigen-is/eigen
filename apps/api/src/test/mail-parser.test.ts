import { describe, expect, test } from 'bun:test';
import { simpleParser } from '../lib/mail/mail-parser';
import Splitter from '../lib/mail/mail-split/message-splitter';

const PLAIN_EMAIL = [
    'From: sender@example.com',
    'To: recipient@example.com',
    'Subject: Test Subject',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello, this is a test email body.',
].join('\r\n');

const HTML_EMAIL = [
    'From: sender@example.com',
    'To: recipient@example.com',
    'Subject: HTML Test',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>Hello <b>World</b></p></body></html>',
].join('\r\n');

const MULTIPART_EMAIL = [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Multipart Test',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="boundary123"',
    '',
    '--boundary123',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is the text part.',
    '--boundary123',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="test.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('binary file content').toString('base64'),
    '--boundary123--',
].join('\r\n');

const PRIORITY_EMAIL = [
    'From: urgent@example.com',
    'To: recipient@example.com',
    'Subject: Urgent Message',
    'X-Priority: 1',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'Content-Type: text/plain',
    '',
    'This is urgent.',
].join('\r\n');

const MULTI_RECIPIENT_EMAIL = [
    'From: sender@example.com',
    'To: alice@example.com, bob@example.com',
    'Cc: charlie@example.com',
    'Subject: Group Email',
    'Date: Mon, 01 Jan 2024 12:00:00 +0000',
    'Content-Type: text/plain',
    '',
    'Hello group.',
].join('\r\n');

describe('Mail Parser', () => {
    describe('simpleParser', () => {
        test('parses plain text email', async () => {
            const mail = await simpleParser(PLAIN_EMAIL);

            expect(mail.subject).toBe('Test Subject');
            expect(mail.text).toContain('Hello, this is a test email body.');
            expect(mail.from?.value[0].address).toBe('sender@example.com');
            expect(mail.to).toBeDefined();
        });

        test('parses HTML email', async () => {
            const mail = await simpleParser(HTML_EMAIL);

            expect(mail.subject).toBe('HTML Test');
            expect(mail.html).toContain('<p>Hello <b>World</b></p>');
        });

        test('parses multipart email with attachment', async () => {
            const mail = await simpleParser(MULTIPART_EMAIL);

            expect(mail.subject).toBe('Multipart Test');
            expect(mail.text).toContain('This is the text part.');
            expect(mail.attachments).toHaveLength(1);

            const att = mail.attachments[0];
            expect(att.filename).toBe('test.bin');
            expect(att.contentType).toBe('application/octet-stream');
            if (!Buffer.isBuffer(att.content)) throw new Error('attachment content is not a Buffer');
            expect(att.content.toString()).toBe('binary file content');
        });

        test('parses email priority', async () => {
            const mail = await simpleParser(PRIORITY_EMAIL);

            expect(mail.headers.get('priority')).toBe('high');
        });

        test('parses multiple recipients', async () => {
            const mail = await simpleParser(MULTI_RECIPIENT_EMAIL);

            expect(mail.subject).toBe('Group Email');
            const toAddresses = Array.isArray(mail.to) ? mail.to.flatMap((a) => a.value) : (mail.to?.value ?? []);
            expect(toAddresses).toHaveLength(2);
            expect(toAddresses[0].address).toBe('alice@example.com');
            expect(toAddresses[1].address).toBe('bob@example.com');

            const ccAddresses = Array.isArray(mail.cc) ? mail.cc.flatMap((a) => a.value) : (mail.cc?.value ?? []);
            expect(ccAddresses).toHaveLength(1);
            expect(ccAddresses[0].address).toBe('charlie@example.com');
        });

        test('accepts Buffer input', async () => {
            const mail = await simpleParser(Buffer.from(PLAIN_EMAIL));
            expect(mail.subject).toBe('Test Subject');
        });

        test('throws on null input', () => {
            expect(() => simpleParser(null as unknown as string)).toThrow('Input cannot be null or undefined');
        });

        test('parses date header', async () => {
            const mail = await simpleParser(PLAIN_EMAIL);
            expect(mail.date).toBeInstanceOf(Date);
            expect(mail.date!.getFullYear()).toBe(2024);
        });

        test('headers map is populated', async () => {
            const mail = await simpleParser(PLAIN_EMAIL);
            expect(mail.headers).toBeInstanceOf(Map);
            expect(mail.headers.has('subject')).toBe(true);
            expect(mail.headers.has('from')).toBe(true);
            expect(mail.headers.has('content-type')).toBe(true);
        });

        test('attachment has checksum and size', async () => {
            const mail = await simpleParser(MULTIPART_EMAIL);
            const att = mail.attachments[0];
            expect(att.checksum).toBeTruthy();
            expect(att.size).toBeGreaterThan(0);
        });

        test('callback style works', (done) => {
            simpleParser(PLAIN_EMAIL, (err, mail) => {
                expect(err).toBeNull();
                expect(mail.subject).toBe('Test Subject');
                done();
            });
        });
    });
});

const CALENDAR_EMAIL = [
    'From: organizer@example.com',
    'To: attendee@example.com',
    'Subject: Invitation: Meeting',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="cal-boundary"',
    '',
    '--cal-boundary',
    'Content-Type: text/plain',
    '',
    'You are invited to a meeting.',
    '--cal-boundary',
    'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:test@example.com',
    'SUMMARY:Meeting',
    'DTSTART:20260415T100000Z',
    'DTEND:20260415T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
    '--cal-boundary--',
].join('\r\n');

test('parses calendarMethod from text/calendar attachment', async () => {
    const mail = await simpleParser(CALENDAR_EMAIL);

    const calAtt = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    expect(calAtt?.calendarMethod).toBe('REQUEST');
});

test('non-calendar attachments have no calendarMethod', async () => {
    const mail = await simpleParser(MULTIPART_EMAIL);
    expect(mail.attachments[0].calendarMethod).toBeUndefined();
});

// #14 — checkBoundary must skip a 2-byte leading prefix only for a real CRLF. The old `||`
// test over-advanced startpos on a lone leading CR, then failed the `--` guard and missed a
// valid boundary → mis-split multipart (attachment absorbed into text, raw MIME leaked).
describe('#14 checkBoundary bare-CR', () => {
    test('recognizes a boundary line with a lone leading CR (\\r--boundary)', () => {
        const s = new Splitter() as unknown as {
            node: { _boundary: Buffer };
            checkBoundary(line: Buffer): number | false;
        };
        s.node._boundary = Buffer.from('boundary123');
        expect(s.checkBoundary(Buffer.from('\r--boundary123\r\n', 'binary'))).toBe(1);
    });

    test('bare-CR separator before the 2nd boundary keeps the attachment (end-to-end)', async () => {
        const att = Buffer.from('binary file content').toString('base64');
        const bytes = Buffer.from(
            'From: Alice <alice@example.com>\r\n' +
                'To: Bob <bob@example.com>\r\n' +
                'Subject: Multipart Test\r\n' +
                'MIME-Version: 1.0\r\n' +
                'Content-Type: multipart/mixed; boundary="boundary123"\r\n' +
                '\r\n' +
                '--boundary123\r\n' +
                'Content-Type: text/plain; charset=utf-8\r\n' +
                '\r\n' +
                'This is the text part.' +
                // Bare CR before the 2nd boundary (raw ...\n\r--boundary...): the mis-split trigger.
                '\n\r' +
                '--boundary123\r\n' +
                'Content-Type: application/octet-stream\r\n' +
                'Content-Disposition: attachment; filename="test.bin"\r\n' +
                'Content-Transfer-Encoding: base64\r\n' +
                '\r\n' +
                `${att}\r\n` +
                '--boundary123--\r\n',
            'binary',
        );
        const mail = await simpleParser(bytes);

        expect(mail.attachments).toHaveLength(1);
        const att = mail.attachments[0];
        expect(att.filename).toBe('test.bin');
        if (!Buffer.isBuffer(att.content)) throw new Error('attachment content is not a Buffer');
        expect(att.content.toString()).toBe('binary file content');
        expect(mail.text ?? '').toContain('This is the text part.');
        expect(mail.text ?? '').not.toContain('octet-stream');
    });
});

// #11 — htmlToText runs synchronously (~70-90 ms/MB) on the shared event loop for every mail
// open + sync. A crafted multi-MB HTML body is a DoS lever. The fix truncates the htmlToText
// input to a fixed cap: the rendered html stays whole (email readable), the derived text is
// bounded. Wiring maxHtmlLengthToParse instead would reject the whole parse (footgun).
describe('#11 htmlToText DoS cap', () => {
    test('multi-MB single-line HTML body still parses; derived text is bounded', async () => {
        const huge = 'A'.repeat(6 * 1024 * 1024);
        const bytes = Buffer.from(
            'From: sender@example.com\r\n' +
                'Subject: Huge HTML\r\n' +
                'MIME-Version: 1.0\r\n' +
                'Content-Type: text/html; charset=utf-8\r\n' +
                '\r\n' +
                `<div>${huge}</div>`,
            'binary',
        );
        const mail = await simpleParser(bytes);

        // Not rejected — the whole email stays readable (the maxHtmlLengthToParse footgun would 500).
        expect(mail.html).toBeTruthy();
        // Derived text bounded by the ~2 MB cap (≈ 6 MB and unbounded before the fix).
        expect((mail.text ?? '').length).toBeLessThan(3 * 1024 * 1024);
    });
});
