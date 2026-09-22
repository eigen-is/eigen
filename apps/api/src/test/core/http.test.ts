import { describe, expect, test } from 'bun:test';
import {
    contentDisposition,
    matchesIfMatch,
    matchesIfNoneMatch,
    parseByteRange,
    rangeResponse,
    scriptableInlineHeaders,
} from '../../lib/core/http';

const SANDBOX_CSP = "sandbox; default-src 'none'";

describe('scriptableInlineHeaders', () => {
    test('sandboxes HTML, with the charset parameter along for the ride', () => {
        expect(scriptableInlineHeaders('text/html')['Content-Security-Policy']).toBe(SANDBOX_CSP);
        expect(scriptableInlineHeaders('text/html; charset=utf-8')['Content-Security-Policy']).toBe(SANDBOX_CSP);
        expect(scriptableInlineHeaders('TEXT/HTML')['Content-Security-Policy']).toBe(SANDBOX_CSP);
    });

    test('sandboxes every XML flavour, whose xml-stylesheet PI runs XSLT', () => {
        for (const type of ['text/xml', 'application/xml', 'image/svg+xml', 'application/xhtml+xml', 'text/foo+xml']) {
            expect(scriptableInlineHeaders(type)['Content-Security-Policy']).toBe(SANDBOX_CSP);
        }
    });

    test('adds nosniff alongside the CSP', () => {
        expect(scriptableInlineHeaders('image/svg+xml')['X-Content-Type-Options']).toBe('nosniff');
    });

    test('leaves non-scriptable types unheadered so callers can spread unconditionally', () => {
        for (const type of ['image/png', 'application/pdf', 'video/mp4', 'text/plain', 'application/xml-dtd']) {
            expect(scriptableInlineHeaders(type)).toEqual({});
        }
    });
});

// A calendar SUMMARY, a vCard FN, a stored file name and a mail part's name all reach this helper as user
// text, and what it emits is the name the client writes to disk.
describe('contentDisposition', () => {
    test('no path reaches either filename form', () => {
        expect(contentDisposition('attachment', '../../../etc/passwd.ics')).toBe(
            'attachment; filename=".._.._.._etc_passwd.ics"',
        );
        expect(contentDisposition('attachment', 'a/b\\c.txt')).toBe('attachment; filename="a_b_c.txt"');
        expect(contentDisposition('attachment', '..\\..\\win.ini')).toBe('attachment; filename=".._.._win.ini"');
        expect(contentDisposition('attachment', '.hidden.ics')).toBe('attachment; filename=".hidden.ics"');
    });

    test('a name that sanitizes to nothing falls back to a neutral one', () => {
        expect(contentDisposition('attachment', '..')).toBe('attachment; filename="download"');
        expect(contentDisposition('attachment', '')).toBe('attachment; filename="download"');
    });

    test('a control character cannot split the header, in either form', () => {
        expect(contentDisposition('attachment', 'note\r\nX-Evil: 1.ics')).toBe(
            'attachment; filename="note__X-Evil: 1.ics"',
        );
        expect(contentDisposition('attachment', 'p\u0000ä.txt')).toBe(
            `attachment; filename="p__.txt"; filename*=UTF-8''${encodeURIComponent('p_ä.txt')}`,
        );
    });

    test('spaces, dots and unicode inside the name come out untouched', () => {
        expect(contentDisposition('attachment', 'Q1 report.final.pdf')).toBe(
            'attachment; filename="Q1 report.final.pdf"',
        );
        expect(contentDisposition('inline', 'räp"ort.txt')).toBe(
            `inline; filename="r_p_ort.txt"; filename*=UTF-8''${encodeURIComponent('räp"ort.txt')}`,
        );
    });

    test('a clamp that cut a surrogate pair in half still spells a header', () => {
        expect(contentDisposition('attachment', `${'a'.repeat(3)}\ud83d`)).toContain("filename*=UTF-8''aaa%EF%BF%BD");
    });
});

// Every conditional surface (WebDAV, CalDAV, CardDAV, drive, mail) compares the quoted wire form,
// so the DAV twins quote their stored bare hash before asking.
const ETAG = '"sha-256-hash"';

describe('matchesIfMatch', () => {
    test('* means "the resource exists", never a literal tag', () => {
        expect(matchesIfMatch('*', ETAG)).toBe(true);
        expect(matchesIfMatch('*', null)).toBe(false);
    });

    test('matches the current quoted tag and nothing else', () => {
        expect(matchesIfMatch(ETAG, ETAG)).toBe(true);
        expect(matchesIfMatch('"deadbeef"', ETAG)).toBe(false);
        expect(matchesIfMatch(ETAG, null)).toBe(false);
    });

    test('matches any member of a comma list, whitespace included', () => {
        expect(matchesIfMatch(`"deadbeef", ${ETAG}`, ETAG)).toBe(true);
        expect(matchesIfMatch(`  ${ETAG}  `, ETAG)).toBe(true);
        expect(matchesIfMatch('"deadbeef", "cafe"', ETAG)).toBe(false);
    });

    test('compares strongly (RFC 7232 §3.1), so a W/ validator never matches', () => {
        expect(matchesIfMatch(`W/${ETAG}`, ETAG)).toBe(false);
    });
});

