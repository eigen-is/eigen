import { beforeAll, describe, expect, test } from 'bun:test';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { SearchResponse } from '@workspace/lib/types/search';
import { app, assertJson, authedRequest, getTestContext } from '../setup';

const isWindows = process.platform === 'win32';

// Seed a dedicated custom mailbox (unique name, isolated from every other test file) with a
// known set of messages: 201 total (> the default page size of 200), three of which share a
// single timestamp to pin the (date, id) keyset tiebreak, plus one long body whose unique word
// sits past character 200 to prove the list-response textShort cap doesn't touch the FTS index.
const TOTAL = 201;
const LONG_IDX = 50;
const NEEDLE = 'pagefindneedle';
const LONG_BODY = `${'lorem ipsum dolor sit amet '.repeat(10)}${NEEDLE} end`;
const WALK_LIMIT = 5;

type Seed = { id: string; subject: string; dateMs: number };

async function deliverToInbox(email: string, subject: string, dateMs: number, body: string): Promise<string> {
    const eml = [
        'From: sender@example.com',
        `To: ${email}`,
        `Subject: ${subject}`,
        `Date: ${new Date(dateMs).toUTCString()}`,
        '',
        body,
    ].join('\r\n');
    const res = await app.handle(
        new Request(`http://localhost/mail/deliver/${email}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    if (!res.ok) throw new Error(`deliver failed: ${res.status}`);
    return await res.text();
}

// Delivery indexes via a sync that can coalesce with an in-flight fs-watcher sync and miss the
// just-written file (see search.test.ts). Drive a fresh sync and retry until the row is in the
// DB, then move it out of the inbox into the isolated box (move preserves the Date-header date).
async function moveWhenIndexed(ownerId: string, id: string, box: string): Promise<void> {
    const { getHome } = await import('../../lib/home');
    const home = await getHome(ownerId);
    for (let i = 0; i < 40; i++) {
        await home.mail.mailboxGet('');
        if (await home.mail.messageGet(id)) {
            await home.mail.messageMove(id, box);
            return;
        }
        await Bun.sleep(25);
    }
    throw new Error(`message ${id} was not indexed for move`);
}

describe.skipIf(isWindows)('Mail pagination', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let box: string;
    let token: string;
    let ownerId: string;
    const seeds: Seed[] = [];
    let longId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        token = ctx.charlie.user.sessionToken;
        ownerId = ctx.charlie.user.id;
        box = `Pagination-${Date.now()}`;

        const createRes = await authedRequest(token, `/mail/${ownerId}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: box }),
        });
        expect(createRes.status).toBe(200);

        const base = Date.UTC(2021, 0, 1, 0, 0, 0);
        for (let i = 0; i < TOTAL; i++) {
            // Indices 100/101/102 all collapse onto the minute-100 timestamp -> a 3-message cluster
            // sharing one date; every other index gets its own distinct minute.
            const dateMs = i === 101 || i === 102 ? base + 100 * 60_000 : base + i * 60_000;
            const subject = `Page ${i}`;
            const body = i === LONG_IDX ? LONG_BODY : `body ${i}`;
            const id = await deliverToInbox(ctx.charlie.user.email, subject, dateMs, body);
            await moveWhenIndexed(ownerId, id, box);
            seeds.push({ id, subject, dateMs });
            if (i === LONG_IDX) longId = id;
        }
        // Seeding a whole mailbox with per-message index polls regularly outruns bun's 5s hook default under load.
    }, 60_000);

    test('page 1 returns the newest messages, capped at limit', async () => {
        const page = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=${WALK_LIMIT}`),
        );
        expect(page.length).toBe(WALK_LIMIT);
        expect(page[0].subject).toBe(`Page ${TOTAL - 1}`);
        for (let i = 1; i < page.length; i++) {
            expect(new Date(page[i - 1].date).getTime()).toBeGreaterThanOrEqual(new Date(page[i].date).getTime());
        }
    });

    test('limit above the max (500) is rejected with 422', async () => {
        const res = await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=501`);
        expect(res.status).toBe(422);
    });

    test('no params returns the default page of 200, not the whole mailbox', async () => {
        const page = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${ownerId}/mailbox/${box}`));
        expect(page.length).toBe(200);
        expect(page[0].subject).toBe(`Page ${TOTAL - 1}`);
        for (let i = 1; i < page.length; i++) {
            expect(new Date(page[i - 1].date).getTime()).toBeGreaterThanOrEqual(new Date(page[i].date).getTime());
        }
    });

    test('walking before cursors covers the mailbox with no gaps or duplicates', async () => {
        const full = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=500`),
        );
        expect(full.length).toBe(TOTAL);

        // Authoritative order is date DESC, id DESC.
        for (let i = 1; i < full.length; i++) {
            const prev = new Date(full[i - 1].date).getTime();
            const cur = new Date(full[i].date).getTime();
            expect(prev).toBeGreaterThanOrEqual(cur);
            if (prev === cur) expect(full[i - 1].id > full[i].id).toBe(true);
        }

        // The seeded cluster materialised: at least one date is shared by >= 3 messages.
        const perDate = new Map<number, number>();
        for (const r of full) {
            const key = new Date(r.date).getTime();
            perDate.set(key, (perDate.get(key) ?? 0) + 1);
        }
        expect([...perDate.values()].some((c) => c >= 3)).toBe(true);

        const walked: string[] = [];
        const seen = new Set<string>();
        let before: { dateMs: number; id: string } | undefined;
        let dup = false;
        for (let guard = 0; guard <= TOTAL && !dup; guard++) {
            let path = `/mail/${ownerId}/mailbox/${box}?limit=${WALK_LIMIT}`;
            if (before) path += `&beforeDate=${before.dateMs}&beforeId=${encodeURIComponent(before.id)}`;
            const pg = await assertJson<EmailSummary[]>(await authedRequest(token, path));
            if (pg.length === 0) break;
            for (const row of pg) {
                if (seen.has(row.id)) dup = true;
                seen.add(row.id);
                walked.push(row.id);
            }
            const last = pg[pg.length - 1];
            before = { dateMs: new Date(last.date).getTime(), id: last.id };
            if (pg.length < WALK_LIMIT) break;
        }

        expect(dup).toBe(false);
        expect(walked).toEqual(full.map((r) => r.id));
        expect(new Set(walked)).toEqual(new Set(seeds.map((s) => s.id)));
    });

    test('textShort is capped at 200 in the list response but stays fully searchable via FTS', async () => {
        const full = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=500`),
        );
        const longRow = full.find((r) => r.id === longId);
        expect(longRow).toBeDefined();
        expect(longRow!.textShort.length).toBeLessThanOrEqual(200);
        expect(longRow!.textShort.includes(NEEDLE)).toBe(false);

        const search = await assertJson<SearchResponse>(
            await authedRequest(token, `/search/${ownerId}?q=${NEEDLE}&sources=mail`),
        );
        expect(search.mail.some((h) => h.id === longId)).toBe(true);
    });
});
