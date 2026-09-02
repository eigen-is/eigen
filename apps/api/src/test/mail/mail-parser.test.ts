import { describe, expect, test } from 'bun:test';
import { parseMail } from '../../lib/mail/mail-parser';

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
    describe('parseMail', () => {
        test('parses plain text email', () => {
            const mail = parseMail(Buffer.from(PLAIN_EMAIL));

            expect(mail.subject).toBe('Test Subject');
            expect(mail.text).toContain('Hello, this is a test email body.');
            expect(mail.from?.value[0].address).toBe('sender@example.com');
            expect(mail.to).toBeDefined();
        });

        test('parses HTML email', () => {
            const mail = parseMail(Buffer.from(HTML_EMAIL));

            expect(mail.subject).toBe('HTML Test');
            expect(mail.html).toContain('<p>Hello <b>World</b></p>');
        });

        test('parses multipart email with attachment', () => {
            const mail = parseMail(Buffer.from(MULTIPART_EMAIL));

            expect(mail.subject).toBe('Multipart Test');
            expect(mail.text).toContain('This is the text part.');
            expect(mail.attachments).toHaveLength(1);

            const att = mail.attachments[0];
            expect(att.filename).toBe('test.bin');
            expect(att.contentType).toBe('application/octet-stream');
            expect(Buffer.from(att.content).toString()).toBe('binary file content');
        });

        test('parses multiple recipients', () => {
            const mail = parseMail(Buffer.from(MULTI_RECIPIENT_EMAIL));

            expect(mail.subject).toBe('Group Email');
            const toAddresses = Array.isArray(mail.to) ? mail.to.flatMap((a) => a.value) : (mail.to?.value ?? []);
            expect(toAddresses).toHaveLength(2);
            expect(toAddresses[0].address).toBe('alice@example.com');
            expect(toAddresses[1].address).toBe('bob@example.com');

            const ccAddresses = Array.isArray(mail.cc) ? mail.cc.flatMap((a) => a.value) : (mail.cc?.value ?? []);
            expect(ccAddresses).toHaveLength(1);
            expect(ccAddresses[0].address).toBe('charlie@example.com');
        });

        test('parses date header', () => {
            const mail = parseMail(Buffer.from(PLAIN_EMAIL));
            expect(mail.date).toBeInstanceOf(Date);
            expect(mail.date?.getFullYear()).toBe(2024);
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

test('parses calendarMethod from text/calendar attachment', () => {
    const mail = parseMail(Buffer.from(CALENDAR_EMAIL));

    const calAtt = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    expect(calAtt?.calendarMethod).toBe('REQUEST');
});

test('non-calendar attachments have no calendarMethod', () => {
    const mail = parseMail(Buffer.from(MULTIPART_EMAIL));
    expect(mail.attachments[0].calendarMethod).toBeUndefined();
});

// #14 — a boundary line may carry a lone leading CR (raw `\n\r--boundary`): it is a 1-byte prefix, not
// half a CRLF. Over-advancing past it missed a valid boundary → mis-split multipart (attachment absorbed
// into text, raw MIME leaked).
describe('#14 boundary line with a bare-CR prefix', () => {
    test('a lone leading CR still delimits the part', () => {
        const bytes = Buffer.from(
            'Content-Type: multipart/mixed; boundary="boundary123"\r\n' +
                '\r\n' +
                '--boundary123\r\n' +
                'Content-Type: text/plain\r\n' +
                '\r\n' +
                'first' +
                '\n\r--boundary123\r\n' +
                'Content-Type: text/plain\r\n' +
                '\r\n' +
                'second\r\n' +
                '--boundary123--\r\n',
            'binary',
        );
        expect(parseMail(bytes).text).toBe('first\nsecond');
    });

    test('bare-CR separator before the 2nd boundary keeps the attachment (end-to-end)', () => {
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
        const mail = parseMail(bytes);

        expect(mail.attachments).toHaveLength(1);
        const attachment = mail.attachments[0];
        expect(attachment.filename).toBe('test.bin');
        expect(Buffer.from(attachment.content).toString()).toBe('binary file content');
        expect(mail.text ?? '').toContain('This is the text part.');
        expect(mail.text ?? '').not.toContain('octet-stream');
    });
});

// #11 — htmlToText runs synchronously (~70-90 ms/MB) on the shared event loop for every mail
// open + sync. A crafted multi-MB HTML body is a DoS lever. The fix truncates the htmlToText
// input to a fixed cap: the rendered html stays whole (email readable), the derived text is
// bounded. Wiring maxHtmlLengthToParse instead would reject the whole parse (footgun).
describe('#11 htmlToText DoS cap', () => {
    test('multi-MB single-line HTML body still parses; derived text is bounded', () => {
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
        const mail = parseMail(bytes);

        // Not rejected — the whole email stays readable (the maxHtmlLengthToParse footgun would 500).
        expect(mail.html).toBeTruthy();
        // Derived text bounded by the ~2 MB cap (≈ 6 MB and unbounded before the fix).
        expect((mail.text ?? '').length).toBeLessThan(3 * 1024 * 1024);
    });
});
