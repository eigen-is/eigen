import { describe, expect, test } from 'bun:test';
import {
    EIGEN_MEDIA_SCHEME,
    eigenMediaHref,
    listEigenMediaRefs,
    parseEigenMediaHref,
    rewriteEigenMediaRefs,
    stripEigenMediaRefs,
} from '../../vector/media-refs';

// A minimal `<image>` fragment as sceneToSvg would emit it — `href="${escapeXml(eigenMediaHref(name))}"`.
// Since the token is escapeXml-invariant (the whole point of R1), escapeXml is a no-op here and the
// stored token equals eigenMediaHref(name) exactly.
const imageEl = (name: string) =>
    `<g transform="translate(0 0)"><image x="0" y="0" width="40" height="40" href="${eigenMediaHref(name)}" preserveAspectRatio="none"/></g>`;

describe('eigen-media codec', () => {
    test('round-trips names with spaces, quotes, dots, and unicode', () => {
        for (const name of [
            'pic.png',
            'my photo.png',
            "Bob's holiday (final).png",
            'café ☕ résumé.png',
            'a.b.c.d.png',
            '100% done!.png',
            '"quoted".png',
        ]) {
            const href = eigenMediaHref(name);
            expect(href.startsWith(EIGEN_MEDIA_SCHEME)).toBe(true);
            expect(parseEigenMediaHref(href)).toBe(name);
        }
    });

    test('the token is escapeXml-invariant (no & < > " \x27 chars)', () => {
        // R1's load-bearing property: none of escapeXml's characters survive in a token, so the SVG
        // stores it verbatim and rewrite/strip stay exact-token replaces.
        const href = eigenMediaHref('Bob\'s "big" <photo> & more.png');
        expect(href).not.toMatch(/[&<>"']/);
        expect(parseEigenMediaHref(href)).toBe('Bob\'s "big" <photo> & more.png');
    });

    test('rejects traversal names and control characters', () => {
        expect(parseEigenMediaHref('eigen-media:..%2Fetc%2Fpasswd')).toBeNull();
        expect(parseEigenMediaHref('eigen-media:../etc')).toBeNull();
        expect(parseEigenMediaHref('eigen-media:a%2Fb')).toBeNull();
        expect(parseEigenMediaHref('eigen-media:a%5Cb')).toBeNull(); // backslash
        expect(parseEigenMediaHref('eigen-media:a%00b')).toBeNull(); // NUL
        expect(parseEigenMediaHref('eigen-media:a%09b')).toBeNull(); // tab
    });

    test('parse returns null for non-refs, empty, and malformed encoding', () => {
        expect(parseEigenMediaHref('data:image/png;base64,AAA')).toBeNull();
        expect(parseEigenMediaHref('https://example.com/x.png')).toBeNull();
        expect(parseEigenMediaHref('eigen-media:')).toBeNull();
        expect(parseEigenMediaHref('eigen-media:%')).toBeNull(); // bad percent-encoding
    });

    test('lists the distinct, safe names an SVG references', () => {
        const svg = `<svg>${imageEl('a.png')}${imageEl('b b.png')}${imageEl('a.png')}</svg>`;
        expect(listEigenMediaRefs(svg)).toEqual(['a.png', 'b b.png']);
    });

    test('lister drops forged traversal refs', () => {
        const svg = `<svg><image href="eigen-media:../../etc/passwd"/>${imageEl('ok.png')}</svg>`;
        expect(listEigenMediaRefs(svg)).toEqual(['ok.png']);
    });

    test('rewrite maps old names to new, leaves unknown refs untouched', () => {
        const svg = `<svg>${imageEl('old.png')}${imageEl('keep.png')}</svg>`;
        const out = rewriteEigenMediaRefs(svg, new Map([['old.png', 'new (1).png']]));
        expect(out).toContain(`href="${eigenMediaHref('new (1).png')}"`);
        expect(out).not.toContain(`href="${eigenMediaHref('old.png')}"`);
        expect(out).toContain(`href="${eigenMediaHref('keep.png')}"`);
    });

    test('rewrite is a single swap-safe pass (a→b, b→a swaps, never composes)', () => {
        const svg = `<svg>${imageEl('a.png')}${imageEl('b.png')}</svg>`;
        const out = rewriteEigenMediaRefs(
            svg,
            new Map([
                ['a.png', 'b.png'],
                ['b.png', 'a.png'],
            ]),
        );
        expect(out).toBe(`<svg>${imageEl('b.png')}${imageEl('a.png')}</svg>`);
    });

    test('rewrite is idempotent when applied again with the same map', () => {
        const svg = `<svg>${imageEl('old.png')}</svg>`;
        const renames = new Map([['old.png', 'new.png']]);
        const once = rewriteEigenMediaRefs(svg, renames);
        expect(rewriteEigenMediaRefs(once, renames)).toBe(once);
    });

    test('strip removes the href of the named images so they render as nothing', () => {
        const svg = `<svg>${imageEl('gone.png')}${imageEl('stay.png')}</svg>`;
        const out = stripEigenMediaRefs(svg, ['gone.png']);
        expect(out).not.toContain('eigen-media:gone.png');
        expect(out).not.toContain(`href="${eigenMediaHref('gone.png')}"`);
        expect(out).toContain(`href="${eigenMediaHref('stay.png')}"`);
        // The <image> element survives, only its href is dropped.
        expect(out).toContain('preserveAspectRatio="none"');
    });
});
