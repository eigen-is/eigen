import { beforeAll, describe, expect, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { SearchResponse } from '@workspace/lib/types/search';
import { makeEml, seedMaildirFile, seedMaildirFolder } from '../mail-test-helpers';
import { assertJson, authedRequest, getTestContext } from '../setup';

const isWindows = process.platform === 'win32';

// Seed a dedicated custom mailbox (unique name, isolated from every other test file) with a
// known set of messages: 201 total (> the default page size of 200), three of which share a
// single received time to pin the (receivedAt, id) keyset tiebreak, plus one long body whose unique word
// sits past character 200 to prove the list-response textShort cap doesn't touch the FTS index. The long
// one has a sender of its own, so a from:-only search (the path with no FTS term) can find it too. Each
// Date header runs the other way round, so a list that sorted by it would come out reversed.
const TOTAL = 201;
const LONG_IDX = 50;
const NEEDLE = 'pagefindneedle';
const LONG_SENDER = 'longbody@example.com';
const LONG_BODY = `${'lorem ipsum dolor sit amet '.repeat(10)}${NEEDLE} end`;
const WALK_LIMIT = 5;

type Seed = { id: string; subject: string };

const receivedMs = (row: EmailSummary) => new Date(row.receivedAt).getTime();

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

        // Boots the home first: a Maildir that already exists gets no standard folders.
        expect((await authedRequest(token, `/home/${ownerId}/size`)).status).toBe(200);
        seedMaildirFolder(ownerId, box);

        const base = Date.UTC(2021, 0, 1, 0, 0, 0);
        for (let i = 0; i < TOTAL; i++) {
            // Indices 100/101/102 all collapse onto the minute-100 received time -> a 3-message cluster
            // sharing one; every other index gets its own distinct minute.
            const receivedAt = new Date(i === 101 || i === 102 ? base + 100 * 60_000 : base + i * 60_000);
            const subject = `Page ${i}`;
            const id = `${Date.now()}.page${i}`;
            const eml =
                i === LONG_IDX
                    ? makeEml(subject, { from: LONG_SENDER, body: LONG_BODY, date: new Date(base - i * 60_000) })
                    : makeEml(subject, { body: `body ${i}`, date: new Date(base - i * 60_000) });
            const filePath = seedMaildirFile(ownerId, box, id, eml);
            utimesSync(filePath, receivedAt, receivedAt);
            seeds.push({ id, subject });
            if (i === LONG_IDX) longId = id;
        }
    });

    test('page 1 returns the newest messages, capped at limit', async () => {
        const page = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=${WALK_LIMIT}`),
        );
        expect(page.length).toBe(WALK_LIMIT);
        expect(page[0].subject).toBe(`Page ${TOTAL - 1}`);
        for (let i = 1; i < page.length; i++) {
            expect(receivedMs(page[i - 1])).toBeGreaterThanOrEqual(receivedMs(page[i]));
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
            expect(receivedMs(page[i - 1])).toBeGreaterThanOrEqual(receivedMs(page[i]));
        }
    });

    test('walking before cursors covers the mailbox with no gaps or duplicates', async () => {
        const full = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${ownerId}/mailbox/${box}?limit=500`),
        );
        expect(full.length).toBe(TOTAL);

        // Authoritative order is receivedAt DESC, id DESC.
        for (let i = 1; i < full.length; i++) {
            const prev = receivedMs(full[i - 1]);
            const cur = receivedMs(full[i]);
            expect(prev).toBeGreaterThanOrEqual(cur);
            if (prev === cur) expect(full[i - 1].id > full[i].id).toBe(true);
        }

        // The seeded cluster materialised: at least one received time is shared by >= 3 messages.
        const perTime = new Map<number, number>();
        for (const r of full) {
            perTime.set(receivedMs(r), (perTime.get(receivedMs(r)) ?? 0) + 1);
        }
        expect([...perTime.values()].some((c) => c >= 3)).toBe(true);

        const walked: string[] = [];
        const seen = new Set<string>();
        let before: { receivedMs: number; id: string } | undefined;
        let dup = false;
        for (let guard = 0; guard <= TOTAL && !dup; guard++) {
            let path = `/mail/${ownerId}/mailbox/${box}?limit=${WALK_LIMIT}`;
            if (before) path += `&beforeReceivedAt=${before.receivedMs}&beforeId=${encodeURIComponent(before.id)}`;
            const pg = await assertJson<EmailSummary[]>(await authedRequest(token, path));
            if (pg.length === 0) break;
            for (const row of pg) {
                if (seen.has(row.id)) dup = true;
                seen.add(row.id);
                walked.push(row.id);
            }
            const last = pg[pg.length - 1];
            before = { receivedMs: receivedMs(last), id: last.id };
            if (pg.length < WALK_LIMIT) break;
        }

        expect(dup).toBe(false);
        expect(walked).toEqual(full.map((r) => r.id));
        expect(new Set(walked)).toEqual(new Set(seeds.map((s) => s.id)));
    });

    test('textShort is capped at 200 in the list and search responses but stays fully searchable via FTS', async () => {
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
        const ranked = search.mail.find((h) => h.id === longId);
        expect(ranked).toBeDefined();
        expect(ranked!.textShort.length).toBeLessThanOrEqual(200);

        const filtered = await assertJson<SearchResponse>(
            await authedRequest(token, `/search/${ownerId}?q=&from=${LONG_SENDER}&mailbox=${box}&sources=mail`),
        );
        expect(filtered.mail.map((h) => h.id)).toEqual([longId]);
        expect(filtered.mail[0].textShort.length).toBeLessThanOrEqual(200);
    });
});
