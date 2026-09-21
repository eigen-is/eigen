import { describe, expect, test } from 'bun:test';
import { davDeleteResponse, davPutResponse } from '../../lib/dav/write-result';

// The store result → HTTP mapping both DAV write surfaces share. CardDAV drives it through the route in
// carddav.test.ts; this pins every branch and the protocol parameters the CalDAV twin passes.

const BOOK = '/dav/addressbooks/alice/contacts/';
const CALENDAR = '/dav/calendars/alice/personal/';

describe('davPutResponse', () => {
    test('a create answers 201 with the quoted etag and a Location under the collection', () => {
        const res = davPutResponse({ ok: true, etag: 'abc', created: true }, 'CARD', BOOK, 'a@b.vcf');
        expect(res.status).toBe(201);
        expect(res.headers.get('ETag')).toBe('"abc"');
        // @ is pchar-legal, so the emitted href carries it raw.
        expect(res.headers.get('Location')).toBe(`${BOOK}a@b.vcf`);
    });

    test('a replace answers 204 with the etag and no Location', () => {
        const res = davPutResponse({ ok: true, etag: 'abc', created: false }, 'CARD', BOOK, 'x.vcf');
        expect(res.status).toBe(204);
        expect(res.headers.get('ETag')).toBe('"abc"');
        expect(res.headers.get('Location')).toBeNull();
    });

    test('a precondition failure answers a bodyless 412', async () => {
        const res = davPutResponse({ ok: false, error: 'precondition' }, 'CARD', BOOK, 'x.vcf');
        expect(res.status).toBe(412);
        expect(await res.text()).not.toContain('<');
    });

    test('a uid conflict answers 409 naming the resource that holds the UID', async () => {
        const res = davPutResponse({ ok: false, error: 'uid-conflict', conflictUri: 'a@b.vcf' }, 'CARD', BOOK, 'x.vcf');
        expect(res.status).toBe(409);
        expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
        expect(await res.text()).toContain(
            `<CARD:no-uid-conflict><D:href>${BOOK}a@b.vcf</D:href></CARD:no-uid-conflict>`,
        );
    });

    test('a uid conflict with no other holder answers the bare 409 element', async () => {
        const res = davPutResponse({ ok: false, error: 'uid-conflict' }, 'CARD', BOOK, 'x.vcf');
        expect(res.status).toBe(409);
        const xml = await res.text();
        expect(xml).toContain('<CARD:no-uid-conflict/>');
        expect(xml).not.toContain('D:href');
    });

    test('an oversize body answers 413 max-resource-size', async () => {
        const res = davPutResponse({ ok: false, error: 'too-large' }, 'CARD', BOOK, 'x.vcf');
        expect(res.status).toBe(413);
        expect(await res.text()).toContain('<CARD:max-resource-size/>');
    });

    test('a quota refusal answers 507', () => {
        expect(davPutResponse({ ok: false, error: 'quota' }, 'CARD', BOOK, 'x.vcf').status).toBe(507);
    });

    test('an invalid body answers 400, carrying the store message when it has one', async () => {
        const plain = davPutResponse({ ok: false, error: 'invalid' }, 'CARD', BOOK, 'x.vcf');
        expect(plain.status).toBe(400);
        expect(await plain.text()).toBe('Bad Request');

        const detailed = davPutResponse(
            { ok: false, error: 'invalid', message: 'UID is required' },
            'CARD',
            BOOK,
            'x.vcf',
        );
        expect(detailed.status).toBe(400);
        expect(await detailed.text()).toBe('UID is required');
    });

    test('the CalDAV parameters emit the same preconditions in the C namespace and calendar hrefs', async () => {
        const conflict = davPutResponse(
            { ok: false, error: 'uid-conflict', conflictUri: 'held.ics' },
            'C',
            CALENDAR,
            'mine.ics',
        );
        expect(conflict.status).toBe(409);
        expect(await conflict.text()).toContain(
            `<C:no-uid-conflict><D:href>${CALENDAR}held.ics</D:href></C:no-uid-conflict>`,
        );

        const created = davPutResponse({ ok: true, etag: 'abc', created: true }, 'C', CALENDAR, 'mine.ics');
        expect(created.headers.get('Location')).toBe(`${CALENDAR}mine.ics`);
    });
});

describe('davDeleteResponse', () => {
    test('maps the three shared outcomes', () => {
        expect(davDeleteResponse({ ok: true }).status).toBe(204);
        expect(davDeleteResponse({ ok: false, error: 'not-found' }).status).toBe(404);
        expect(davDeleteResponse({ ok: false, error: 'precondition' }).status).toBe(412);
    });
});
