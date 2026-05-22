import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SearchResponse } from '@workspace/lib/types/search';
import { openLocalDatabase } from '../lib/core/managed-database';
import { SEARCH_DB_CONFIG } from '../lib/search/db-config';
import { type SearchDoc, SearchIndex } from '../lib/search/search-index';
import { app, assertJson, authedRequest, getTestContext, TEST_DATA_DIR } from './setup';

let indexCounter = 0;
async function freshIndex(): Promise<SearchIndex> {
    indexCounter += 1;
    const managed = await openLocalDatabase(
        SEARCH_DB_CONFIG,
        join(TEST_DATA_DIR, `search-unit-${indexCounter}`, 'search.db'),
    );
    return new SearchIndex(managed.db);
}

function mailDoc(id: string, title: string, body: string, sortKey = Date.now()): SearchDoc {
    return {
        kind: 'mail',
        itemId: id,
        title,
        body,
        metadata: { from: 'sender@test.eigen.is', mailbox: '' },
        sortKey,
    };
}

describe('SearchIndex', () => {
    test('upsert then query finds a hit by a title word', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'Quarterly budget review', 'numbers inside'));
        const hits = index.query('budget', 10);
        expect(hits).toHaveLength(1);
        expect(hits[0].itemId).toBe('m1');
        expect(hits[0].title).toBe('Quarterly budget review');
    });

    test('query matches words in the body', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'Hello', 'the pangolin is asleep'));
        expect(index.query('pangolin', 10)).toHaveLength(1);
    });

    test('query returns nothing for a non-matching term', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'Hello world', 'body text'));
        expect(index.query('zzzznomatch', 10)).toEqual([]);
    });

    test('delete removes a hit from results', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'deletable subject', 'body'));
        expect(index.query('deletable', 10)).toHaveLength(1);
        index.delete('mail', 'm1');
        expect(index.query('deletable', 10)).toEqual([]);
    });

    test('re-upsert with the same kind+itemId updates in place, no duplicate', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'first subject', 'body'));
        index.upsert(mailDoc('m1', 'second subject', 'body'));
        expect(index.query('first', 10)).toEqual([]);
        const hits = index.query('second', 10);
        expect(hits).toHaveLength(1);
        expect(hits[0].itemId).toBe('m1');
    });

    test('punctuation-heavy input does not throw and still matches', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'Q3 results', 'body'));
        expect(() => index.query('"q3"* (results):', 10)).not.toThrow();
        expect(index.query('q3 results', 10)).toHaveLength(1);
    });

    test('an empty or all-punctuation query returns no results', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'something', 'body'));
        expect(index.query('   ', 10)).toEqual([]);
        expect(index.query('!@#$%', 10)).toEqual([]);
    });

    test('limit caps the number of hits', async () => {
        const index = await freshIndex();
        for (let i = 0; i < 5; i += 1) index.upsert(mailDoc(`m${i}`, `report ${i}`, 'body'));
        expect(index.query('report', 3)).toHaveLength(3);
    });

    test('metadata and sortKey round-trip through the index', async () => {
        const index = await freshIndex();
        index.upsert({
            kind: 'mail',
            itemId: 'm1',
            title: 'subj',
            body: 'b',
            metadata: { from: 'alice@test.eigen.is', mailbox: 'Sent' },
            sortKey: 123,
        });
        const hit = index.query('subj', 10)[0];
        expect(hit.metadata).toEqual({ from: 'alice@test.eigen.is', mailbox: 'Sent' });
        expect(hit.sortKey).toBe(123);
    });

    test('isEmpty reflects whether the index has rows', async () => {
        const index = await freshIndex();
        expect(index.isEmpty()).toBe(true);
        index.upsert(mailDoc('m1', 'subj', 'body'));
        expect(index.isEmpty()).toBe(false);
    });
});

const isWindows = process.platform === 'win32';

// Delivery awaits the inbox sync, so the email is parsed into mail.db (and indexed) by the
// time the deliver response returns.
function deliverMail(to: string, subject: string, body: string): Promise<Response> {
    const eml = ['From: sender@example.com', `To: ${to}`, `Subject: ${subject}`, '', body].join('\r\n');
    return app.handle(
        new Request(`http://localhost/mail/deliver/${to}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer,
        }),
    );
}

describe.skipIf(isWindows)('Mail search (Maildir)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('a delivered email is found by Maildir.search', async () => {
        const res = await deliverMail('alice@test.eigen.is', 'Zorptastic quarterly figures', 'body text');
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const hits = home.mail.search('zorptastic', 20);
        expect(hits.some((h) => h.subject === 'Zorptastic quarterly figures')).toBe(true);
    });

    test('search matches the sender address', async () => {
        await deliverMail('alice@test.eigen.is', 'plain subject one', 'hello');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        expect(home.mail.search('sender@example.com', 20).length).toBeGreaterThanOrEqual(1);
    });

    test('deleting an email removes it from search', async () => {
        await deliverMail('alice@test.eigen.is', 'Glompy deletion candidate', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search('glompy', 20)[0];
        expect(hit).toBeDefined();

        const del = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${hit.id}`, {
            method: 'DELETE',
        });
        expect([200, 204]).toContain(del.status);

        expect(home.mail.search('glompy', 20)).toEqual([]);
    });

    test('backfillSearchIndex re-runs cleanly and search still works', async () => {
        await deliverMail('alice@test.eigen.is', 'Wibblesome backfill subject', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        await home.mail.backfillSearchIndex();
        expect(home.mail.search('wibblesome', 20).length).toBeGreaterThanOrEqual(1);
    });
});

describe.skipIf(isWindows)('Search endpoint', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('GET /search returns a delivered email', async () => {
        await deliverMail('alice@test.eigen.is', 'Flibbertigibbet endpoint test', 'body');
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=flibbertigibbet`);
        const data = await assertJson<SearchResponse>(res);
        expect(data.mail.some((h) => h.subject === 'Flibbertigibbet endpoint test')).toBe(true);
    });

    test('sources=mail searches mail; sources=calendar returns an empty mail array', async () => {
        await deliverMail('alice@test.eigen.is', 'Snorkblat sources test', 'body');

        const mailRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=snorkblat&sources=mail`,
        );
        const mailData = await assertJson<SearchResponse>(mailRes);
        expect(mailData.mail.some((h) => h.subject === 'Snorkblat sources test')).toBe(true);

        const calRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=snorkblat&sources=calendar`,
        );
        const calData = await assertJson<SearchResponse>(calRes);
        expect(calData.mail).toEqual([]);
    });

    test("searching another user's ownerId is rejected with 403", async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/search/${ctx.alice.user.id}?q=anything`);
        expect(res.status).toBe(403);
    });

    test('a missing query is rejected with a validation error', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}`);
        expect(res.status).toBe(422);
    });

    test('a punctuation-only query does not error', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=${encodeURIComponent('!@#$%')}`,
        );
        const data = await assertJson<SearchResponse>(res);
        expect(data.mail).toEqual([]);
    });
});
