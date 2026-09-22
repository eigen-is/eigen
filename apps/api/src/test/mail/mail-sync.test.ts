import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_ARCHIVE, MAILBOX_INBOX_KEY } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import type { SearchResponse } from '@workspace/lib/types/search';
import { SSEventType } from '@workspace/lib/types/sse';
import { boxDir, mailRootOf, makeEml, seedMaildirFile } from '../mail-test-helpers';
import {
    app,
    assertJson,
    authedRequest,
    collectSSE,
    createTestUser,
    ensureServer,
    findOrFail,
    type TestUser,
} from '../setup';

// createTestUser hits the auth DB directly, so the setup wizard (which creates the auth schema and
// configures the org) must have run first. Under --parallel each file boots its own server; gate on it.
beforeAll(async () => {
    await ensureServer();
});

const isWindows = process.platform === 'win32';

// Seeds a directory (not a file) shaped like a maildir entry — reading it throws EISDIR, a
// genuinely "unreadable .eml" fault distinct from ENOENT, exercising the per-message skip.
function seedUnreadableCurEntry(userId: string, mailbox: string, uniqueId: string): void {
    mkdirSync(join(boxDir(userId, mailbox), 'cur', `${uniqueId},S=10:2,S`));
}

async function createMailbox(token: string, ownerId: string, mailbox: string): Promise<void> {
    const res = await authedRequest(token, `/mail/${ownerId}/mailbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox }),
    });
    expect(res.status).toBe(200);
}

async function listBox(token: string, ownerId: string, box: string, limit: number): Promise<EmailSummary[]> {
    return assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=${limit}`));
}

