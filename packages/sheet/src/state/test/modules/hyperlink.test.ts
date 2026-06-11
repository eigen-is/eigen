// Scheme allowlist for hyperlink navigation. linkAddress comes straight from
// untrusted xlsx files and flows into window.open: http/https/mailto pass
// through verbatim, a scheme-less address keeps the legacy https:// prepend,
// and any other scheme (javascript:, data:, file:, …) must neither navigate
// nor validate — scripting schemes must be unreachable.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Context } from '../../context';
import { goToLink, isLinkValid } from '../../modules/hyperlink';
import { contextFactory } from '../factories/context';

// Bun's test runtime has no DOM; goToLink's webpage branch only touches
// window.open, so a single-method stub scoped to this file suffices.
const g = globalThis as unknown as { window?: { open: (url?: string) => void } };

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
    const ctx = contextFactory() as Context;

    test('accepts http/https, mailto and scheme-less addresses', () => {
        expect(isLinkValid(ctx, 'webpage', 'https://example.com').isValid).toBe(true);
        expect(isLinkValid(ctx, 'webpage', 'mailto:foo@bar.com').isValid).toBe(true);
        expect(isLinkValid(ctx, 'webpage', 'example.com').isValid).toBe(true);
    });

    test('rejects non-allowlisted schemes', () => {
        expect(isLinkValid(ctx, 'webpage', 'javascript:alert(1)').isValid).toBe(false);
        expect(isLinkValid(ctx, 'webpage', 'data:text/html,x').isValid).toBe(false);
        expect(isLinkValid(ctx, 'webpage', 'file:///etc/passwd').isValid).toBe(false);
    });
});
