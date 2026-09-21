import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_DRAFTS } from '@workspace/lib/constants/mailboxes';
import type { Email, EmailDraft, EmailSummary } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { mailRootOf, makeEml, seedMaildirFile } from '../mail-test-helpers';
import {
    assertJson,
    authedRequest,
    collectSSE,
    createTestUser,
    ensureServer,
    putDraft,
    type TestUser,
    uploadDraftAttachment,
} from '../setup';

const isWindows = process.platform === 'win32';

// createTestUser hits the auth DB directly, so the setup wizard must have run first.
beforeAll(async () => {
    await ensureServer();
});

function draftMetaDir(userId: string): string {
    return join(mailRootOf(userId), 'draft-meta');
}

// Empties the index the way deleting mail.db does: the next list of a mailbox finds no rows and
// blocks on a full re-index from the files on disk.
function clearIndex(userId: string): void {
    const db = new Database(join(mailRootOf(userId), 'mail.db'));
    try {
        db.run('DELETE FROM emails');
    } finally {
        db.close();
    }
}

async function listDrafts(user: TestUser): Promise<EmailSummary[]> {
    return assertJson<EmailSummary[]>(
        await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/Drafts?limit=50`),
    );
}

// A draft the fast path can take: it needs a sidecar listing at least one attachment.
async function fullSaveWithAttachment(user: TestUser, subject: string): Promise<EmailDraft> {
    const file = new File(['sidecar-bytes'], 'sidecar.txt', { type: 'text/plain' });
    const uploaded = await uploadDraftAttachment(user.sessionToken, user.id, file);
    return putDraft(
        user.sessionToken,
        user.id,
        {
            subject,
            to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' },
            text: 'v1',
            html: '<p>v1</p>',
        },
        { tempAttachmentIds: [uploaded.tempId] },
    );
}

describe.skipIf(isWindows)('Mail — draft sidecar', () => {
    test('a rebuilt index lists the fast-saved subject and recipients, not the last full save', async () => {
        const user = await createTestUser(
            `draft-sidecar-rebuild-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Draft Sidecar Rebuild',
        );
        const first = await fullSaveWithAttachment(user, 'Full saved subject');

        // Fast save: a new subject and a new recipient land in the sidecar + the row, not in the .eml.
        const fast = await putDraft(
            user.sessionToken,
            user.id,
            {
                id: first.id,
                subject: 'Fast saved subject',
                to: { value: [{ address: 'carol@test.eigen.is', name: 'Carol' }], text: 'Carol <carol@test.eigen.is>' },
                text: 'v2',
                html: '<p>v2</p>',
            },
            { keepAttachmentIndexes: first.attachments.map((a) => a.index) },
        );
        expect(fast.id).toBe(first.id);
        expect(fast.subject).toBe('Fast saved subject');

        clearIndex(user.id);

        const rows = await listDrafts(user);
        const row = rows.find((r) => r.id === first.id);
        expect(row?.subject).toBe('Fast saved subject');
        expect(row?.toAddress).toBe('carol@test.eigen.is');
        expect(row?.recipientsAll).toContain('Carol');
    });

    test('an unparsable sidecar counts as absent: the message and the list fall back to the .eml', async () => {
        const user = await createTestUser(
            `draft-sidecar-torn-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Draft Sidecar Torn',
        );
        const draft = await fullSaveWithAttachment(user, 'Full saved subject');

        // Torn bytes, as a crash mid-write would leave them.
        const metaDir = draftMetaDir(user.id);
        const [sidecar] = readdirSync(metaDir);
        writeFileSync(join(metaDir, sidecar), '{"html":"<p');

        const fetched = await assertJson<Email>(
            await authedRequest(user.sessionToken, `/mail/${user.id}/message/${draft.id}`),
        );
        expect(fetched.subject).toBe('Full saved subject');
        expect(fetched.text?.trim()).toBe('v1');

        clearIndex(user.id);

        const rows = await listDrafts(user);
        expect(rows.find((r) => r.id === draft.id)?.subject).toBe('Full saved subject');
    });

    test('a Drafts file whose id no sidecar can carry still lists', async () => {
        const user = await createTestUser(
            `draft-sidecar-alien-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Draft Sidecar Alien',
        );
        // Initialize the home: creates the Maildir tree before anything is seeded into it.
        expect((await authedRequest(user.sessionToken, `/home/${user.id}/size`)).status).toBe(200);

        // Another MDA's unique part. `+` is legal in a Maildir filename and refused as a draft id.
        const uniqueId = `${Date.now()}.M1P2Q3+alien`;
        const eml = makeEml('Written by another MDA', { from: 'alien@example.com', to: user.email });
        seedMaildirFile(user.id, MAILBOX_DRAFTS, uniqueId, eml, { flags: 'DS' });

        expect((await listDrafts(user)).map((row) => row.id)).toContain(uniqueId);
    });

    test('a Drafts file whose id no sidecar can carry deletes cleanly and announces itself', async () => {
        const user = await createTestUser(
            `draft-sidecar-alien-delete-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Draft Sidecar Alien Delete',
        );
        expect((await authedRequest(user.sessionToken, `/home/${user.id}/size`)).status).toBe(200);

        const uniqueId = `${Date.now()}.M1P2Q3+alien=delete`;
        const eml = makeEml('Deleted by hand', { from: 'alien@example.com', to: user.email });
        seedMaildirFile(user.id, MAILBOX_DRAFTS, uniqueId, eml, { flags: 'DS' });
        expect((await listDrafts(user)).map((row) => row.id)).toContain(uniqueId);

        const sse = collectSSE(user.id);
        const res = await authedRequest(user.sessionToken, `/mail/${user.id}/message/${encodeURIComponent(uniqueId)}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);
        expect((await listDrafts(user)).map((row) => row.id)).not.toContain(uniqueId);
        expect(sse.events.some((event) => event.type === SSEventType.MAIL_DELETED)).toBe(true);
        sse.stop();
    });

    test('a fast save leaves the sidecar complete and no temp debris beside it', async () => {
        const user = await createTestUser(
            `draft-sidecar-atomic-${Date.now()}@test.eigen.is`,
            'testpassword123',
            'Draft Sidecar Atomic',
        );
        const first = await fullSaveWithAttachment(user, 'Full saved subject');
        await putDraft(
            user.sessionToken,
            user.id,
            { id: first.id, subject: 'Fast saved subject', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: first.attachments.map((a) => a.index) },
        );

        const metaDir = draftMetaDir(user.id);
        const names = readdirSync(metaDir);
        expect(names.every((name) => name.endsWith('.json'))).toBe(true);
        expect(names.some((name) => name.includes('.tmp-'))).toBe(false);
        expect(JSON.parse(readFileSync(join(metaDir, names[0]), 'utf-8')).subject).toBe('Fast saved subject');
    });
});
