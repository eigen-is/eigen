import { beforeAll, describe, expect, test } from 'bun:test';
import { getHome } from '../../lib/home';
import { createTestUser, ensureServer } from '../setup';

function makeEml(subject: string, body: string): Buffer {
    return Buffer.from(
        [
            'From: sender@example.com',
            'To: mailsize@test.eigen.is',
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${Date.now()}.${Math.random()}@test>`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
        ].join('\r\n'),
        'utf-8',
    );
}

// Mail usage is the index sum — SUM(emails.size) over mail.db (MaildirStore.size → MailDB.size), the
// one answer both the quota gate and the admin usage view read. An indexed message is charged by its
// own bytes, and a delete gives them back on the next read.
describe('Mail usage', () => {
    let userId: string;

    beforeAll(async () => {
        await ensureServer();
        const user = await createTestUser('mailsize@test.eigen.is', 'testpassword123', 'Mail Size');
        userId = user.id;
        // The welcome mail is appended with skipSync, so the index only learns about it on the first
        // sync — one list on the empty DB blocks on that, leaving the deltas below to these messages.
        const home = await getHome(userId);
        await home.mail.mailboxGet('');
    });

    test('a delivered message is counted by its own bytes', async () => {
        const home = await getHome(userId);
        const before = await home.mail.size();
        const message = makeEml('Mail size delivery', 'x'.repeat(4096));

        await home.mail.mailboxDeliver(message);

        expect(await home.mail.size()).toBe(before + message.byteLength);
    });

    test('a delete gives the bytes back', async () => {
        const home = await getHome(userId);
        const before = await home.mail.size();
        const message = makeEml('Mail size delete', 'y'.repeat(2048));

        const messageId = await home.mail.mailboxDeliver(message);
        expect(await home.mail.size()).toBe(before + message.byteLength);

        await home.mail.messageDelete(messageId);

        expect(await home.mail.size()).toBe(before);
    });
});
