import { beforeAll, describe, expect, test } from 'bun:test';
import { app, authedRequest, getTestContext, type TestContext } from '../setup';

const basicAuth = (email: string, password = 'testpassword123') => `Basic ${btoa(`${email}:${password}`)}`;

// Pins the ingest path a Mac depends on for WEB-created contacts: a card added through the
// REST/app path must appear in the next sync-collection delta and be multiget-fetchable —
// the half-bound Apple duplicate hunt (2026-08-18) needed proof this seam is whole.
describe('carddav sync-collection sees web-created contacts', () => {
    let ctx: TestContext;
    let userId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;
    });

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

    const syncBody = (token?: string) =>
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<D:sync-collection xmlns:D="DAV:">\n` +
        `${token === undefined ? '<D:sync-token/>' : `<D:sync-token>${token}</D:sync-token>`}\n` +
        `<D:prop><D:getetag/></D:prop>\n` +
        `</D:sync-collection>`;

    const multigetBody = (hrefs: string[]) =>
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<CARD:addressbook-multiget xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">\n` +
        `<D:prop><D:getetag/><CARD:address-data/></D:prop>\n` +
        `${hrefs.map((h) => `<D:href>${h}</D:href>`).join('\n')}\n` +
        `</CARD:addressbook-multiget>`;

    test('a REST-created contact appears in the delta from the pre-create token and multigets whole', async () => {
        const before = await report(syncBody());
        expect(before.status).toBe(207);
        const beforeXml = await before.text();
        const token = beforeXml.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)?.[1];
        expect(token).toBeTruthy();
        const beforeHrefs = new Set([...beforeXml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]));

        const createRes = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${userId}/contacts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName: 'Webbie', lastName: 'Sync', email: ['webbie@example.com'], phone: [] }),
        });
        expect(createRes.status).toBe(200);

        const delta = await report(syncBody(token));
        expect(delta.status).toBe(207);
        const deltaXml = await delta.text();
        const deltaHrefs = [...deltaXml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]);
        const newHref = deltaHrefs.find((h) => h.endsWith('.vcf') && !beforeHrefs.has(h));
        expect(newHref).toBeTruthy();
        expect(deltaXml).toContain('200 OK');

        const mg = await report(multigetBody([newHref as string]));
        expect(mg.status).toBe(207);
        const mgXml = await mg.text();
        expect(mgXml).toContain('FN:Webbie Sync');
        expect(mgXml).toContain('200 OK');
    });
});
