import { beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHome } from '../../lib/home';
import { createTestUser, ensureServer, TEST_DATA_DIR } from '../setup';

// A SUM over the message index misses two kinds of bytes that still occupy the quota: the welcome
// mail, delivered with skipSync so no sync ever indexed it, and the dovecot-uidlist / dovecot.index*
// files Dovecot writes inside every maildir folder. Walking the tree covers both.
describe('Mail usage', () => {
    let userId: string;

    beforeAll(async () => {
        await ensureServer();
        const user = await createTestUser('mailsize@test.eigen.is', 'testpassword123', 'Mail Size');
        userId = user.id;
    });

    test('counts the welcome mail the index never saw', async () => {
        const home = await getHome(userId);
        expect(await home.mail.size()).toBeGreaterThan(0);
    });

    test("counts Dovecot's own files inside the maildir", async () => {
        const home = await getHome(userId);
        const before = await home.mail.size();

        const uidlist = 'x'.repeat(4096);
        writeFileSync(join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'Maildir', 'dovecot-uidlist'), uidlist);

        expect(await home.mail.size()).toBe(before + uidlist.length);
    });
});
