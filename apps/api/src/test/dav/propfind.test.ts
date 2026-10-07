import { describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { parsePropfind, selectProps } from '../../lib/dav/propfind';
import * as davXml from '../../lib/dav/xml';

const propfind = (props: string) =>
    new TextEncoder().encode(
        `<D:propfind xmlns:D="DAV:" xmlns:X="urn:example:x"><D:prop>${props}</D:prop></D:propfind>`,
    );

const distinct = (count: number) => Array.from({ length: count }, (_, i) => `<X:p${i}/>`).join('');

const memberRow = (etag: string) => davXml.memberRowProps(etag, 'text/calendar');

describe('parsePropfind', () => {
    test('a prop asked for twice, under any prefix, is answered once', () => {
        const request = parsePropfind(propfind('<D:getetag/><X:a/><D:getetag/><y:getetag xmlns:y="DAV:"/><X:a/>'));
        const [found, missing] = selectProps(memberRow('e'), request, false);
        expect(found.match(/<D:getetag>/g)).toHaveLength(1);
        expect(missing.match(/<X:a /g)).toHaveLength(1);
    });

    test('1,000 distinct props are read, a 1,001st is a 400, and a repeat does not count', () => {
        expect(parsePropfind(propfind(distinct(1000))).allprop).toBe(false);
        expect(parsePropfind(propfind(`${distinct(1000)}<X:p0/>`)).allprop).toBe(false);
        let refused: unknown;
        try {
            parsePropfind(propfind(distinct(1001)));
        } catch (error) {
            refused = error;
        }
        expect(refused).toBeInstanceOf(ApiError);
        expect((refused as ApiError).status).toBe(400);
    });
});

describe('selectProps', () => {
    test('rows of one shape answer one 404 propstat, built once per request', () => {
        const request = parsePropfind(propfind('<D:getetag/><X:a/><X:b/>'));
        const notFound = spyOn(davXml, 'propstatNotFound');
        const rows = ['e1', 'e2', 'e3'].map((etag) => selectProps(memberRow(etag), request, false));
        expect(rows[0][1]).toContain('<X:a xmlns:X="urn:example:x"/><X:b xmlns:X="urn:example:x"/>');
        expect(new Set(rows.map((row) => row[1])).size).toBe(1);
        expect(notFound).toHaveBeenCalledTimes(1);
        notFound.mockRestore();
    });
});
