import { Database } from 'bun:sqlite';
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

function mailDoc(id: string, title: string, body: string, sortKey = Date.now(), bucket = ''): SearchDoc {
    return {
        kind: 'mail',
        itemId: id,
        bucket,
        title,
        body,
        sortKey,
    };
}

describe('SearchIndex', () => {
    test('upsert then query finds a hit by a title word', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'Quarterly budget review', 'numbers inside'));
        expect(index.query('budget', 10)).toEqual(['m1']);
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
        expect(index.query('second', 10)).toEqual(['m1']);
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

    test('higher sortKey orders ahead of lower sortKey for equally ranked hits', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'glimflub equal', 'body', 1000));
        index.upsert(mailDoc('m2', 'glimflub equal', 'body', 2000));
        expect(index.query('glimflub', 10)).toEqual(['m2', 'm1']);
    });

    test('query with buckets filter returns only matching-bucket hits', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'blarptastic sent mail', 'body', Date.now(), 'Sent'));
        index.upsert(mailDoc('m2', 'blarptastic inbox mail', 'body', Date.now(), ''));
        expect(index.query('blarptastic', 10, { buckets: ['Sent'] })).toEqual(['m1']);
    });

    test('query with excludeBuckets drops excluded-bucket hits', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'quibberised inbox mail', 'body', Date.now(), ''));
        index.upsert(mailDoc('m2', 'quibberised trash mail', 'body', Date.now(), 'Trash'));
        expect(index.query('quibberised', 10, { excludeBuckets: ['Trash'] })).toEqual(['m1']);
    });

    test('isEmpty reflects whether the index has rows', async () => {
        const index = await freshIndex();
        expect(index.isEmpty()).toBe(true);
        index.upsert(mailDoc('m1', 'subj', 'body'));
        expect(index.isEmpty()).toBe(false);
    });

    test('upsertBatch indexes every doc in one transaction and is idempotent', async () => {
        const index = await freshIndex();
        index.upsertBatch([
            mailDoc('m1', 'alpha report', 'body'),
            mailDoc('m2', 'beta report', 'body'),
            mailDoc('m3', 'gamma report', 'body'),
        ]);
        expect(index.query('report', 10)).toHaveLength(3);
        index.upsertBatch([mailDoc('m1', 'alpha report', 'body')]);
        expect(index.query('report', 10)).toHaveLength(3);
    });

    test('itemIds allowlist trims results to matching ids only', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'krimsonflux subject', 'body'));
        index.upsert(mailDoc('m2', 'krimsonflux subject', 'body'));
        index.upsert(mailDoc('m3', 'krimsonflux subject', 'body'));
        const ids = index.query('krimsonflux', 10, { itemIds: ['m1', 'm3'] });
        expect(ids.sort()).toEqual(['m1', 'm3']);
    });

    test('empty itemIds allowlist returns no results', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'verbosity', 'body'));
        expect(index.query('verbosity', 10, { itemIds: [] })).toEqual([]);
    });

    test('itemIds composes with excludeBuckets', async () => {
        const index = await freshIndex();
        index.upsert(mailDoc('m1', 'flarmsplork mail', 'body', Date.now(), ''));
        index.upsert(mailDoc('m2', 'flarmsplork mail', 'body', Date.now(), 'Trash'));
        index.upsert(mailDoc('m3', 'flarmsplork mail', 'body', Date.now(), ''));
        const ids = index.query('flarmsplork', 10, {
            itemIds: ['m1', 'm2'],
            excludeBuckets: ['Trash'],
        });
        expect(ids).toEqual(['m1']);
    });
});

const isWindows = process.platform === 'win32';

