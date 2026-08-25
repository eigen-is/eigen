import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { SearchResponse } from '@workspace/lib/types/search';
import { SSEventType } from '@workspace/lib/types/sse';
import { app, assertJson, authedRequest, collectSSE, TEST_DATA_DIR } from '../setup';

const isWindows = process.platform === 'win32';

function userMaildir(userId: string) {
    return join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'Maildir');
}

function curDir(userId: string, mailbox: string) {
    const base = userMaildir(userId);
    return mailbox === '' ? join(base, 'cur') : join(base, `.${mailbox}`, 'cur');
}

function makeEml(subject: string, body: string, from = 'sender@example.com', to = 'recipient@test.eigen.is') {
    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${Math.random()}@test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
    ].join('\r\n');
}

// Writes a synthetic maildir file straight into `mailbox`'s cur/ — bypassing delivery/sync, same
// as a bulk mail-client drop or Dovecot placing files (pattern from mail-imap.test.ts).
function seedCurFile(userId: string, mailbox: string, uniqueId: string, eml: string, flags = 'S'): void {
    const size = Buffer.byteLength(eml, 'utf-8');
    writeFileSync(join(curDir(userId, mailbox), `${uniqueId},S=${size}:2,${flags}`), eml);
}

// Seeds a directory (not a file) shaped like a maildir entry — reading it throws EISDIR, a
// genuinely "unreadable .eml" fault distinct from ENOENT, exercising the per-message skip.
function seedUnreadableCurEntry(userId: string, mailbox: string, uniqueId: string): void {
    mkdirSync(join(curDir(userId, mailbox), `${uniqueId},S=10:2,S`));
}

async function createTestUser(email: string, name: string): Promise<{ id: string; sessionToken: string }> {
    const { auth } = await import('../../lib/auth/auth');
    const signUp = await auth.api.signUpEmail({ body: { email, password: 'testpassword123', name } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: 'testpassword123' } });
    const setCookie = signIn.headers.get('set-cookie') || '';
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`Session token not found in set-cookie header: ${setCookie}`);
    return { id: signUp.user.id, sessionToken: match[1] };
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
    const eml = makeEml(subject, body, 'sender@example.com', to);
    const res = await app.handle(
        new Request(`http://localhost/mail/deliver/${to}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    if (res.status !== 200) throw new Error(`Delivery failed: ${res.status}`);
}

describe.skipIf(isWindows)('Mail sync (Step 3: non-blocking sync + batched cold-index inserts)', () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
        const userEmail = `mailsync-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(userEmail, 'Mail Sync Test');
        userId = user.id;
        token = user.sessionToken;
        // Initialize the home — delivers welcome mail (skipSync) and creates the Maildir tree.
        const sizeRes = await authedRequest(token, `/home/${userId}/size`);
        expect(sizeRes.status).toBe(200);
    });

    test('serve-stale: listMessages returns the current DB state without waiting for a pending background sync', async () => {
        const box = `Stale-${Date.now()}`;
        await createMailbox(token, userId, box);

        // First open (empty DB) — blocking path, gives us one known indexed row.
        seedCurFile(userId, box, `${Date.now()}.first`, makeEml('Seed', 'seed body'));
        const first = await listBox(token, userId, box, 500);
        expect(first.length).toBe(1);

        // Drop a sizeable batch of new files directly on disk — on a non-empty mailbox this
        // must NOT be awaited before the route responds.
        const BURST = 300;
        for (let i = 0; i < BURST; i++) {
            seedCurFile(userId, box, `${Date.now()}.burst${i}`, makeEml(`Burst ${i}`, `body ${i}`));
        }

        const start = performance.now();
        const stale = await listBox(token, userId, box, 500);
        const elapsedMs = performance.now() - start;

        // Served from the DB as-is: still just the one previously-indexed row, not the 300
        // pending ones — proves the sync wasn't awaited, not just that it was fast.
        expect(stale.length).toBe(1);
        expect(elapsedMs).toBeLessThan(1000);

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
            seedCurFile(userId, box, id, makeEml(`Cold ${i}`, body), isFlagged ? 'F' : i % 2 === 0 ? 'S' : '');
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
    });

    test("a bad .eml in a chunk does not drop the chunk's other inserts", async () => {
        const box = `Bad-${Date.now()}`;
        await createMailbox(token, userId, box);

        const goodIds: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = `${Date.now()}.good${i}`;
            seedCurFile(userId, box, id, makeEml(`Good ${i}`, `body ${i}`));
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
            const user = await createTestUser(coalesceEmail, 'Mail Sync Coalesce Test');
            coalesceUserId = user.id;
            coalesceToken = user.sessionToken;
            const sizeRes = await authedRequest(coalesceToken, `/home/${coalesceUserId}/size`);
            expect(sizeRes.status).toBe(200);
        });

        test('a burst of new mail within the coalesce window upserts the mail:new row but broadcasts once', async () => {
            const sse = collectSSE(coalesceUserId);
            await new Promise((r) => setTimeout(r, 50));

            // The still-unindexed welcome mail (delivered with skipSync at home-init) surfaces as
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
