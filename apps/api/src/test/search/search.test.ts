import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SearchResponse } from '@workspace/lib/types/search';
import {
    app,
    assertJson,
    authedRequest,
    driveDelete,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
} from '../setup';

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

    const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
        const home = await getHome(ctx.alice.user.id);

        const hit = home.mail.search({ q: 'glompy', limit: 20 })[0];
        expect(hit).toBeDefined();

        const del = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${hit.id}`, {
            method: 'DELETE',
        });
        expect([200, 204]).toContain(del.status);

        expect(home.mail.search({ q: 'glompy', limit: 20 })).toEqual([]);
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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

        const { getHome } = await import('../../lib/home');
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

// Drive tests run on Windows (unlike the mail blocks above) — drive ops bypass the
// maildir filesystem-watcher races that force the mail tests' skipIf(isWindows).
describe('Drive search', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;
    let home: Awaited<ReturnType<typeof import('../../lib/home').getHome>>;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        const { getHome } = await import('../../lib/home');
        home = await getHome(ctx.alice.user.id);
    });

    async function createFolder(folderName: string): Promise<string> {
        const folder = await drivePost<{ id: string }>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName },
        );
        return folder.id;
    }

    test('paths_fts virtual table stays in sync with paths', async () => {
        await createFolder('ftsschemaprobe folder');

        const raw = new Database(`${home.homeDir}/mounts/${mountId}/metadata.db`, { readonly: true });
        try {
            const tbl = raw
                .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='paths_fts'")
                .get();
            expect(tbl?.name).toBe('paths_fts');

            const total = raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM paths').get()!.n;
            const indexed = raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM paths_fts').get()!.n;
            expect(total).toBeGreaterThan(0);
            expect(indexed).toBe(total);
        } finally {
            raw.close();
        }
    });

    test('a created folder is found by Drive.search', async () => {
        const id = await createFolder('zorptastic search folder');
        expect(home.drive.search({ q: 'zorptastic', limit: 20 }).some((h) => h.id === id)).toBe(true);
    });

    test('an uploaded file is found by Drive.search', async () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'glompy-report.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        expect(home.drive.search({ q: 'glompy', limit: 20 }).some((h) => h.id === uploaded.id)).toBe(true);
    });

    test('renaming a folder removes the old name and indexes the new one', async () => {
        const id = await createFolder('frobnicate before');
        expect(home.drive.search({ q: 'frobnicate', limit: 20 }).some((h) => h.id === id)).toBe(true);

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${id}/rename`, {
            newName: 'snorkblat after',
        });

        expect(home.drive.search({ q: 'frobnicate', limit: 20 })).toEqual([]);
        expect(home.drive.search({ q: 'snorkblat', limit: 20 }).some((h) => h.id === id)).toBe(true);
    });

    test('trashing a folder removes it from search', async () => {
        const id = await createFolder('crinklepuff trash candidate');
        expect(home.drive.search({ q: 'crinklepuff', limit: 20 }).some((h) => h.id === id)).toBe(true);

        await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${id}`);

        expect(home.drive.search({ q: 'crinklepuff', limit: 20 })).toEqual([]);
    });

    test('the root folder is not returned as a result', async () => {
        const root = await home.drive.getRootFolder(mountId);
        expect(root).not.toBeNull();
        const hits = home.drive.search({ q: root!.name, limit: 20 });
        expect(hits.some((h) => h.id === root!.id)).toBe(false);
    });

    test('a punctuation-only query returns no results', () => {
        expect(home.drive.search({ q: '!@#$%', limit: 20 })).toEqual([]);
    });

    test('files inside an eigendoc container are excluded from search', async () => {
        const container = await home.drive.create(mountId, rootId, 'zonkblat container', 'doc');
        await home.drive.touchFile(mountId, container.id, 'zonkblat-internal.dat', 'application/octet-stream');

        // The container itself is searchable by its own name…
        expect(home.drive.search({ q: 'zonkblat container', limit: 20 }).some((h) => h.id === container.id)).toBe(true);

        // …but its internal file row is hidden — search by the internal's unique name
        // returns nothing, even though the row exists in the paths table.
        expect(home.drive.search({ q: 'zonkblat-internal', limit: 20 })).toEqual([]);
    });

    test('GET /search returns a created folder under file', async () => {
        const id = await createFolder('flibbertigibbet endpoint folder');
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=flibbertigibbet`);
        const data = await assertJson<SearchResponse>(res);
        expect(data.file.some((h) => h.id === id)).toBe(true);
    });

    test('sources=file searches drive; sources=mail returns an empty file array', async () => {
        const id = await createFolder('splorbified sources folder');

        const fileRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=splorbified&sources=file`,
        );
        const fileData = await assertJson<SearchResponse>(fileRes);
        expect(fileData.file.some((h) => h.id === id)).toBe(true);

        const mailRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?q=splorbified&sources=mail`,
        );
        const mailData = await assertJson<SearchResponse>(mailRes);
        expect(mailData.file).toEqual([]);
    });

    test('default (no sources) returns both mail and file arrays', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=anything`);
        const data = await assertJson<SearchResponse>(res);
        expect(Array.isArray(data.mail)).toBe(true);
        expect(Array.isArray(data.file)).toBe(true);
    });

    test("searching another user's drive is rejected with 403", async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/search/${ctx.alice.user.id}?q=anything`);
        expect(res.status).toBe(403);
    });
});
