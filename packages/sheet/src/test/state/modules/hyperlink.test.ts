// Scheme allowlist for hyperlink navigation. linkAddress comes straight from
// untrusted xlsx files and flows into window.open: http/https/mailto pass
// through verbatim, a scheme-less address keeps the legacy https:// prepend
// (host:port like localhost:3000 counts as scheme-less), and any other scheme
// (javascript:, data:, file:, …) must neither navigate nor validate —
// scripting schemes must be unreachable.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { goToLink, isLinkValid } from '../../../state/modules/hyperlink';
import { contextFactory } from '../factories/context';

// Bun's test runtime has no DOM; goToLink's webpage branch only touches
// window.open, so a single-method stub scoped to this file suffices.
const g = globalThis as unknown as {
    window?: { open: (url?: string, target?: string, features?: string) => void };
};

afterEach(() => {
    delete g.window;
});

function openedUrls(): string[] {
    const calls: string[] = [];
    g.window = { open: (url?: string) => void calls.push(url ?? '') };
    return calls;
}

function webpageContext(linkAddress: string): Context {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].hyperlink = { '0_0': { linkType: 'webpage', linkAddress } };
    return ctx;
}

const scrollEl = {} as HTMLDivElement; // unused by the webpage branch

describe('goToLink scheme allowlist', () => {
    test('opens http/https links verbatim', () => {
        const calls = openedUrls();
        goToLink(webpageContext('https://example.com/a?b=1'), 0, 0, 'webpage', 'https://example.com/a?b=1', scrollEl);
        goToLink(webpageContext('http://example.com'), 0, 0, 'webpage', 'http://example.com', scrollEl);
        expect(calls).toEqual(['https://example.com/a?b=1', 'http://example.com']);
    });

    test('opens mailto links verbatim, not mangled with an https:// prefix', () => {
        const calls = openedUrls();
        goToLink(webpageContext('mailto:foo@bar.com'), 0, 0, 'webpage', 'mailto:foo@bar.com', scrollEl);
        expect(calls).toEqual(['mailto:foo@bar.com']);
    });

    test('prepends https:// to scheme-less addresses', () => {
        const calls = openedUrls();
        goToLink(webpageContext('example.com'), 0, 0, 'webpage', 'example.com', scrollEl);
        expect(calls).toEqual(['https://example.com']);
    });

    test('opens links via _blank with noopener so the target cannot reach back through window.opener', () => {
        const calls: (string | undefined)[][] = [];
        g.window = { open: (...args: (string | undefined)[]) => void calls.push(args) };
        goToLink(webpageContext('https://example.com'), 0, 0, 'webpage', 'https://example.com', scrollEl);
        expect(calls).toEqual([['https://example.com', '_blank', 'noopener,noreferrer']]);
    });

    test('treats host:port as scheme-less — digits only after the colon is a port, not a scheme', () => {
        const calls = openedUrls();
        goToLink(webpageContext('example.com:8080/x'), 0, 0, 'webpage', 'example.com:8080/x', scrollEl);
        goToLink(webpageContext('localhost:3000'), 0, 0, 'webpage', 'localhost:3000', scrollEl);
        expect(calls).toEqual(['https://example.com:8080/x', 'https://localhost:3000']);
    });

    test('javascript:8080 resolves as host:port — a harmless https hostname, not a scheme', () => {
        const calls = openedUrls();
        goToLink(webpageContext('javascript:8080'), 0, 0, 'webpage', 'javascript:8080', scrollEl);
        expect(calls).toEqual(['https://javascript:8080']);
    });

    test('whitespace/control-char scheme variants get the https:// prepend, never a raw scripting scheme', () => {
        const calls = openedUrls();
        goToLink(webpageContext(' javascript:alert(1)'), 0, 0, 'webpage', ' javascript:alert(1)', scrollEl);
        goToLink(webpageContext('java\nscript:alert(1)'), 0, 0, 'webpage', 'java\nscript:alert(1)', scrollEl);
        expect(calls).toEqual(['https:// javascript:alert(1)', 'https://java\nscript:alert(1)']);
    });

    test('never opens scripting or other non-allowlisted schemes', () => {
        const calls = openedUrls();
        for (const address of [
            'javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
        ]) {
            goToLink(webpageContext(address), 0, 0, 'webpage', address, scrollEl);
        }
        expect(calls).toEqual([]);
    });
});

describe('isLinkValid scheme allowlist', () => {
    test('accepts http/https, mailto and scheme-less addresses', () => {
        expect(isLinkValid('webpage', 'https://example.com').isValid).toBe(true);
        expect(isLinkValid('webpage', 'https://example.com/a/b?x=1&y=2').isValid).toBe(true);
        expect(isLinkValid('webpage', 'mailto:foo@bar.com').isValid).toBe(true);
        expect(isLinkValid('webpage', 'example.com').isValid).toBe(true);
    });

    test('accepts everything navigation would open — same gate as goToLink', () => {
        // The old charset regex rejected these while goToLink happily opened
        // them; validity now derives from resolveWebLink + URL.canParse.
        expect(isLinkValid('webpage', 'localhost:3000').isValid).toBe(true);
        expect(isLinkValid('webpage', 'https://example.com/x;y=1#frag').isValid).toBe(true);
        expect(isLinkValid('webpage', 'https://en.wikipedia.org/wiki/Foo_(bar)').isValid).toBe(true);
    });

    test('rejects structurally unparseable addresses', () => {
        expect(isLinkValid('webpage', 'https://exa mple.com').isValid).toBe(false);
        expect(isLinkValid('webpage', 'https://').isValid).toBe(false);
    });

    test('rejects non-allowlisted schemes', () => {
        expect(isLinkValid('webpage', 'javascript:alert(1)').isValid).toBe(false);
        expect(isLinkValid('webpage', 'data:text/html,x').isValid).toBe(false);
        expect(isLinkValid('webpage', 'file:///etc/passwd').isValid).toBe(false);
    });
});
