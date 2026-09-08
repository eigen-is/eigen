import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    buildContentSecurityPolicy,
    buildSecurityMetaTags,
    THEME_FLASH_SCRIPT,
    themeScriptCspSource,
    withInlineScriptHashes,
} from '../../../../vite.security-headers';

const DEV_API = 'http://localhost:8000';

describe('buildSecurityMetaTags', () => {
    test('injects a CSP meta and a referrer meta', () => {
        const meta = buildSecurityMetaTags({ dev: false, apiHost: '/eigen' });
        expect(meta).toContain('<meta http-equiv="Content-Security-Policy" content="');
        expect(meta).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">');
    });
});

describe('buildContentSecurityPolicy', () => {
    test('prod script-src pins the theme script by a hash of its exact bytes', () => {
        const expected = `'sha256-${createHash('sha256').update(THEME_FLASH_SCRIPT).digest('base64')}'`;
        expect(themeScriptCspSource()).toBe(expected);

        const prod = buildContentSecurityPolicy({ dev: false, apiHost: '/eigen' });
        const scriptSrc = prod.split('; ').find((d) => d.startsWith('script-src'));
        expect(scriptSrc).toBe(`script-src 'self' ${expected}`); // no 'unsafe-inline' in prod script-src
    });

    test('prod stays same-origin: no localhost, tight object/base/form directives', () => {
        const prod = buildContentSecurityPolicy({ dev: false, apiHost: '/eigen' });
        expect(prod).toContain("connect-src 'self'");
        expect(prod).not.toContain('localhost');
        expect(prod).not.toContain('ws://');
        expect(prod).toContain("object-src 'none'");
        expect(prod).toContain("base-uri 'self'");
        expect(prod).toContain("form-action 'self'");
    });

    test('dev opens the cross-origin API for connect (xhr/sse), the ws socket, frames, img and media', () => {
        const dev = buildContentSecurityPolicy({ dev: true, apiHost: DEV_API });
        expect(dev).toContain(`connect-src 'self' ${DEV_API} ws://localhost:8000`);
        expect(dev).toContain(`frame-src 'self' blob: ${DEV_API}`);
        expect(dev).toContain(`${DEV_API}`); // img-src + media-src also carry it
        expect(dev).toContain("script-src 'self' 'unsafe-inline'"); // Vite dev preamble is inline
    });

    test('dev and prod connect-src differ', () => {
        const dev = buildContentSecurityPolicy({ dev: true, apiHost: DEV_API });
        const prod = buildContentSecurityPolicy({ dev: false, apiHost: '/eigen' });
        const connectOf = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src'));
        expect(connectOf(dev)).not.toBe(connectOf(prod));
        expect(connectOf(dev)).toContain('ws://localhost:8000');
        expect(connectOf(prod)).toBe("connect-src 'self'");
    });
});

describe('withInlineScriptHashes', () => {
    const sha = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    const page = (scripts: string) =>
        `<html><head>${buildSecurityMetaTags({ dev: false, apiHost: '/eigen' })}<script>${THEME_FLASH_SCRIPT}</script></head><body>${scripts}</body></html>`;

    test('pins every executable inline script the prerender appended, keeping the theme hash', () => {
        const out = withInlineScriptHashes(page('<script>self.$_TSR={}</script><script></script>'));
        const scriptSrc = out.match(/script-src[^;]*/)?.[0] ?? '';
        expect(scriptSrc).toContain(themeScriptCspSource());
        expect(scriptSrc).toContain(sha('self.$_TSR={}'));
        expect(scriptSrc).toContain(sha(''));
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('data blocks and external scripts get no hash', () => {
        const out = withInlineScriptHashes(
            page(
                '<script type="application/json" id="x">{"a":1}</script><script type="application/ld+json">{}</script><script src="/assets/a.js"></script>',
            ),
        );
        const scriptSrc = out.match(/script-src[^;]*/)?.[0] ?? '';
        expect(scriptSrc).toBe(`script-src 'self' ${themeScriptCspSource()}`);
    });

    test('is idempotent and leaves a page without a CSP meta alone', () => {
        const once = withInlineScriptHashes(page('<script>x()</script>'));
        expect(withInlineScriptHashes(once)).toBe(once);
        expect(withInlineScriptHashes('<html><head></head><body><script>x()</script></body></html>')).toBe(
            '<html><head></head><body><script>x()</script></body></html>',
        );
    });
});