async function deliverEmail(to: string, subject: string, body: string): Promise<void> {
    const eml = makeEml(subject, { to, body });
    const res = await app.handle(
        new Request(`http://localhost/mail/deliver/${to}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    if (res.status !== 200) throw new Error(`Delivery failed: ${res.status}`);
}

// Empties the index the way a lost mail.db does: the next sync rebuilds it from every file on disk.
function clearIndex(userId: string): void {
    const db = new Database(join(mailRootOf(userId), 'mail.db'));
    try {
        db.run('DELETE FROM emails');
    } finally {
        db.close();
    }
}

async function mailNewRows(user: TestUser): Promise<Notification[]> {
    const rows = await assertJson<Notification[]>(await authedRequest(user.sessionToken, `/notifications/${user.id}`));
    return rows.filter((row) => row.tag === 'mail:new');
}

async function dismissMailNotifications(user: TestUser): Promise<void> {
    for (const row of await mailNewRows(user)) {
        const res = await authedRequest(user.sessionToken, `/notifications/${user.id}/${row.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
    }
}

// The subject each mail:new broadcast carries. Announcements coalesce onto one row, so the broadcast
// (the first of the window) and the row (the last one wins) together name both ends of the batch.
async function announcedWhile(user: TestUser, act: () => Promise<void>): Promise<string[]> {
    const sse = collectSSE(user.id);
    await Bun.sleep(50);
    await act();
    await Bun.sleep(100);
    sse.stop();
    return sse.events.flatMap((event) =>
        event.type === SSEventType.NOTIFICATION_CREATED && event.tag === 'mail:new' ? [event.body ?? ''] : [],
    );
}

async function initHome(user: TestUser): Promise<void> {
    expect((await authedRequest(user.sessionToken, `/home/${user.id}/size`)).status).toBe(200);
}

describe.skipIf(isWindows)('Mail sync (Step 3: non-blocking sync + batched cold-index inserts)', () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
        const userEmail = `mailsync-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(userEmail, 'testpassword123', 'Mail Sync Test');
        userId = user.id;
        token = user.sessionToken;
        // Initialize the home — delivers welcome mail (skipReconcile) and creates the Maildir tree.
        const sizeRes = await authedRequest(token, `/home/${userId}/size`);
        expect(sizeRes.status).toBe(200);
    });

    test('serve-stale: listMessages returns the current DB state without waiting for a pending background sync', async () => {
        const box = `Stale-${Date.now()}`;
        await createMailbox(token, userId, box);

        // First open (empty DB) — blocking path, gives us one known indexed row.
        seedMaildirFile(userId, box, `${Date.now()}.first`, makeEml('Seed', { body: 'seed body' }));
        const first = await listBox(token, userId, box, 500);
        expect(first.length).toBe(1);

        // Drop a sizeable batch of new files directly on disk — on a non-empty mailbox this
        // must NOT be awaited before the route responds.
        const BURST = 80;
        for (let i = 0; i < BURST; i++) {
            seedMaildirFile(userId, box, `${Date.now()}.burst${i}`, makeEml(`Burst ${i}`, { body: `body ${i}` }));
        }

        const stale = await listBox(token, userId, box, 500);

        // Served from the DB as-is: still just the one previously-indexed row, not the pending batch.
        // The count alone proves the sync wasn't awaited — had the route blocked on the batch, it would
        // return all BURST + 1. (No wall-clock assertion: under a saturated --parallel run a correct non-blocking
        // read can still be slow, and length is the property that actually matters.)
        expect(stale.length).toBe(1);

        // The background sync does eventually catch up; new rows arrive without further requests
        // blocking on them.
        let settled: EmailSummary[] = [];
        for (let i = 0; i < 60; i++) {
            settled = await listBox(token, userId, box, 500);
            if (settled.length === BURST + 1) break;
            await Bun.sleep(50);
        }
        expect(settled.length).toBe(BURST + 1);
    });

    test('cold-index correctness: batched insert produces the same counts/flags/FTS as the old per-row path', async () => {
        const box = `Cold-${Date.now()}`;
        await createMailbox(token, userId, box);

        const TOTAL = 260; // > NEW_CHUNK (250) — spans two chunks
        const NEEDLE = `coldindexneedle${Date.now()}`;
        let flaggedId = '';
        let needleId = '';
        for (let i = 0; i < TOTAL; i++) {
            const id = `${Date.now()}.cold${i}`;
            const isFlagged = i === 3;
            const hasNeedle = i === 200;
            const body = hasNeedle ? `${'lorem ipsum '.repeat(5)}${NEEDLE} end` : `body ${i}`;
            seedMaildirFile(userId, box, id, makeEml(`Cold ${i}`, { body }), {
                flags: isFlagged ? 'F' : i % 2 === 0 ? 'S' : '',
            });
            if (isFlagged) flaggedId = id;
            if (hasNeedle) needleId = id;
        }

        // First access to this mailbox — empty DB, so this blocks on the full index (both chunks).
        const rows = await listBox(token, userId, box, TOTAL + 50);
        expect(rows.length).toBe(TOTAL);

        const flaggedRow = rows.find((r) => r.id === flaggedId);
        expect(flaggedRow?.isFlagged).toBe(true);
        const seenRow = rows.find((r) => r.subject === 'Cold 0');
        expect(seenRow?.isRead).toBe(true);
        const unseenRow = rows.find((r) => r.subject === 'Cold 1');
        expect(unseenRow?.isRead).toBe(false);

        const search = await assertJson<SearchResponse>(
            await authedRequest(token, `/search/${userId}?q=${NEEDLE}&sources=mail`),
        );
        expect(search.mail.some((h) => h.id === needleId)).toBe(true);
        // Deterministic heavy work, not a race: this first access blocks on a full cold index of >250
        // messages (spanning both NEW_CHUNK batches) plus an FTS search — ~1s on an idle box, but it can
        // exceed the 5s default under a saturated --parallel run, where the ncpu test workers each also
        // spawn their own transform/thumbnail Worker threads. An explicit budget, not a masked flake.
    }, 20_000);

    test("a bad .eml in a chunk does not drop the chunk's other inserts", async () => {
        const box = `Bad-${Date.now()}`;
        await createMailbox(token, userId, box);

        const goodIds: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = `${Date.now()}.good${i}`;
            seedMaildirFile(userId, box, id, makeEml(`Good ${i}`, { body: `body ${i}` }));
            goodIds.push(id);
        }
        // A directory shaped like a maildir entry: reading it throws EISDIR, not ENOENT — a
        // genuine parse fault that must be skipped without aborting the rest of the chunk.
        seedUnreadableCurEntry(userId, box, `${Date.now()}.bad`);

        const rows = await listBox(token, userId, box, 50);
        expect(rows.length).toBe(5);
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set(goodIds));

        // Retrying the sync (another list call) is harmless — the bad entry is skipped again,
        // not indexed, and the good rows aren't duplicated or dropped.
        const again = await listBox(token, userId, box, 50);
        expect(again.length).toBe(5);
    });

    describe('notification coalescing', () => {
        let coalesceUserId: string;
        let coalesceEmail: string;
        let coalesceToken: string;

        beforeAll(async () => {
            coalesceEmail = `mailsync-coalesce-${Date.now()}@test.eigen.is`;
            const user = await createTestUser(coalesceEmail, 'testpassword123', 'Mail Sync Coalesce Test');
            coalesceUserId = user.id;
            coalesceToken = user.sessionToken;
            const sizeRes = await authedRequest(coalesceToken, `/home/${coalesceUserId}/size`);
            expect(sizeRes.status).toBe(200);
        });

        test('a burst of new mail within the coalesce window upserts the mail:new row but broadcasts once', async () => {
            const sse = collectSSE(coalesceUserId);
            await new Promise((r) => setTimeout(r, 50));

            // The still-unindexed welcome mail (delivered with skipReconcile at home-init) surfaces as
            // its own "new mail" discovery on the first sync below, alongside the burst — both
            // count toward the same coalesce window.
            for (let i = 0; i < 4; i++) {
                await deliverEmail(coalesceEmail, `Coalesce ${i}`, `body ${i}`);
            }

            await new Promise((r) => setTimeout(r, 50));
            sse.stop();

            const created = sse.events.filter((e) => e.type === SSEventType.NOTIFICATION_CREATED);
            expect(created.length).toBe(1);

            const notifRes = await authedRequest(coalesceToken, `/notifications/${coalesceUserId}`);
            const data = await notifRes.json();
            const list = Array.isArray(data) ? data : (data.notifications ?? data ?? []);
            const mailRows = list.filter((n: { tag: string }) => n.tag === 'mail:new');
            expect(mailRows.length).toBe(1);
            expect(mailRows[0].title).toContain('sender@example.com'.split('@')[0]);
        });
    });
});

describe.skipIf(isWindows)('Only the delivered message is new', () => {
    test('a first index announces the delivery alone, not the welcome mail beside it', async () => {
        const userEmail = `mailcold-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(userEmail, 'testpassword123', 'Mail Cold Index Test');
        // Writes the welcome mail into the inbox without indexing it (skipReconcile), so the delivery below
        // is the sync that indexes them both.
        await initHome(user);

        const broadcast = await announcedWhile(user, () => deliverEmail(userEmail, 'The real arrival', 'body'));
        expect(broadcast).toEqual(['The real arrival']);
        expect((await mailNewRows(user)).map((row) => row.body)).toEqual(['The real arrival']);

        // Silent, not unindexed: the welcome mail is listed alongside the delivery.
        const inbox = await listBox(user.sessionToken, user.id, MAILBOX_INBOX_KEY, 50);
        expect(inbox.map((message) => message.subject)).toContain('The real arrival');
        expect(inbox.length).toBeGreaterThan(1);
    });

    test('a delivery after the index is lost re-announces nothing but itself', async () => {
        const userEmail = `mailreindex-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(userEmail, 'testpassword123', 'Mail Reindex Test');
        await initHome(user);

        await deliverEmail(userEmail, 'Old one', 'a');
        await deliverEmail(userEmail, 'Old two', 'b');
        expect((await listBox(user.sessionToken, user.id, MAILBOX_INBOX_KEY, 50)).length).toBeGreaterThanOrEqual(2);

        // A row still inside the coalesce window suppresses the next broadcast.
        await dismissMailNotifications(user);

        // Emptied with the delivery, so no watcher-driven sync reindexes the inbox in between.
        const broadcast = await announcedWhile(user, () => {
            clearIndex(user.id);
            return deliverEmail(userEmail, 'After the loss', 'c');
        });
        expect(broadcast).toEqual(['After the loss']);
        expect((await mailNewRows(user)).map((row) => row.body)).toEqual(['After the loss']);

        const inbox = await listBox(user.sessionToken, user.id, MAILBOX_INBOX_KEY, 50);
        expect(inbox.map((message) => message.subject)).toContain('Old one');
        expect(inbox.map((message) => message.subject)).toContain('Old two');
    });

    test('a copy is not an arrival', async () => {
        const userEmail = `mailcopy-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(userEmail, 'testpassword123', 'Mail Copy Test');
        await initHome(user);

        await deliverEmail(userEmail, 'The original', 'body');
        const inbox = await listBox(user.sessionToken, user.id, MAILBOX_INBOX_KEY, 50);
        const original = findOrFail(inbox, (message) => message.subject === 'The original');
        await dismissMailNotifications(user);

        const broadcast = await announcedWhile(user, async () => {
            const res = await authedRequest(user.sessionToken, `/mail/${user.id}/message/copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId: original.id, targetMailbox: MAILBOX_ARCHIVE }),
            });
            expect(res.status).toBe(200);
        });

        expect(broadcast).toEqual([]);
        expect(await mailNewRows(user)).toEqual([]);
        const archive = await listBox(user.sessionToken, user.id, MAILBOX_ARCHIVE, 50);
        expect(archive.map((row) => row.subject)).toEqual(['The original']);
    });
});
