import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import {
    assertJson,
    authedRequest,
    createTestUser,
    ensureServer,
    putDraft,
    TEST_DATA_DIR,
    uploadDraftAttachment,
} from '../setup';

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
        const user = await createTestUser(`mailsize-${Date.now()}@test.eigen.is`, 'testpassword123', 'Mail Size');
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

// Staged draft attachments are bytes in the home too: they count toward the mail half of the budget from
// the moment the upload lands until the draft save (or the 24h sweep) removes them.
describe('Staged draft attachment usage', () => {
    const MB = 1024 * 1024;
    let userId: string;
    let token: string;
    let stagingDir: string;

    beforeAll(async () => {
        await ensureServer();
        const user = await createTestUser(`draftstage-${Date.now()}@test.eigen.is`, 'testpassword123', 'Draft Stage');
        userId = user.id;
        token = user.sessionToken;
        stagingDir = join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'draft-attachments');
        // The welcome mail is appended with skipSync; one list on the empty DB indexes it, so the
        // deltas below belong to the staged files alone.
        const home = await getHome(userId);
        await home.mail.mailboxGet('');
    });

    async function reportedUsage(): Promise<number> {
        const size = await assertJson<HomeSizeResponse>(await authedRequest(token, `/home/${userId}/size`));
        return size.mailAndContacts.used;
    }

    test('staging grows reported usage, and saving the draft gives the staged bytes back', async () => {
        const before = await reportedUsage();

        const uploaded = await uploadDraftAttachment(
            token,
            userId,
            new File(['s'.repeat(4096)], 'staged.txt', { type: 'text/plain' }),
        );
        expect(await reportedUsage()).toBeGreaterThanOrEqual(before + uploaded.size);

        const saved = await putDraft(
            token,
            userId,
            {
                subject: 'Staged attachment',
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'bob@test.eigen.is' },
                text: 'staged',
                html: '<p>staged</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        // The staged copy is gone and only the draft's own EML is charged.
        expect(readdirSync(stagingDir)).toEqual([]);
        expect(await reportedUsage()).toBe(before + saved.size);
    });

    test('staging past the quota is refused and leaves nothing staged', async () => {
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;
        try {
            const used = await reportedUsage();
            const maxMB = Math.ceil(used / MB) + 1;
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: maxMB } });

            // Exactly fills the budget, so what refuses the next upload is the staged file itself.
            const headroom = maxMB * MB - used;
            const fill = await uploadDraftAttachment(
                token,
                userId,
                new File(['f'.repeat(headroom)], 'fill.txt', { type: 'text/plain' }),
            );
            expect(fill.size).toBe(headroom);

            const form = new FormData();
            form.append('file', new File(['over'], 'over.txt', { type: 'text/plain' }));
            const res = await authedRequest(token, `/mail/${userId}/message/draft/attachment`, {
                method: 'POST',
                body: form,
            });

            expect(res.status).toBe(507);
            expect(readdirSync(stagingDir).sort()).toEqual([fill.tempId, `${fill.tempId}.json`].sort());
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });
});
