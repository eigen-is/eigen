import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_DATA_DIR } from './setup';

// One spelling of the mail layout for every mail test that reaches past the API and touches the files
// (the precedent is contacts-test-helpers.ts and its cardsDirOf/avatarsDirOf).
export const mailRootOf = (userId: string) => join(TEST_DATA_DIR, 'home', userId, 'eigen.mail');
export const maildirOf = (userId: string) => join(mailRootOf(userId), 'Maildir');

// The inbox is the Maildir root itself; every other mailbox is a Maildir++ `.Name` directory beside it.
export const boxDir = (userId: string, mailbox: string) =>
    mailbox === '' ? maildirOf(userId) : join(maildirOf(userId), `.${mailbox}`);

export function makeEml(subject: string, opts: { from?: string; to?: string; body?: string } = {}): string {
    return [
        `From: ${opts.from ?? 'sender@example.com'}`,
        `To: ${opts.to ?? 'recipient@test.eigen.is'}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${Math.random()}@test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        opts.body ?? `Body of ${subject}`,
    ].join('\r\n');
}

// A file straight into a mailbox, the way another MDA or a bulk drop leaves one: a `new/` entry carries no
// flag suffix at all, a `cur/` entry carries `:2,<flags>`. Returns the path it wrote.
export function seedMaildirFile(
    userId: string,
    mailbox: string,
    uniqueId: string,
    eml: string,
    opts: { dir?: 'cur' | 'new'; flags?: string } = {},
): string {
    const dir = opts.dir ?? 'cur';
    const size = Buffer.byteLength(eml, 'utf-8');
    const name = dir === 'new' ? `${uniqueId},S=${size}` : `${uniqueId},S=${size}:2,${opts.flags ?? 'S'}`;
    const filePath = join(boxDir(userId, mailbox), dir, name);
    writeFileSync(filePath, eml);
    return filePath;
}
