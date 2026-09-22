import { describe, expect, test } from 'bun:test';
import { memberProps, memberRowProps, notFoundRow, removedRow } from '../../lib/dav/xml';

// The response rows and member properties both DAV surfaces emit. The two 404 shapes are not
// interchangeable — a multiget miss names the prop it could not serve, a sync-collection removal
// carries a bare status — so they are pinned here rather than once per protocol.

describe('the two 404 rows', () => {
    test('a multiget miss answers a 404 propstat naming getetag', () => {
        expect(notFoundRow('/dav/calendars/u1/work/gone.ics')).toBe(
            '<D:response><D:href>/dav/calendars/u1/work/gone.ics</D:href>' +
                '<D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>' +
                '</D:response>',
        );
    });

    test('a sync-collection removal is a bare status, with no propstat (RFC 6578)', () => {
        expect(removedRow('/dav/addressbooks/u1/contacts/gone.vcf')).toBe(
            '<D:response><D:href>/dav/addressbooks/u1/contacts/gone.vcf</D:href>' +
                '<D:status>HTTP/1.1 404 Not Found</D:status></D:response>',
        );
    });

    test('both escape the href, which carries a client-chosen name', () => {
        expect(notFoundRow('/c/a&b.ics')).toContain('<D:href>/c/a&amp;b.ics</D:href>');
        expect(removedRow('/c/a&b.ics')).toContain('<D:href>/c/a&amp;b.ics</D:href>');
    });
});

describe('member properties', () => {
    test('a REPORT row carries the quoted etag and the collection content type', () => {
        expect(memberProps('abc', 'text/vcard')).toEqual([
            '<D:getetag>"abc"</D:getetag>',
            '<D:getcontenttype>text/vcard</D:getcontenttype>',
        ]);
    });

    test('a PROPFIND row adds the empty resourcetype that marks a non-collection member', () => {
        expect([...memberRowProps('abc', 'text/calendar')]).toEqual([
            ['getetag', '<D:getetag>"abc"</D:getetag>'],
            ['getcontenttype', '<D:getcontenttype>text/calendar</D:getcontenttype>'],
            ['resourcetype', '<D:resourcetype/>'],
        ]);
    });

    test('the two views spell one etag, escaped', () => {
        expect(memberRowProps('a<b', 'text/vcard').get('getetag')).toBe(memberProps('a<b', 'text/vcard')[0]);
        expect(memberProps('a<b', 'text/vcard')[0]).toBe('<D:getetag>"a&lt;b"</D:getetag>');
    });
});
