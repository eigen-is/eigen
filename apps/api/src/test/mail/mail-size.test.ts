import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_ARCHIVE } from '@workspace/lib/constants/mailboxes';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { getMailUploadMaxSize } from '../../lib/config/enforcement';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import { readMailTotalSize } from '../../lib/mail/maildb';
import { readDraftStagingSize } from '../../lib/mail/maildir-store';
import { mailRootOf, makeEml } from '../mail-test-helpers';
import { assertJson, authedRequest, createTestUser, ensureServer, putDraft, uploadDraftAttachment } from '../setup';

const sizedEml = (subject: string, body: string): Buffer =>
    Buffer.from(makeEml(subject, { to: 'mailsize@test.eigen.is', body }), 'utf-8');

// Mail usage is the index sum — SUM(emails.size) over mail.db (MaildirStore.size → MailDB.size), the
// one answer both the quota gate and the admin usage view read. An indexed message is charged by its
// own bytes, and a delete gives them back on the next read.
describe('Mail usage', () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
        await ensureServer();
        const user = await createTestUser(`mailsize-${Date.now()}@test.eigen.is`, 'testpassword123', 'Mail Size');
        userId = user.id;
        token = user.sessionToken;
        // The welcome mail is appended with skipSync, so the index only learns about it on the first
        // sync — one list on the empty DB blocks on that, leaving the deltas below to these messages.
        const home = await getHome(userId);
        await home.mail.mailboxGet('');
    });

    test('a delivered message is counted by its own bytes', async () => {
        const home = await getHome(userId);
        const before = await home.mail.size();
        const message = sizedEml('Mail size delivery', 'x'.repeat(4096));

        await home.mail.mailboxDeliver(message);

        expect(await home.mail.size()).toBe(before + message.byteLength);
    });

    test('a delete gives the bytes back', async () => {
        const home = await getHome(userId);
        const before = await home.mail.size();
        const message = sizedEml('Mail size delete', 'y'.repeat(2048));

        const messageId = await home.mail.mailboxDeliver(message);
        expect(await home.mail.size()).toBe(before + message.byteLength);

        await home.mail.messageDelete(messageId);

        expect(await home.mail.size()).toBe(before);
    });

    // The gate reads the same counter the store keeps, so a delivery is charged to the very next check —
    // no window in which the user can spend space a message just took.
    test('the quota gate charges a delivery to the next check', async () => {
        const MB = 1024 * 1024;
        const home = await getHome(userId);
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;
        try {
            // Squeeze the budget so what is left of it, not the 25 MB attachment ceiling, is the answer.
            const used = (await home.mail.size()) + (await home.contacts.size());
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.ceil(used / MB) + 1 } });

            const before = await getMailUploadMaxSize(userId);
            const message = sizedEml('Mail size gate', 'z'.repeat(8192));
            await home.mail.mailboxDeliver(message);

            expect(await getMailUploadMaxSize(userId)).toBe(before - message.byteLength);
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });

    // The counter is adjusted per row and per staged file, so it has to survive every path that adds or
    // frees bytes — measured against the numbers it replaces: a fresh index sum plus a staging walk.
    test('the counter still equals the index sum after a run of mutations', async () => {
        const home = await getHome(userId);

        const delivered: string[] = [];
        for (const subject of ['Run one', 'Run two', 'Run three']) {
            delivered.push(await home.mail.mailboxDeliver(sizedEml(subject, 'r'.repeat(1024))));
        }
        await home.mail.messageDelete(delivered[0]);
        await home.mail.messageMove(delivered[1], MAILBOX_ARCHIVE);
        await home.mail.messageCopy(delivered[2], MAILBOX_ARCHIVE);

        const draft = await home.mail.messageHandleDraft({
            subject: 'Run draft',
            to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'bob@test.eigen.is' },
            text: 'first body',
            html: '<p>first body</p>',
        });
        const staged = await uploadDraftAttachment(
            token,
            userId,
            new File(['p'.repeat(2048)], 'run.txt', { type: 'text/plain' }),
        );
        await home.mail.messageHandleDraft(
            { ...draft, text: 'a second body, longer than the first', html: '<p>a second body</p>' },
            { tempAttachmentIds: [staged.tempId] },
        );
        await home.mail.messageImport(sizedEml('Run import', 'i'.repeat(512)));

        const onDisk = readMailTotalSize(join(mailRootOf(userId), 'mail.db')) + (await readDraftStagingSize(home.fs));
        expect(await home.mail.size()).toBe(onDisk);
    });

    // The admin usage view sizes homes nobody has loaded, so it reads the files and the DB itself. For a
    // loaded home the two have to answer the same number.
    test('the admin size view agrees with the live counter', async () => {
        const home = await getHome(userId);
        const reported = await assertJson<HomeSizeResponse>(await authedRequest(token, `/home/${userId}/size`));

        expect(reported.mailAndContacts.used - (await home.contacts.size())).toBe(await home.mail.size());
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
        stagingDir = join(mailRootOf(userId), 'draft-attachments');
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
