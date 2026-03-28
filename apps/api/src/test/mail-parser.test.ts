import { describe, expect, test } from 'bun:test';
import { simpleParser } from '../lib/mail/mail-parser';

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
            expect(att.content).toBeInstanceOf(Buffer);
            expect(att.content.toString()).toBe('binary file content');
        });

        test('parses email priority', async () => {
            const mail = await simpleParser(PRIORITY_EMAIL);

            expect(mail.headers.get('priority')).toBe('high');
        });

        test('parses multiple recipients', async () => {
            const mail = await simpleParser(MULTI_RECIPIENT_EMAIL);

            expect(mail.subject).toBe('Group Email');
            const toAddresses = Array.isArray(mail.to)
                ? mail.to.flatMap((a) => a.value)
                : mail.to?.value ?? [];
            expect(toAddresses).toHaveLength(2);
            expect(toAddresses[0].address).toBe('alice@example.com');
            expect(toAddresses[1].address).toBe('bob@example.com');

            const ccAddresses = Array.isArray(mail.cc)
                ? mail.cc.flatMap((a) => a.value)
                : mail.cc?.value ?? [];
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
