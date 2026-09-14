import { describe, expect, test } from 'bun:test';
import { parseByteRange, scriptableInlineHeaders } from '../../lib/core/http';

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
        for (const header of ['bytes=0-1,4-5', 'bytes = 0-2', 'bytes=-', 'BYTES=0-1', 'items=0-1', 'bytes=a-b']) {
            expect(parseByteRange(header, 10)).toBeNull();
        }
    });

    test('is unsatisfiable only for a parsed range outside the resource', () => {
        expect(parseByteRange('bytes=99-120', 10)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=5-2', 10)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=0-0', 0)).toBe('unsatisfiable');
    });
});