describe('matchesIfNoneMatch', () => {
    test('* means "the resource exists", never a literal tag', () => {
        expect(matchesIfNoneMatch('*', ETAG)).toBe(true);
        expect(matchesIfNoneMatch('*', null)).toBe(false);
    });

    test('matches the current quoted tag and nothing else', () => {
        expect(matchesIfNoneMatch(ETAG, ETAG)).toBe(true);
        expect(matchesIfNoneMatch('"deadbeef"', ETAG)).toBe(false);
        expect(matchesIfNoneMatch(ETAG, null)).toBe(false);
    });

    test('matches any member of a comma list, whitespace included', () => {
        expect(matchesIfNoneMatch(`"deadbeef", ${ETAG}`, ETAG)).toBe(true);
        expect(matchesIfNoneMatch(`  ${ETAG}  `, ETAG)).toBe(true);
        expect(matchesIfNoneMatch('"deadbeef", "cafe"', ETAG)).toBe(false);
    });

    test('compares weakly (RFC 7232 §3.2), so a W/ validator matches', () => {
        expect(matchesIfNoneMatch(`W/${ETAG}`, ETAG)).toBe(true);
        expect(matchesIfNoneMatch(`"deadbeef", W/${ETAG}`, ETAG)).toBe(true);
    });
});

describe('parseByteRange', () => {
    test('returns the inclusive slice for a single satisfiable range', () => {
        expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
        expect(parseByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
        expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
        expect(parseByteRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    });

    test('returns null with no Range header, so the caller serves the whole body', () => {
        expect(parseByteRange(null, 10)).toBeNull();
    });

    test('ignores a header it cannot parse rather than rejecting the request', () => {
        // 'bytes=5-2' parses, but last-pos before first-pos is an invalid spec → ignore, not 416 (RFC 9110 §14.1.1).
        for (const header of [
            'bytes=0-1,4-5',
            'bytes = 0-2',
            'bytes=-',
            'BYTES=0-1',
            'items=0-1',
            'bytes=a-b',
            'bytes=5-2',
        ]) {
            expect(parseByteRange(header, 10)).toBeNull();
        }
    });

    test('is unsatisfiable only for a parsed range outside the resource', () => {
        expect(parseByteRange('bytes=99-120', 10)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=0-0', 0)).toBe('unsatisfiable');
    });
});

describe('rangeResponse', () => {
    const BODY = new TextEncoder().encode('0123456789');
    // The smallest source the three callers share: a slice reader (end exclusive) and a full-body reader.
    const source = {
        slice: (start: number, end: number) => BODY.slice(start, end),
        full: () => BODY.slice(),
    };
    const headers = { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' };

    test('awaits an async source, as every real caller hands it one', async () => {
        const asyncSource = {
            slice: async (start: number, end: number) => BODY.slice(start, end),
            full: async () => BODY.slice(),
        };
        expect(await (await rangeResponse(headers, BODY.length, 'bytes=2-5', asyncSource)).text()).toBe('2345');
        expect(await (await rangeResponse(headers, BODY.length, null, asyncSource)).text()).toBe('0123456789');
    });

    test('serves the whole body as 200 with no Content-Range', async () => {
        const res = await rangeResponse(headers, BODY.length, null, source);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/plain');
        expect(res.headers.get('Content-Range')).toBeNull();
        expect(res.headers.get('Content-Length')).toBe('10');
        expect(await res.text()).toBe('0123456789');
    });

    test('serves a slice as 206 with Content-Range and the slice length', async () => {
        const res = await rangeResponse(headers, BODY.length, 'bytes=2-5', source);
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
        expect(res.headers.get('Content-Length')).toBe('4');
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        expect(await res.text()).toBe('2345');
    });

    test('serves a suffix range as the last N bytes', async () => {
        const res = await rangeResponse(headers, BODY.length, 'bytes=-3', source);
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
        expect(await res.text()).toBe('789');
    });

    test('answers an unsatisfiable range with 416 and the resource size', async () => {
        const res = await rangeResponse(headers, BODY.length, 'bytes=99-120', source);
        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe('bytes */10');
        expect(await res.text()).toBe('');
    });

    test('answers any range on a 0-byte resource with 416', async () => {
        const empty = { slice: () => new Uint8Array(), full: () => new Uint8Array() };
        const res = await rangeResponse(headers, 0, 'bytes=0-', empty);
        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe('bytes */0');
    });
});
