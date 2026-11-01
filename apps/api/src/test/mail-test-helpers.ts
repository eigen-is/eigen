import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SSEventType } from '@workspace/lib/types/sse';
import { maildirFolder } from '../lib/mail/mailutils';
import type { SSECollector } from './setup';
import { TEST_DATA_DIR } from './setup';

// One spelling of the mail layout for every mail test that reaches past the API and touches the files
// (the precedent is contacts-test-helpers.ts and its cardsDirOf/avatarsDirOf).
export const mailRootOf = (userId: string) => join(TEST_DATA_DIR, 'home', userId, 'eigen.mail');
export const maildirOf = (userId: string) => join(mailRootOf(userId), 'Maildir');
export const boxDir = (userId: string, mailbox: string) => maildirFolder(maildirOf(userId), mailbox);

// CI's per-test budget, for a test that waits on a folder watcher. Under load on macOS an fs.watch event
// arrives seconds late, and each watcher blocks the event loop while it attaches: twelve can pass bun's 5 s default.
export const WATCHER_TEST_TIMEOUT_MS = 30_000;
// How often fileUntilIndexed files another message while it waits. The test's own timeout bounds the wait.
const REFILE_INTERVAL_MS = 500;

// Fabricates a Maildir++ folder the way Dovecot does: a dot-prefixed directory with cur/new/tmp and
// the `maildirfolder` marker. Eigen itself makes no folder but the standard six.
export function seedMaildirFolder(userId: string, mailbox: string): void {
    const folder = boxDir(userId, mailbox);
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(folder, sub), { recursive: true });
    writeFileSync(join(folder, 'maildirfolder'), '');
}

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

// Files a message into a mailbox's new/ until the open tab hears it indexed, filing another when an event got lost.
// On macOS an fs.watch event comes seconds late under load, and each watcher attached or closed rebuilds the
// process's one FSEvents stream, which drops an event still queued. The wait matches the message's id, because
// next() also matches an event the tab heard before, such as a delivery into the same mailbox. The sync that
// indexes the newest message moves every older one too, so none is left in new/ for a later sync to move.
export async function fileUntilIndexed(tab: SSECollector, userId: string, mailbox: string): Promise<void> {
    let indexed: Promise<boolean>;
    do {
        const id = `${Date.now()}.filed`;
        seedMaildirFile(userId, mailbox, id, makeEml(`Filed into ${mailbox}`), { dir: 'new' });
        indexed = tab
            .next((event) => event.type === SSEventType.MAIL_RECEIVED && event.mail.messageId === id)
            .then(() => true);
    } while (!(await Promise.race([indexed, Bun.sleep(REFILE_INTERVAL_MS).then(() => false)])));
}
