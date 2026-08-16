import { beforeAll, describe, expect, test } from 'bun:test';
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
});
