import { describe, expect, test } from 'bun:test';
import { scriptableInlineHeaders } from '../../lib/core/http';

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
