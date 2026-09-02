// Golden contract for the mail parser: parses every .eml in fixtures/mail-corpus and pins a
// consumed-field projection (attachment bytes as SHA-256) against a committed .golden.json, so a
// parser rewrite can be verified behaviour-identical. Regenerate the goldens with UPDATE_GOLDEN=1.

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedMail } from '@workspace/lib/types/mail';
import { parseMail } from '../../lib/mail/mail-parser';

const CORPUS_DIR = join(import.meta.dir, '../fixtures/mail-corpus');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

function projectAttachment(att: ParsedMail['attachments'][number]): unknown {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(att.content);
    return {
        contentType: att.contentType,
        filename: att.filename,
        calendarMethod: att.calendarMethod,
        sha256: hasher.digest('hex'),
        size: att.size,
    };
}

function project(mail: ParsedMail): unknown {
    return {
        subject: mail.subject,
        date: mail.date ? mail.date.toISOString() : null,
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        replyTo: mail.replyTo,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        references: mail.references,
        text: mail.text,
        html: mail.html,
        textAsHtml: mail.textAsHtml,
        attachments: mail.attachments.map(projectAttachment),
    };
}

const emls = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.eml'))
    .sort();

for (const name of emls) {
    test(name, () => {
        const mail = parseMail(readFileSync(join(CORPUS_DIR, name)));
        const goldenPath = join(CORPUS_DIR, name.replace(/\.eml$/, '.golden.json'));
        if (UPDATE) {
            writeFileSync(goldenPath, `${JSON.stringify(project(mail), null, 2)}\n`);
            return;
        }
        const projection = JSON.parse(JSON.stringify(project(mail)));
        const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
        expect(projection).toEqual(golden);
    });
}

test('unparseable Date header falls back to ~now', () => {
    const eml = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Bad date',
        'Date: not a real date at all',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body.',
    ].join('\r\n');
    const mail = parseMail(Buffer.from(eml));
    expect(mail.date).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (mail.date?.getTime() ?? 0))).toBeLessThan(5000);
});
