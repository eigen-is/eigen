import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CARD_MAX_BYTES, computeCardEtag } from '../lib/contacts/card-store';
import { getHome } from '../lib/home';
import { app, getTestContext } from './setup';

describe('CardDAV', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;

    const basicAuth = (email: string, password = 'testpassword123') => `Basic ${btoa(`${email}:${password}`)}`;

    const propfind = (path: string, depth: string) =>
        app.handle(
            new Request(`http://localhost${path}`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: depth },
            }),
        );

    const cardUrl = (uri: string) => `http://localhost/dav/addressbooks/${userId}/contacts/${uri}`;

    const putCard = (uri: string, body: string, headers: Record<string, string> = {}) =>
        app.handle(
            new Request(cardUrl(uri), {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/vcard; charset=utf-8',
                    ...headers,
                },
                body,
            }),
        );

    const getCard = (uri: string) =>
        app.handle(
            new Request(cardUrl(uri), { method: 'GET', headers: { Authorization: basicAuth(ctx.alice.user.email) } }),
        );

    const deleteCard = (uri: string, headers: Record<string, string> = {}) =>
        app.handle(
            new Request(cardUrl(uri), {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email), ...headers },
            }),
        );

    // A minimal well-formed 3.0 card; extra lines splice in unowned/grouped properties for the fidelity cases.
    const vcard = (uid: string, extra: string[] = []) =>
        `${['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, 'N:Doe;John;;;', 'FN:John Doe', ...extra, 'END:VCARD'].join('\r\n')}\r\n`;

    // The seeded self-card asserts X-EIGEN-ID = the account id in its bytes and no test PUTs another, so a byte
    // scan over the public read API finds exactly it (used only to pin the self-delete 403 mapping).
    const findSelfCardUri = async (): Promise<string> => {
        const contacts = (await getHome(userId)).contacts;
        for (const c of await contacts.listCards()) {
            const got = await contacts.getCard(c.uri);
            if (got && new TextDecoder().decode(got.bytes).includes(`X-EIGEN-ID:${userId}`)) return c.uri;
        }
        throw new Error('self card not found');
    };

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;
    });

    test('OPTIONS advertises both addressbook and calendar-access on /dav', async () => {
        const res = await app.handle(new Request('http://localhost/dav/', { method: 'OPTIONS' }));
        expect([200, 204]).toContain(res.status);
        const dav = res.headers.get('DAV');
        expect(dav).toContain('addressbook');
        expect(dav).toContain('calendar-access');
    });

    test('OPTIONS on /webdav stays class 1, 2 (no calendar-access)', async () => {
        const res = await app.handle(new Request('http://localhost/webdav', { method: 'OPTIONS' }));
        expect([200, 204]).toContain(res.status);
        const dav = res.headers.get('DAV');
        expect(dav).toBe('1, 2');
        expect(dav).not.toContain('calendar-access');
    });

    test('PROPFIND principals carries addressbook-home-set and calendar-home-set', async () => {
        const res = await propfind(`/dav/principals/${userId}/`, '0');
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('addressbook-home-set');
        expect(xml).toContain(`/dav/addressbooks/${userId}/`);
        // Blast-radius: the shared principal still serves the calendar surface.
        expect(xml).toContain('calendar-home-set');
    });

    test('PROPFIND addressbook home Depth:1 lists the single book', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/`, '1');
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`/dav/addressbooks/${userId}/contacts/`);
        expect(xml).toContain('Addressbooks');
    });

    test('PROPFIND book Depth:0 exposes the collection props', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/contacts/`, '0');
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('supported-report-set');
        expect(xml).toContain('getctag');
        expect(xml).toContain('max-resource-size');
        expect(xml).toContain('5242880');
        expect(xml).toContain('supported-address-data');
        // Generation-stamped token: urn:eigen:sync:<syncGen>-<ctag>.
        expect(xml).toMatch(/urn:eigen:sync:\d+-\d+/);
    });

    test('PROPFIND book Depth:1 lists the seeded self-card with a quoted etag', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/contacts/`, '1');
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`/dav/addressbooks/${userId}/contacts/`);
        expect(xml).toContain('.vcf');
        expect(xml).toMatch(/<D:getetag>"[^"]+"<\/D:getetag>/);
    });

    test('PROPFIND an unknown book segment is 404', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/nope/`, '0');
        expect(res.status).toBe(404);
    });

    test('PROPFIND with more than two path segments is 400', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/contacts/x.vcf/extra`, '0');
        expect(res.status).toBe(400);
    });

    test('PROPFIND with malformed percent-encoding is 400', async () => {
        const res = await propfind(`/dav/addressbooks/${userId}/contacts/%zz.vcf`, '0');
        expect(res.status).toBe(400);
    });

    test('MKCOL under the addressbook tree is forbidden', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${userId}/newbook/`, {
                method: 'MKCOL',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(403);
    });

    test('MKADDRESSBOOK is forbidden — one fixed book per user', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${userId}/newbook/`, {
                method: 'MKADDRESSBOOK',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(403);
    });

    test('unauthenticated request carries the neutral DAV realm', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${userId}/`, { method: 'PROPFIND' }),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Eigen DAV"');
    });

    test('cross-user access is denied', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${ctx.bob.user.id}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        expect(res.status).toBe(403);
    });

    // --- Resource GET / PUT / DELETE (Task 15) — these pin the store-result → HTTP-status mapping and the
    // byte-identity contract, not the store logic proven in carddav-store.test.ts. ---

    test('PUT then GET returns byte-identical bytes with a matching quoted etag', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        // X-props, a grouped item1.EMAIL + item1.X-ABLabel, and a folded NOTE — the fidelity the store keeps verbatim.
        const body =
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nN:Hopper;Grace;;;\r\nFN:Grace Hopper\r\n` +
            `item1.EMAIL;TYPE=INTERNET:grace@example.org\r\nitem1.X-ABLabel:_$!<Work>!$_\r\n` +
            `X-SOCIALPROFILE;type=twitter:https://twitter.com/example\r\n` +
            `NOTE:a folded note that runs on for more than seventy five octets to force a co\r\n ntinuation line\r\nEND:VCARD\r\n`;

        const putRes = await putCard(uri, body, { 'If-None-Match': '*' });
        expect(putRes.status).toBe(201);
        const etag = putRes.headers.get('ETag');
        expect(etag).toMatch(/^"[^"]+"$/);
        expect(putRes.headers.get('Location')).toBe(`/dav/addressbooks/${userId}/contacts/${uri}`);

        const getRes = await getCard(uri);
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('Content-Type')).toBe('text/vcard; charset=utf-8');
        expect(await getRes.text()).toBe(body);
        expect(getRes.headers.get('ETag')).toBe(etag);
    });

    test('GET under an unknown book segment is 404 even for an existing card', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        expect((await putCard(uri, vcard(uid), { 'If-None-Match': '*' })).status).toBe(201);
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${userId}/bogus/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(404);
    });

    test('a second PUT without preconditions updates in place with 204 and a fresh etag', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const created = await putCard(uri, vcard(uid, ['EMAIL:one@example.org']), { 'If-None-Match': '*' });
        expect(created.status).toBe(201);
        const firstEtag = created.headers.get('ETag');

        const updated = await putCard(uri, vcard(uid, ['EMAIL:two@example.org']));
        expect(updated.status).toBe(204);
        const secondEtag = updated.headers.get('ETag');
        expect(secondEtag).toMatch(/^"[^"]+"$/);
        expect(secondEtag).not.toBe(firstEtag);
    });

    test('If-None-Match: * against an existing card maps to 412', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await putCard(uri, vcard(uid), { 'If-None-Match': '*' });
        const res = await putCard(uri, vcard(uid, ['EMAIL:x@example.org']), { 'If-None-Match': '*' });
        expect(res.status).toBe(412);
    });

    test('a stale If-Match maps to 412', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await putCard(uri, vcard(uid), { 'If-None-Match': '*' });
        const res = await putCard(uri, vcard(uid, ['EMAIL:x@example.org']), { 'If-Match': '"deadbeef"' });
        expect(res.status).toBe(412);
    });

    test('If-Match: * against an existing card succeeds (RFC 7232 exists check)', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await putCard(uri, vcard(uid), { 'If-None-Match': '*' });
        const res = await putCard(uri, vcard(uid, ['EMAIL:x@example.org']), { 'If-Match': '*' });
        expect(res.status).toBe(204);
    });

    test('a second uri claiming an owned UID maps to 412 no-uid-conflict', async () => {
        const uid = randomUUID();
        await putCard(`${uid}.vcf`, vcard(uid), { 'If-None-Match': '*' });
        const res = await putCard(`${randomUUID()}.vcf`, vcard(uid), { 'If-None-Match': '*' });
        expect(res.status).toBe(412);
        expect(await res.text()).toContain('no-uid-conflict');
    });

    test('a card with no UID maps to 400', async () => {
        const body = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:No;Uid;;;\r\nFN:No Uid\r\nEND:VCARD\r\n';
        const res = await putCard(`${randomUUID()}.vcf`, body, { 'If-None-Match': '*' });
        expect(res.status).toBe(400);
    });

    test('an oversize PUT maps to 413 max-resource-size', async () => {
        const uid = randomUUID();
        const prefix = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Big\r\nNOTE:`;
        const suffix = '\r\nEND:VCARD\r\n';
        const pad = CARD_MAX_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        const res = await putCard(`${uid}.vcf`, prefix + 'a'.repeat(pad) + suffix, { 'If-None-Match': '*' });
        expect(res.status).toBe(413);
        expect(await res.text()).toContain('max-resource-size');
    });

    test('traversal and malformed resource names map to 400 and store nothing', async () => {
        const names = [
            '..%2Fx.vcf', // decodes to ../x.vcf
            '.hidden.vcf', // leading dot
            'a%2Fb.vcf', // decodes to a/b.vcf
            `${'x'.repeat(300)}.vcf`, // over the 200-char cap
            'x.VCF', // uppercase suffix
            'x%0A.vcf', // embedded control character
            '%zz.vcf', // malformed percent-escape (rejected before decode)
        ];
        for (const name of names) {
            const res = await putCard(name, vcard(randomUUID()), { 'If-None-Match': '*' });
            expect(res.status).toBe(400);
        }
        const uris = (await (await getHome(userId)).contacts.listCards()).map((c) => c.uri);
        expect(uris).not.toContain('../x.vcf');
        expect(uris).not.toContain('a/b.vcf');
    });

    test('a percent-encoded resource name round-trips through PUT and GET', async () => {
        const uid = randomUUID();
        const putRes = await putCard('A%40B.vcf', vcard(uid), { 'If-None-Match': '*' });
        expect(putRes.status).toBe(201);
        expect(putRes.headers.get('Location')).toBe(`/dav/addressbooks/${userId}/contacts/A%40B.vcf`);

        const getRes = await getCard('A%40B.vcf');
        expect(getRes.status).toBe(200);
        expect(await getRes.text()).toBe(vcard(uid));
    });

    test('a 4.0 Thunderbird-shaped PUT is stored and served as 3.0', async () => {
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } } })
            .jpeg()
            .toBuffer();
        const b64 = jpeg.toString('base64');
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body = `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nN:Tesla;Nikola;;;\r\nFN:Nikola Tesla\r\nPHOTO:data:image/jpeg;base64,${b64}\r\nEND:VCARD\r\n`;

        const putRes = await putCard(uri, body, { 'If-None-Match': '*' });
        expect(putRes.status).toBe(201);
        const etag = putRes.headers.get('ETag');

        const getRes = await getCard(uri);
        expect(getRes.status).toBe(200);
        const stored = await getRes.text();
        expect(stored).not.toBe(body);
        expect(stored).toContain('VERSION:3.0');
        expect(stored).toContain('PHOTO;ENCODING=b');
        // The etag hashes the stored 3.0 bytes, so an honest client re-converges on the next fetch.
        expect(getRes.headers.get('ETag')).toBe(etag);
        expect(etag).toBe(`"${computeCardEtag(new TextEncoder().encode(stored))}"`);
    });

    test('DELETE removes a card and a subsequent GET is 404', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await putCard(uri, vcard(uid), { 'If-None-Match': '*' });

        const del = await deleteCard(uri);
        expect(del.status).toBe(204);
        expect((await getCard(uri)).status).toBe(404);
    });

    test('DELETE of an unknown card is 404 (DAV DELETE is not idempotent)', async () => {
        const res = await deleteCard(`${randomUUID()}.vcf`);
        expect(res.status).toBe(404);
    });

    test('DELETE with a stale If-Match maps to 412', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await putCard(uri, vcard(uid), { 'If-None-Match': '*' });
        const res = await deleteCard(uri, { 'If-Match': '"deadbeef"' });
        expect(res.status).toBe(412);
    });

    test('DELETE of the seeded self card maps to 403', async () => {
        const res = await deleteCard(await findSelfCardUri());
        expect(res.status).toBe(403);
    });

    // --- REPORTs (Task 16): addressbook-multiget + generation-stamped sync-collection. The addressbook-query
    // filter engine is Task 17; until then any query REPORT is answered with the honest supported-filter
    // precondition, so these pin the multiget byte-identity + the two CalDAV sync bugs the design must not
    // inherit (a future token stalling the client; a recreated href listed as both 200 and 404). ---

    const report = (body: string) =>
        app.handle(
            new Request(`http://localhost/dav/addressbooks/${userId}/contacts/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                    Depth: '1',
                },
                body,
            }),
        );

    const cardHref = (uri: string) => `/dav/addressbooks/${userId}/contacts/${uri}`;

    const multigetBody = (hrefs: string[], wantData = true) =>
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<CARD:addressbook-multiget xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">\n` +
        `<D:prop><D:getetag/>${wantData ? '<CARD:address-data/>' : ''}</D:prop>\n` +
        `${hrefs.map((h) => `<D:href>${h}</D:href>`).join('\n')}\n` +
        `</CARD:addressbook-multiget>`;

    const syncBody = (token?: string) =>
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<D:sync-collection xmlns:D="DAV:">\n` +
        `${token === undefined ? '<D:sync-token/>' : `<D:sync-token>${token}</D:sync-token>`}\n` +
        `<D:prop><D:getetag/></D:prop>\n` +
        `</D:sync-collection>`;

    // The <D:sync-token> the server appends after the responses (urn:eigen:sync:<syncGen>-<ctag>).
    const syncTokenOf = (xml: string) => xml.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)![1];

    test('addressbook-multiget returns address-data for existing hrefs and a 404 row for a missing one', async () => {
        const uidA = randomUUID();
        const uidB = randomUUID();
        const uriA = `${uidA}.vcf`;
        const uriB = `${uidB}.vcf`;
        const bodyA = vcard(uidA, ['EMAIL:a@example.org']);
        const bodyB = vcard(uidB, ['EMAIL:b@example.org']);
        expect((await putCard(uriA, bodyA, { 'If-None-Match': '*' })).status).toBe(201);
        expect((await putCard(uriB, bodyB, { 'If-None-Match': '*' })).status).toBe(201);
        const missing = `${randomUUID()}.vcf`;

        const res = await report(multigetBody([cardHref(uriA), cardHref(uriB), cardHref(missing)]));
        expect(res.status).toBe(207);
        const xml = await res.text();
        // address-data is XML-escaped, but these bodies carry no XML-special chars, so they appear verbatim.
        expect(xml).toContain(bodyA);
        expect(xml).toContain(bodyB);
        expect(xml).toContain(cardHref(missing));
        expect(xml).toContain('404 Not Found');
    });

    test('addressbook-multiget resolves a percent-encoded href', async () => {
        const uid = randomUUID();
        const body = vcard(uid);
        // P%40Q.vcf decodes to P@Q.vcf — a name the server must percent-decode before matching and re-encode
        // on emission (unlike CalDAV, where server-generated uris never need it).
        expect((await putCard('P%40Q.vcf', body, { 'If-None-Match': '*' })).status).toBe(201);

        const res = await report(multigetBody([cardHref('P%40Q.vcf')]));
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(body);
        expect(xml).toContain(cardHref('P%40Q.vcf'));
    });

    test('addressbook-multiget without address-data returns etags only', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        expect((await putCard(uri, vcard(uid), { 'If-None-Match': '*' })).status).toBe(201);

        const res = await report(multigetBody([cardHref(uri)], false));
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('<D:getetag>');
        expect(xml).not.toContain('address-data');
    });

    test('addressbook-multiget with more than 500 hrefs is 400', async () => {
        const hrefs = Array.from({ length: 501 }, () => cardHref(`${randomUUID()}.vcf`));
        const res = await report(multigetBody(hrefs));
        expect(res.status).toBe(400);
    });

    test('a REPORT body over 1 MiB is 413 before parsing', async () => {
        const res = await report('a'.repeat(1_048_577));
        expect(res.status).toBe(413);
    });

    test('sync-collection without a token lists all cards and a generation-stamped token', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        expect((await putCard(uri, vcard(uid), { 'If-None-Match': '*' })).status).toBe(201);

        const res = await report(syncBody());
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(cardHref(uri));
        expect(syncTokenOf(xml)).toMatch(/^urn:eigen:sync:\d+-\d+$/);
    });

    test('sync-collection from a prior token returns exactly the card changed since it', async () => {
        const uidA = randomUUID();
        const uriA = `${uidA}.vcf`;
        expect((await putCard(uriA, vcard(uidA), { 'If-None-Match': '*' })).status).toBe(201);
        const token = syncTokenOf(await (await report(syncBody())).text());

        const uidB = randomUUID();
        const uriB = `${uidB}.vcf`;
        expect((await putCard(uriB, vcard(uidB), { 'If-None-Match': '*' })).status).toBe(201);

        const xml = await (await report(syncBody(token))).text();
        expect(xml).toContain(cardHref(uriB));
        expect(xml).not.toContain(cardHref(uriA));
    });

    test('sync-collection reports a deleted card as a 404 row', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        expect((await putCard(uri, vcard(uid), { 'If-None-Match': '*' })).status).toBe(201);
        const token = syncTokenOf(await (await report(syncBody())).text());

        expect((await deleteCard(uri)).status).toBe(204);

        const xml = await (await report(syncBody(token))).text();
        expect(xml).toContain(cardHref(uri));
        expect(xml).toContain('404 Not Found');
    });

    test('sync-collection lists a delete-then-recreate as a single 200 with no 404 row', async () => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        expect((await putCard(uri, vcard(uid), { 'If-None-Match': '*' })).status).toBe(201);
        const token = syncTokenOf(await (await report(syncBody())).text());

        expect((await deleteCard(uri)).status).toBe(204);
        expect((await putCard(uri, vcard(uid, ['EMAIL:again@example.org']), { 'If-None-Match': '*' })).status).toBe(
            201,
        );

        const xml = await (await report(syncBody(token))).text();
        expect(xml).toContain(cardHref(uri));
        expect(xml).not.toContain('404 Not Found');
    });

    test('sync-collection with a stale generation token is 412 valid-sync-token', async () => {
        const res = await report(syncBody('urn:eigen:sync:0-1'));
        expect(res.status).toBe(412);
        expect(await res.text()).toContain('valid-sync-token');
    });

    test('sync-collection with a future ctag token is 412 valid-sync-token', async () => {
        const token = syncTokenOf(await (await report(syncBody())).text());
        const [, gen, ctag] = token.match(/^urn:eigen:sync:(\d+)-(\d+)$/)!;
        const future = `urn:eigen:sync:${gen}-${Number(ctag) + 999}`;
        const res = await report(syncBody(future));
        expect(res.status).toBe(412);
        expect(await res.text()).toContain('valid-sync-token');
    });

    test('sync-collection with a malformed token is 412 valid-sync-token', async () => {
        for (const token of ['urn:eigen:sync:abc', 'nonsense']) {
            const res = await report(syncBody(token));
            expect(res.status).toBe(412);
            expect(await res.text()).toContain('valid-sync-token');
        }
    });

    test('an addressbook-query is answered with the interim supported-filter precondition', async () => {
        const body =
            `<?xml version="1.0" encoding="utf-8"?>\n` +
            `<CARD:addressbook-query xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">\n` +
            `<D:prop><D:getetag/><CARD:address-data/></D:prop>\n` +
            `<CARD:filter><CARD:prop-filter name="FN">` +
            `<CARD:text-match collation="i;unicode-casemap" match-type="contains">bob</CARD:text-match>` +
            `</CARD:prop-filter></CARD:filter>\n` +
            `</CARD:addressbook-query>`;
        const res = await report(body);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('supported-filter');
    });
});
