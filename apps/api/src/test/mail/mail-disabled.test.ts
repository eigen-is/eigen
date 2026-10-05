import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAILBOX_INBOX } from '@workspace/lib/constants/mailboxes';
import type { SearchResponse } from '@workspace/lib/types/search';
import { PATHS } from '../../lib/core';
import { getHome } from '../../lib/home';
import { evictHome } from '../../lib/home/get-home';
import { readMailTotalSize } from '../../lib/mail/maildir-store';
import { restoreEnvAfterEach } from '../env-test-helpers';
import { makeEml } from '../mail-test-helpers';
import { app, assertJson, authedRequest, createTestUser, getTestContext } from '../setup';

// MAIL_ENABLED=0 hides Mail in every app; the API answers no mail route either, and a home builds no Maildir.
describe('Mail turned off on the server', () => {
    restoreEnvAfterEach(['MAIL_ENABLED']);

    beforeAll(async () => {
        await getTestContext();
    });

    test('every mail route refuses, and a home booted meanwhile has no Maildir and no mail hits', async () => {
        process.env['MAIL_ENABLED'] = '0';
        const user = await createTestUser(`mail-off-${randomUUID()}@test.eigen.is`, 'testpassword123', 'Mail Off');

        for (const route of ['mailboxes', 'mailbox/inbox', 'message/some-id']) {
            const res = await authedRequest(user.sessionToken, `/mail/${user.id}/${route}`);
            expect(res.status).toBe(403);
            expect(await res.text()).toBe('Mail is turned off on this server');
        }
        const deliver = await app.handle(
            new Request(`http://localhost/mail/deliver/${user.email}`, {
                method: 'POST',
                body: new TextEncoder().encode('Subject: hi\r\n\r\nbody').buffer,
            }),
        );
        expect(deliver.status).toBe(403);

        const search = await assertJson<SearchResponse>(
            await authedRequest(user.sessionToken, `/search/${user.id}?q=hello&sources=mail`),
        );
        expect(search.mail).toEqual([]);

        const home = await getHome(user.id);
        expect(fs.existsSync(path.join(home.homeDir, PATHS.MAIL.ROOT, PATHS.MAIL.MAILDIR))).toBe(false);
    });

    // A loaded home and the admin's cold read of an unloaded one report the same storage.
    test('mail kept from before still counts toward storage', async () => {
        const user = await createTestUser(`mail-kept-${randomUUID()}@test.eigen.is`, 'testpassword123', 'Mail Kept');
        const before = await getHome(user.id);
        await before.mail.mailboxDeliver(Buffer.from(makeEml('Kept while mail is off', { to: user.email })));
        await before.mail.mailboxGet(MAILBOX_INBOX);
        await evictHome(user.id);

        process.env['MAIL_ENABLED'] = '0';
        const home = await getHome(user.id);
        const cold = await readMailTotalSize(home.fs);
        expect(cold).toBeGreaterThan(0);
        expect(await home.mail.size()).toBe(cold);
    });
});