// Delivers an email and polls until it appears in the search index, making delivery-based
// tests deterministic. A filesystem-watcher-triggered sync can race the delivery's own sync
// (Maildir's syncingMailboxes dedup map joins an in-flight sync that may have snapshotted the
// directory before the new file was written). Polling with a fresh mailboxGet() call after any
// stale sync has resolved guarantees a new sync runs that picks up the file.
async function deliverMail(ownerId: string, to: string, subject: string, body: string): Promise<void> {
    const eml = ['From: sender@example.com', `To: ${to}`, `Subject: ${subject}`, '', body].join('\r\n');
    const res = await app.handle(
        new Request(`http://localhost/mail/deliver/${to}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer,
        }),
    );
    if (!res.ok) throw new Error(`deliverMail: POST failed with status ${res.status}`);

    const { getHome } = await import('../lib/home');
    // Use a distinctive word from the subject for the search probe.
    const probeWord = subject.split(/\s+/).find((w) => w.length >= 4) ?? subject;
    for (let i = 0; i < 40; i++) {
        const home = await getHome(ownerId);
        // Drive a fresh sync so any email sitting in new/ is indexed.
        await home.mail.mailboxGet('');
        const hits = home.mail.search({ q: probeWord, limit: 50 });
        if (hits.some((h) => h.subject === subject)) return;
        await Bun.sleep(25);
    }
    throw new Error(`deliverMail: '${subject}' was not indexed within the timeout`);
}

describe.skipIf(isWindows)('mail.db FTS5 schema', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('emails_fts virtual table exists and is populated after a mail delivery', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'FTS schema probe', 'body text');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const raw = new Database(`${home.homeDir}/eigen.mail/mail.db`, { readonly: true });
        try {
            const tbl = raw
                .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='emails_fts'")
                .get();
            expect(tbl?.name).toBe('emails_fts');

            const emails = raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM emails').get()!.n;
            const fts = raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM emails_fts').get()!.n;
            expect(emails).toBeGreaterThan(0);
            expect(fts).toBe(emails);
        } finally {
            raw.close();
        }
    });
});

describe.skipIf(isWindows)('Mail search (Maildir)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('a delivered email is found by Maildir.search', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Zorptastic quarterly figures', 'body text');

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const hits = home.mail.search({ q: 'zorptastic', limit: 20 });
        expect(hits.some((h) => h.subject === 'Zorptastic quarterly figures')).toBe(true);
    });

    test('search matches the sender address', async () => {
        const eml = [
            'From: "Some Sender" <distinctive.sender@example.com>',
            'To: alice@test.eigen.is',
            'Subject: plain subject one',
            '',
            'hello',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);
        const { getHome } = await import('../lib/home');
        let found = false;
        for (let i = 0; i < 40; i++) {
            const home = await getHome(ctx.alice.user.id);
            await home.mail.mailboxGet('');
            if (
                home.mail
                    .search({ q: 'distinctive.sender@example.com', limit: 20 })
                    .some((h) => h.subject === 'plain subject one')
            ) {
                found = true;
                break;
            }
            await Bun.sleep(25);
        }
        expect(found).toBe(true);
    });

    test('deleting an email removes it from search', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Glompy deletion candidate', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search({ q: 'glompy', limit: 20 })[0];
        expect(hit).toBeDefined();

        const del = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${hit.id}`, {
            method: 'DELETE',
        });
        expect([200, 204]).toContain(del.status);

        expect(home.mail.search({ q: 'glompy', limit: 20 })).toEqual([]);
    });

    test('backfillSearchIndex re-runs cleanly and search still works', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Wibblesome backfill subject', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        await home.mail.backfillSearchIndex();
        expect(
            home.mail.search({ q: 'wibblesome', limit: 20 }).some((h) => h.subject === 'Wibblesome backfill subject'),
        ).toBe(true);
    });

    test('search finds an email by sender address even when the sender has a display name', async () => {
        const eml = [
            'From: "Jane Doe" <jane.doe@example.com>',
            'To: alice@test.eigen.is',
            'Subject: lunch on friday',
            '',
            'see you then',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        // Poll until the delivered email is indexed (avoids the watcher/delivery sync race).
        const { getHome } = await import('../lib/home');
        let found = false;
        for (let i = 0; i < 40; i++) {
            const home = await getHome(ctx.alice.user.id);
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'jane.doe@example.com', limit: 20 }).length >= 1) {
                found = true;
                break;
            }
            await Bun.sleep(25);
        }
        expect(found).toBe(true);
    });

    test('search finds an email by its To recipient (display name and address)', async () => {
        const eml = [
            'From: sender@example.com',
            'To: "Bob Recipient" <bob.recipient@example.com>',
            'Subject: floopendish recipient test',
            '',
            'body text',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        for (let i = 0; i < 40; i += 1) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'floopendish', limit: 50 }).length > 0) break;
            await Bun.sleep(25);
        }
        const hits = home.mail.search({ q: 'bob.recipient@example.com', limit: 20 });
        expect(hits.some((h) => h.subject === 'floopendish recipient test')).toBe(true);
    });

    test('moving an email to Trash hides it from default search but not when Trash is requested', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Frobulated trash test', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search({ q: 'frobulated', limit: 20 })[0];
        expect(hit).toBeDefined();

        const move = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: hit.id, targetMailbox: 'Trash' }),
        });
        expect([200, 204]).toContain(move.status);

        expect(home.mail.search({ q: 'frobulated', limit: 20 })).toEqual([]);
        expect(
            home.mail.search({ q: 'frobulated', limit: 20, mailboxes: ['Trash'] }).some((h) => h.id === hit.id),
        ).toBe(true);
    });

    test('search finds an email by a CC recipient address', async () => {
        const eml = [
            'From: sender@example.com',
            'To: alice@test.eigen.is',
            'Cc: "Carol Ccperson" <distinctive.carol@example.com>',
            'Subject: Zorbiplex cc recipient test',
            '',
            'body text',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        let found = false;
        for (let i = 0; i < 40; i++) {
            const home = await getHome(ctx.alice.user.id);
            await home.mail.mailboxGet('');
            if (
                home.mail
                    .search({ q: 'distinctive.carol@example.com', limit: 20 })
                    .some((h) => h.subject === 'Zorbiplex cc recipient test')
            ) {
                found = true;
                break;
            }
            await Bun.sleep(25);
        }
        expect(found).toBe(true);
    });

    test('from filter respects default mailbox exclusion (Trash stays hidden)', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'fromexclude unique subject', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search({ q: 'fromexclude', limit: 20 })[0];
        expect(hit).toBeDefined();

        const move = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: hit.id, targetMailbox: 'Trash' }),
        });
        expect([200, 204]).toContain(move.status);

        // Default search excludes Trash even when from filter is active.
        expect(home.mail.search({ q: 'fromexclude', limit: 20, from: 'sender@example.com' })).toEqual([]);
        // Explicit Trash request reaches it.
        expect(
            home.mail
                .search({ q: 'fromexclude', limit: 20, from: 'sender@example.com', mailboxes: ['Trash'] })
                .some((h) => h.id === hit.id),
        ).toBe(true);
    });

    test('search with from filter returns only mails from that sender', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'fromfilter alpha subject', 'body');

        // Second delivery from a different sender that also contains "fromfilter".
        const eml = [
            'From: other@example.com',
            'To: alice@test.eigen.is',
            'Subject: fromfilter beta subject',
            '',
            'body text',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        // Poll until both rows are indexed.
        for (let i = 0; i < 40; i++) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'fromfilter', limit: 50 }).length >= 2) break;
            await Bun.sleep(25);
        }

        const filtered = home.mail.search({ q: 'fromfilter', limit: 20, from: 'sender@example.com' });
        expect(filtered.length).toBeGreaterThanOrEqual(1);
        expect(filtered.every((h) => h.fromAddress === 'sender@example.com')).toBe(true);
        expect(filtered.some((h) => h.subject === 'fromfilter alpha subject')).toBe(true);
        expect(filtered.some((h) => h.subject === 'fromfilter beta subject')).toBe(false);
    });

    test('search with to filter returns mails sent to that recipient', async () => {
        const eml = [
            'From: sender@example.com',
            'To: "Dee Specific" <dee.specific@example.com>',
            'Subject: tofilter dee subject',
            '',
            'body',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        for (let i = 0; i < 40; i++) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'tofilter', limit: 20 }).length >= 1) break;
            await Bun.sleep(25);
        }

        const hits = home.mail.search({ q: 'tofilter', limit: 20, to: 'dee.specific@example.com' });
        expect(hits.some((h) => h.subject === 'tofilter dee subject')).toBe(true);
    });

    test('from filter to a non-existent sender returns no hits', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'noresult unique subject', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        expect(home.mail.search({ q: 'noresult', limit: 20, from: 'nobody@nowhere.example' })).toEqual([]);
    });

    test('search by CC recipient address via the to filter', async () => {
        const eml = [
            'From: sender@example.com',
            'To: alice@test.eigen.is',
            'Cc: "Ed Distinctive" <ed.distinctive@example.com>',
            'Subject: ccfilter unique subject',
            '',
            'body',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        for (let i = 0; i < 40; i++) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'ccfilter', limit: 20 }).length >= 1) break;
            await Bun.sleep(25);
        }

        const hits = home.mail.search({ q: 'ccfilter', limit: 20, to: 'ed.distinctive@example.com' });
        expect(hits.some((h) => h.subject === 'ccfilter unique subject')).toBe(true);
    });
});

