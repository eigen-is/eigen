import { describe, expect, test } from 'bun:test';
import { uriKeyOf } from '../../lib/core';
import { MULTIGET_HREF_LIMIT, parseCollectionPath, principalHref, resolveMultigetHrefs } from '../../lib/dav/href';

// The path and href rules both DAV surfaces route on. A divergence here is a misroute or a duplicated
// multiget row on one protocol only, which is exactly what a per-protocol copy used to hide.

describe('parseCollectionPath', () => {
    test('splits a wildcard into the collection and its optional resource', () => {
        expect(parseCollectionPath('contacts/ann.vcf')).toEqual({
            ok: true,
            collection: 'contacts',
            resource: 'ann.vcf',
        });
        expect(parseCollectionPath('work')).toEqual({ ok: true, collection: 'work', resource: null });
        expect(parseCollectionPath('')).toEqual({ ok: true, collection: null, resource: null });
    });

    test('ignores leading, trailing and repeated slashes', () => {
        expect(parseCollectionPath('/contacts/')).toEqual({ ok: true, collection: 'contacts', resource: null });
        expect(parseCollectionPath('//contacts//ann.vcf//')).toEqual({
            ok: true,
            collection: 'contacts',
            resource: 'ann.vcf',
        });
    });

    test('percent-decodes every segment, because both are client-chosen', () => {
        expect(parseCollectionPath('my%20book/a%40b.vcf')).toEqual({
            ok: true,
            collection: 'my book',
            resource: 'a@b.vcf',
        });
    });

    test('a third segment or a malformed escape is a client error, never a silent misroute', () => {
        expect(parseCollectionPath('contacts/sub/ann.vcf')).toEqual({ ok: false });
        expect(parseCollectionPath('contacts/%zz.vcf')).toEqual({ ok: false });
    });
});

describe('resolveMultigetHrefs', () => {
    const prefix = '/dav/calendars/u1/work/';

    test('resolves an in-collection href to its decoded uri and keeps request order', () => {
        expect(resolveMultigetHrefs([`${prefix}a%40b.ics`, `${prefix}c.ics`], prefix, (u) => u)).toEqual([
            { uri: 'a@b.ics', href: `${prefix}a%40b.ics` },
            { uri: 'c.ics', href: `${prefix}c.ics` },
        ]);
    });

    test('an out-of-collection href, a bare collection href and a malformed escape all resolve to null', () => {
        expect(
            resolveMultigetHrefs(['/dav/calendars/u1/other/a.ics', prefix, `${prefix}%zz`], prefix, (u) => u),
        ).toEqual([
            { uri: null, href: '/dav/calendars/u1/other/a.ics' },
            { uri: null, href: prefix },
            { uri: null, href: `${prefix}%zz` },
        ]);
    });

    test('one row per resource: the same href listed twice, and two spellings of one path', () => {
        expect(
            resolveMultigetHrefs([`${prefix}a.ics`, `//${prefix}a.ics`, `${prefix}a.ics`], prefix, (u) => u),
        ).toEqual([{ uri: 'a.ics', href: `${prefix}a.ics` }]);
    });

    test('repeated unresolvable hrefs collapse too, keyed apart from a stored uri spelled `raw:`', () => {
        expect(resolveMultigetHrefs(['/elsewhere', '/elsewhere', `${prefix}raw:/elsewhere`], prefix, (u) => u)).toEqual(
            [
                { uri: null, href: '/elsewhere' },
                { uri: 'raw:/elsewhere', href: `${prefix}raw:/elsewhere` },
            ],
        );
    });

    test('the collection folds its own uris: case and Unicode form are one card, not two rows', () => {
        expect(resolveMultigetHrefs([`${prefix}Ann.vcf`, `${prefix}ann.vcf`], prefix, uriKeyOf)).toEqual([
            { uri: 'Ann.vcf', href: `${prefix}Ann.vcf` },
        ]);
    });

    test('bounds one round-trip at 500 resources', () => {
        expect(MULTIGET_HREF_LIMIT).toBe(500);
    });
});

describe('principalHref', () => {
    test('one spelling of the principal URL every collection and prop points at', () => {
        expect(principalHref('u1')).toBe('/dav/principals/u1/');
    });
});