describe.skipIf(isWindows)('Search endpoint', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('GET /search returns a delivered email', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Flibbertigibbet endpoint test', 'body');
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=flibbertigibbet`);
        const data = await assertJson<SearchResponse>(res);
        expect(data.mail.some((h) => h.subject === 'Flibbertigibbet endpoint test')).toBe(true);
    });

    test('sources=mail searches mail; sources=calendar returns an empty mail array', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Snorkblat sources test', 'body');

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

    test('mailbox param scopes search to that mailbox only', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Splorbified inbox mail', 'body');

        const withMailbox = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=splorbified&mailbox=Sent`,
        );
        const withMailboxData = await assertJson<SearchResponse>(withMailbox);
        expect(withMailboxData.mail).toEqual([]);

        const noMailbox = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=splorbified`,
        );
        const noMailboxData = await assertJson<SearchResponse>(noMailbox);
        expect(noMailboxData.mail.some((h) => h.subject === 'Splorbified inbox mail')).toBe(true);
    });

    test('a query longer than 256 characters is rejected with a validation error', async () => {
        const longQ = 'a'.repeat(257);
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=${longQ}`);
        expect(res.status).toBe(422);
    });

    test('mailbox=Inbox and mailbox=inbox both scope search to the inbox bucket', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Quorbifax inbox normalise test', 'body');

        const upperRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=quorbifax&mailbox=Inbox`,
        );
        const upperData = await assertJson<SearchResponse>(upperRes);
        expect(upperData.mail.some((h) => h.subject === 'Quorbifax inbox normalise test')).toBe(true);

        const lowerRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=quorbifax&mailbox=inbox`,
        );
        const lowerData = await assertJson<SearchResponse>(lowerRes);
        expect(lowerData.mail.some((h) => h.subject === 'Quorbifax inbox normalise test')).toBe(true);
    });

    test('mailbox=trash (any case) reaches the Trash bucket', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'Crinkmore trash case test', 'body');
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search({ q: 'crinkmore', limit: 20 })[0];
        expect(hit).toBeDefined();

        const move = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: hit.id, targetMailbox: 'Trash' }),
        });
        expect([200, 204]).toContain(move.status);

        const upperRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=crinkmore&mailbox=Trash`,
        );
        const upperData = await assertJson<SearchResponse>(upperRes);
        expect(upperData.mail.some((h) => h.subject === 'Crinkmore trash case test')).toBe(true);

        const lowerRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=crinkmore&mailbox=trash`,
        );
        const lowerData = await assertJson<SearchResponse>(lowerRes);
        expect(lowerData.mail.some((h) => h.subject === 'Crinkmore trash case test')).toBe(true);
    });

    test('?from= forwards a sender filter to mail search', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'endpointfrom unique subject', 'body');

        // Second message from a different sender; same subject keyword.
        const eml = [
            'From: other@example.com',
            'To: alice@test.eigen.is',
            'Subject: endpointfrom another subject',
            '',
            'body',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        for (let i = 0; i < 40; i++) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'endpointfrom', limit: 20 }).length >= 2) break;
            await Bun.sleep(25);
        }

        const filtered = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=endpointfrom&from=${encodeURIComponent('sender@example.com')}`,
        );
        const data = await assertJson<SearchResponse>(filtered);
        expect(data.mail.some((h) => h.subject === 'endpointfrom unique subject')).toBe(true);
        expect(data.mail.some((h) => h.subject === 'endpointfrom another subject')).toBe(false);
    });

    test('?to= forwards a recipient filter to mail search', async () => {
        const eml = [
            'From: sender@example.com',
            'To: "Fred Tofilter" <fred.tofilter@example.com>',
            'Subject: endpointto fred subject',
            '',
            'body',
        ].join('\r\n');
        const res = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(res.status).toBe(200);

        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        for (let i = 0; i < 40; i++) {
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'endpointto', limit: 20 }).length >= 1) break;
            await Bun.sleep(25);
        }

        const filtered = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=endpointto&to=${encodeURIComponent('fred.tofilter@example.com')}`,
        );
        const data = await assertJson<SearchResponse>(filtered);
        expect(data.mail.some((h) => h.subject === 'endpointto fred subject')).toBe(true);
    });

    test('?from= with sources=calendar still returns an empty mail array (mail filters ignored when mail is excluded)', async () => {
        await deliverMail(ctx.alice.user.id, 'alice@test.eigen.is', 'endpointexcluded unique subject', 'body');

        const filtered = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=endpointexcluded&from=${encodeURIComponent('sender@example.com')}&sources=calendar`,
        );
        const data = await assertJson<SearchResponse>(filtered);
        expect(data.mail).toEqual([]);
    });

    test('?from= longer than 256 characters is rejected with a validation error', async () => {
        const longFrom = 'a'.repeat(257);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=anything&from=${encodeURIComponent(longFrom)}`,
        );
        expect(res.status).toBe(422);
    });
});
