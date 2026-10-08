import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as Y from 'yjs';
import { parseXml } from '../../lib/core/xml';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { renderEigenslidesExport } from '../../lib/export/canvas/transform';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import { getFontFaceCSSForFamilies } from '../../lib/export/fonts';
import { sanitizeExportHtml, sanitizeExportMedia } from '../../lib/export/sanitize';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { buildGoldenDeckScene, seedDeckDoc, seedEigendoc } from '../fixtures/golden-documents';

// SSRF regression: a collaborator can inject `url(http://…)` or `<img src=http://…>` into a schemaless slide/sheet
// color or text. WeasyPrint renders through a fetcher that opens only data: URIs, the boundary the last suite tests with
// the sanitizer bypassed. sanitizeExportHtml strips every non-data ref as well, which keeps the HTML downloads and the
// preview DOM from fetching: that layer is tested unconditionally, the renderer only where it is installed.

// 1x1 PNG — the only legitimate resource shape exports embed (fonts/images are data: URIs).
const DATA_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The other half of a sanitizer contract: what it must NOT eat. Every rule above is a strip, and a
// strip that over-reaches silently exports a document missing its formatting, its links or its
// pictures — a failure no hostile-input test can see.
describe('export sanitize — legitimate markup survives', () => {
    test('inline marks, headings, lists and quotes come through unchanged', () => {
        const html =
            '<h2>Title</h2><p><strong>bold</strong> <em>italic</em> <s>struck</s> <code>code</code></p>' +
            '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quoted</p></blockquote>' +
            '<table><tbody><tr><th>h</th><td>c</td></tr></tbody></table>';
        expect(sanitizeExportHtml(html)).toBe(html);
    });

    test('a hyperlink keeps its href, and its target when the caller allows the attribute', () => {
        const out = sanitizeExportHtml('<a href="https://example.com/report" target="_blank">r</a>', {
            ADD_ATTR: ['target'],
        });
        expect(out).toContain('href="https://example.com/report"');
        expect(out).toContain('target="_blank"');
    });

    test('a data: image survives as src, in a CSS url() and in a <style> block', () => {
        const out = sanitizeExportHtml(
            `<img src="${DATA_PNG}" alt="pixel"><div style="background-image:url(${DATA_PNG})">x</div>` +
                `<style>.s0{background:url(${DATA_PNG})}</style>`,
        );
        expect(out.match(new RegExp(DATA_PNG.replace(/[+/]/g, '\\$&'), 'g'))).toHaveLength(3);
        expect(out).toContain('alt="pixel"');
    });

    test('presentational style declarations that fetch nothing are left alone', () => {
        const style = 'color:#101010;font-weight:bold;text-align:center;line-height:1.2';
        expect(sanitizeExportHtml(`<p style="${style}">x</p>`)).toContain(style);
    });
});

describe('export sanitize — SSRF surface', () => {
    test('an injected remote url() in a style is neutralized', () => {
        const out = sanitizeExportHtml(
            '<div style="background-image:url(http://169.254.169.254/latest/meta-data/)">x</div>',
        );
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    test('a split-declaration url() injection is neutralized', () => {
        const out = sanitizeExportHtml('<div style="color:red;background-image:url(http://evil.test/ssrf)">x</div>');
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    test('an injected remote <img src> is dropped', () => {
        const out = sanitizeExportHtml('<img src="http://evil.test/pixel.png">');
        expect(out).not.toMatch(/src\s*=\s*["']?https?:/i);
    });

    test('legit data: url() and data: image are kept', () => {
        const out = sanitizeExportHtml(`<div style="background-image:url(${DATA_PNG})">x</div><img src="${DATA_PNG}">`);
        expect(out).toContain('data:image/png;base64');
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    test('legit http(s) hyperlinks are preserved (link targets are not fetched during render)', () => {
        const out = sanitizeExportHtml('<a href="https://example.com/report">r</a>', { ADD_ATTR: ['target'] });
        expect(out).toContain('href="https://example.com/report"');
    });
});

// The sheets export emits its class rules in a body <style> element, so the same data-only
// restriction that guards style attributes must cover style-element CSS text — plus @import,
// which can only exist there (a declaration-only style attribute can't carry at-rules).
describe('export sanitize — style elements', () => {
    test('a style element and its class rules survive sanitization', () => {
        const out = sanitizeExportHtml(
            '<style>td{color:#111}\n.s0{background:#eee}</style><table><tbody><tr><td class="s0">x</td></tr></tbody></table>',
        );
        expect(out).toContain('<style>');
        expect(out).toContain('.s0{background:#eee}');
        expect(out).toContain('class="s0"');
    });

    test('a remote url() inside a style element is neutralized', () => {
        const out = sanitizeExportHtml('<style>.s0{background:url(http://169.254.169.254/latest/meta-data/)}</style>');
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
        expect(out).toContain('<style>');
    });

    test('@import is neutralized in both string and url form', () => {
        const out = sanitizeExportHtml(
            '<style>@import "http://evil.test/a.css";@import url(http://evil.test/b.css);.s0{color:red}</style>',
        );
        expect(out).not.toMatch(/@import/i);
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
        expect(out).toContain('.s0{color:red}');
    });

    test('a data: url() inside a style element is kept', () => {
        const out = sanitizeExportHtml(`<style>.s0{background:url(${DATA_PNG})}</style>`);
        expect(out).toContain('data:image/png;base64');
        expect(out).not.toMatch(/url\(\s*['"]?https?:/i);
    });

    // A CSS escape spells a token invisibly to a regex: `@\69 mport` and `\75 rl(` are
    // `@import` and `url(` to the parser that actually fetches them. Dropping the
    // backslash is what defangs them — `75 rl(…)` is an unknown function, not a fetch —
    // so assert no real `url(`/`@import` token survives (the e2e suite below proves the
    // consequence: WeasyPrint opens no connection).
    test('CSS-escaped @import and url() are neutralized in style elements', () => {
        const out = sanitizeExportHtml(
            '<style>@\\69 mport "http://evil.test/a.css";.s0{background:\\75 rl(http://evil.test/b.png)}</style>',
        );
        expect(out).not.toMatch(/@import/i);
        expect(out).not.toMatch(/\burl\(\s*['"]?https?:/i);
        expect(out).not.toContain('\\');
    });

    test('a CSS-escaped url() in a style attribute is neutralized', () => {
        const out = sanitizeExportHtml('<div style="background:\\75 rl(http://evil.test/c.png)">x</div>');
        expect(out).not.toMatch(/\burl\(\s*['"]?https?:/i);
        expect(out).not.toContain('\\');
    });
});

// A url() is refused on its token, never parsed as a pair: a quote or a paren inside the URL ends no match early,
// and the CSS parser reads `URL(` as `url(`. A pair regex let every one of these reach the CSS parser.
describe('export sanitize — url() is refused on its token', () => {
    const EVIL = 'http://evil.test';

    test.each([
        ['a single-quoted URL holding a paren', `url('${EVIL}/a)')`],
        ['a double-quoted URL holding a paren', `url("${EVIL}/b)")`],
        ['a single-quoted URL holding a quote', `url('${EVIL}/e'')`],
        ['an uppercase URL(', `URL(${EVIL}/upper)`],
        ['a mixed-case uRl(', `uRl(${EVIL}/mixed)`],
        ['a newline before the paren', `url(${EVIL}/nl\n)`],
        ['a comment before the URL', `url(/*x*/${EVIL}/cm)`],
        ['a fragment and a remote URL in one value', `url(#g) url(${EVIL}/two)`],
        ['a fragment holding a paren, then a remote URL', `url('#g)') url(${EVIL}/after)`],
        ['image-set() with a string', `image-set('${EVIL}/set' 1x)`],
        ['-webkit-image-set() with a string', `-webkit-image-set('${EVIL}/wset' 1x)`],
        ['image() with a string', `image('${EVIL}/img')`],
        ['cross-fade() with a string', `cross-fade('${EVIL}/cf', '${EVIL}/cf2', 50%)`],
    ])('%s goes from a style attribute and a style element', (_, css) => {
        const attr = sanitizeExportHtml(
            `<div style="color:red;background-image:${css.replaceAll('"', '&quot;')}">x</div>`,
        );
        expect(attr).not.toContain('evil.test');
        const sheet = sanitizeExportHtml(`<style>.a{background-image:${css}}.b{color:red}</style>`);
        expect(sheet).not.toContain('evil.test');
        expect(sheet).toContain('.b{color:red}');
    });

    // attr() can read an attribute as a URL, and WeasyPrint fails the whole export on `attr(name url)`.
    test.each(['attr(data-x url)', 'ATTR(data-x url)', 'attr(title)'])(
        '%s goes from a style attribute and a style element',
        (css) => {
            expect(sanitizeExportHtml(`<p data-x="x" style="color:red;content:${css}">a</p>`)).toBe(
                '<p data-x="x">a</p>',
            );
            expect(sanitizeExportHtml(`<style>p::before{content:${css}}.b{color:red}</style>`)).toBe(
                '<style>.b{color:red}</style>',
            );
        },
    );

    test('an @font-face src holding a paren goes, and the rule beside it stays', () => {
        const out = sanitizeExportHtml(
            `<style>@font-face{font-family:Z;src:url("${EVIL}/d)")} p{font-family:Z}</style>`,
        );
        expect(out).not.toContain('evil.test');
        expect(out).toContain('p{font-family:Z}');
    });

    test('@namespace url() and a spaced @import url() go', () => {
        const out = sanitizeExportHtml(
            `<style>@namespace url(${EVIL}/ns); @import url( ${EVIL}/imp );.b{color:red}</style>`,
        );
        expect(out).not.toContain('evil.test');
        expect(out).toContain('.b{color:red}');
    });

    test('a URL a CSS escape spells after the backslashes go is refused too', () => {
        expect(sanitizeExportHtml(`<div style="background:u\\rl(${EVIL}/esc)">x</div>`)).not.toContain('evil.test');
        expect(sanitizeExportHtml(`<style>.a{background:u\\rl(${EVIL}/esc)}</style>`)).not.toContain('evil.test');
    });

    test.each(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'])(
        'a remote url() in an SVG %s attribute goes, inline and in SVG media',
        (attr) => {
            for (const value of [`url(${EVIL}/p.svg#x)`, `URL('${EVIL}/q.svg#x)')`, `\\75 rl(${EVIL}/r.svg#x)`]) {
                expect(sanitizeExportHtml(`<svg><rect ${attr}="${value}"></rect></svg>`)).not.toContain('evil.test');
                const [media] = sanitizeExportMedia([
                    {
                        name: 'a.svg',
                        contentType: 'image/svg+xml',
                        data: toTransferableText(
                            `<svg xmlns="http://www.w3.org/2000/svg"><rect ${attr}="${value}"/></svg>`,
                        ),
                    },
                ]);
                expect(Buffer.from(media.data).toString('utf8')).not.toContain('evil.test');
            }
        },
    );

    test('a fragment url() in a presentation attribute keeps its target', () => {
        const out = sanitizeExportHtml(
            `<svg><rect fill="url(#g)" mask="url('#m')" clip-path="URL( #c )"></rect></svg>`,
        );
        expect(out).toContain('fill="url(#g)"');
        expect(out).toContain(`mask="url('#m')"`);
        expect(out).toContain('clip-path="URL( #c )"');
    });
});

// A collaborator's string sizes the scan, so every token pattern runs in one pass. A whitespace run after `url(` cost
// its square in the allowed-ref read (3.8 s for 100 KB) and a run of backslashes the escape check's (2.1 s); 256 KB of
// either takes milliseconds now, so the bound is far from both, whatever the machine's load.
describe('export sanitize — a long crafted value costs one pass', () => {
    const LONG = 256 * 1024;
    test.each([
        ['spaces after url( in a style attribute', `<p style="url(${' '.repeat(LONG)}x">a</p>`],
        ['spaces after url( in a style element', `<style>.a{b:url(${' '.repeat(LONG)}x}</style>`],
        ['spaces after url( in a presentation attribute', `<svg><rect fill="url(${' '.repeat(LONG)}x"></rect></svg>`],
        ['backslashes in a presentation attribute', `<svg><rect fill="${'\\'.repeat(LONG)}"></rect></svg>`],
        ['an unclosed quoted data: URI', `<style>.a{b:url('data:${'a'.repeat(LONG)}}</style>`],
        ['quoted data: url( openings', `<style>.a{b:${"url('data:".repeat(LONG / 10)}}</style>`],
        ['unquoted data: url( openings', `<svg><rect fill="${'url(data:'.repeat(LONG / 9)}"></rect></svg>`],
    ])('%s', (_, html) => {
        const start = performance.now();
        sanitizeExportHtml(html);
        expect(performance.now() - start).toBeLessThan(1000);
    });
});

// `src` is not an <img>-only attribute, and it is not the only attribute that fetches: srcset
// candidate lists, <video poster> and the legacy `background` all resolve with no click. DOMPurify
// keeps every one of them, so the restriction is on the attribute, not the tag.
describe('export sanitize — media reference attributes', () => {
    test('a remote srcset on an img is dropped', () => {
        const out = sanitizeExportHtml('<img srcset="http://evil.test/pixel.png 1x">');
        expect(out).not.toContain('evil.test');
    });

    test('a remote src and poster on a video are dropped', () => {
        const out = sanitizeExportHtml('<video src="http://evil.test/v.mp4" poster="http://evil.test/p.png"></video>');
        expect(out).not.toContain('evil.test');
    });

    test('a remote src on an audio element is dropped', () => {
        const out = sanitizeExportHtml('<audio src="http://evil.test/a.mp3"></audio>');
        expect(out).not.toContain('evil.test');
    });

    test('a remote srcset on a picture source is dropped', () => {
        const out = sanitizeExportHtml('<picture><source srcset="http://evil.test/s.png"><img alt=""></picture>');
        expect(out).not.toContain('evil.test');
    });

    test('a remote src on an image input is dropped', () => {
        const out = sanitizeExportHtml('<input type="image" src="http://evil.test/i.png">');
        expect(out).not.toContain('evil.test');
    });

    test('a remote background attribute is dropped', () => {
        const out = sanitizeExportHtml('<table background="http://evil.test/bg.png"><tr><td>x</td></tr></table>');
        expect(out).not.toContain('evil.test');
    });
});

// Preview bodies embed the /file/<id>/preview media URLs the main thread resolved — http(s), not
// data:. Those exact URLs pass; nothing else off-origin does, not even another path on the API host.
describe('export sanitize — allowed refs', () => {
    const MEDIA_URL = 'http://localhost:8000/drive/o/m/file/f/preview';
    const allowedRefs = new Set([MEDIA_URL]);

    test('an allowed media URL survives as src and in a CSS url()', () => {
        const out = sanitizeExportHtml(
            `<img src="${MEDIA_URL}"><div style="background-image:url('${MEDIA_URL}')">x</div>`,
            { allowedRefs },
        );
        expect(out).toContain(`src="${MEDIA_URL}"`);
        expect(out).toContain(`url('${MEDIA_URL}')`);
    });

    test('another URL on the same host is still dropped', () => {
        const out = sanitizeExportHtml('<img src="http://localhost:8000/admin/secret">', { allowedRefs });
        expect(out).not.toContain('/admin/secret');
    });

    test('an allowed media URL is no pass for a remote url() beside it', () => {
        const out = sanitizeExportHtml(
            `<div style="background-image:url(${MEDIA_URL}), url('http://evil.test/a)')">x</div>`,
            { allowedRefs },
        );
        expect(out).not.toContain('evil.test');
    });
});

// The url()/img-src rule left SVG's own reference attributes open. DOMPurify keeps
// <svg><image href="http://…">, and a browser fetches it.
describe('export sanitize — SVG references', () => {
    test('a remote href on an SVG image is dropped', () => {
        const out = sanitizeExportHtml('<svg><image href="http://evil.test/pixel.png"></image></svg>');
        expect(out).not.toMatch(/href\s*=\s*["']?https?:/i);
    });

    test('a remote xlink:href on an SVG image is dropped', () => {
        const out = sanitizeExportHtml('<svg><image xlink:href="http://evil.test/pixel.png"></image></svg>');
        expect(out).not.toMatch(/href\s*=\s*["']?https?:/i);
    });

    test('http(s) anchors still keep their href', () => {
        const out = sanitizeExportHtml('<a href="https://example.com/report">r</a>');
        expect(out).toContain('href="https://example.com/report"');
    });

    test('an SVG link keeps its href like an HTML one', () => {
        const out = sanitizeExportHtml(
            '<svg><a href="https://example.com/a"><text>a</text></a><a xlink:href="https://example.com/b">b</a></svg>',
        );
        expect(out).toContain('href="https://example.com/a"');
        expect(out).toContain('xlink:href="https://example.com/b"');
    });
});

// matplotlib draws its text with <use href="#glyph">, Inkscape chains gradients through xlink:href and paints with
// fill:url(#g): a reference into the same document fetches nothing.
describe('export sanitize — same-document SVG references', () => {
    const DEFS = '<defs><linearGradient id="g"></linearGradient><path id="glyph" d="M0 0h1v1z"></path></defs>';
    const svg = (body: string) => sanitizeExportHtml(`<svg>${DEFS}${body}</svg>`);

    test.each(['url(#g)', "url('#g')", 'url("#g")', 'url( #g )', "url( '#g' )", 'url(\n"#g"\t)'])(
        'a fragment %s keeps its target in a style attribute and a style element',
        (ref) => {
            const attr = ref.replaceAll('"', '&quot;');
            expect(svg(`<rect style="fill:${attr}"></rect>`)).toContain(`fill:${attr}`);
            expect(svg(`<style>.a{fill:${ref}}</style>`)).toContain(`fill:${ref}`);
        },
    );

    test.each([
        ['remote', 'http://evil.test/s.svg#g'],
        ['protocol-relative', '//evil.test/s.svg#g'],
        ['relative path', 's.svg#g'],
        ['root-relative path', '/s.svg#g'],
        ['javascript:', 'javascript:alert(1)'],
        ['non-breaking space before the hash, a relative path to a URL parser', ' #g'],
        ['CSS-escaped hash, an unknown token once the backslash goes', '\\23 g'],
    ])('a %s url() takes its declarations with it', (_, ref) => {
        expect(svg(`<rect style="fill:url(${ref})"></rect>`)).toContain('<rect></rect>');
        expect(svg(`<style>.a{fill:url(${ref})}</style>`)).not.toContain('url(');
    });

    // An HTML <style> is raw text, so its entity is a relative path; an SVG one is parsed, so it is the hash.
    test('an entity-spelled hash is what the CSS parser will read', () => {
        expect(sanitizeExportHtml('<style>.a{fill:url(&#35;g)}</style>')).not.toContain('url(');
        expect(svg('<style>.a{fill:url(&#35;g)}</style>')).toContain('fill:url(#g)');
    });

    test('a fragment href keeps its target on a gradient and on <use>, in both spellings', () => {
        const out = svg(
            '<linearGradient id="h" xlink:href="#g"></linearGradient>' +
                '<use href="#glyph" x="1"></use><use xlink:href="#glyph" x="2"></use><use href=" #glyph" x="3"></use>',
        );
        expect(out).toContain('<linearGradient id="h" xlink:href="#g">');
        expect(out).toContain('<use href="#glyph" x="1">');
        expect(out).toContain('<use xlink:href="#glyph" x="2">');
        expect(out).toContain('<use href="#glyph" x="3">');
    });

    test.each([
        ['remote', 'http://evil.test/s.svg#g'],
        ['protocol-relative', '//evil.test/s.svg#g'],
        ['relative path', 's.svg#g'],
        ['javascript:', 'javascript:alert(1)'],
        ['data:', 'data:image/svg+xml,%3Csvg%20id%3D%22g%22%2F%3E#g'],
        ['entity-spelled remote', '&#104;ttp://evil.test/s.svg#g'],
        ['space-led remote', ' http://evil.test/s.svg#g'],
        ['non-breaking-space-led fragment', '&nbsp;#glyph'],
    ])('a %s <use> goes, and so does its href', (_, ref) => {
        for (const attr of ['href', 'xlink:href']) {
            const out = svg(`<use ${attr}="${ref}"></use>`);
            expect(out).not.toContain('<use');
            expect(out).not.toContain('evil.test');
        }
    });

    test('a <use> with no href, or a fragment beside a remote one, goes', () => {
        expect(svg('<use x="1"></use>')).not.toContain('<use');
        expect(svg('<use href="#glyph" xlink:href="http://evil.test/s.svg#g"></use>')).not.toContain('<use');
    });

    test('a non-fragment href on any other SVG element is still stripped', () => {
        const out = svg('<linearGradient id="h" xlink:href="http://evil.test/s.svg#g"></linearGradient>');
        expect(out).toContain('<linearGradient id="h">');
        expect(out).not.toContain('evil.test');
    });

    test.each(['use', 'linearGradient', 'radialGradient', 'pattern', 'filter', 'textPath', 'mpath'])(
        'a fragment href stays on <%s>, which references with it',
        (tag) => {
            expect(svg(`<${tag} href="#glyph"></${tag}>`)).toContain(`<${tag} href="#glyph">`);
        },
    );

    // WeasyPrint resolves a fragment on an image against its base and opens file://<cwd>/. SVG 2 gives clipPath and
    // mask no href.
    test.each(['image', 'feImage', 'clipPath', 'mask'])('a fragment href goes from <%s>, in both spellings', (tag) => {
        for (const attr of ['href', 'xlink:href']) {
            expect(svg(`<${tag} ${attr}="#g"></${tag}>`)).toContain(`<${tag}></${tag}>`);
            const [media] = sanitizeExportMedia([
                {
                    name: 'a.svg',
                    contentType: 'image/svg+xml',
                    data: toTransferableText(
                        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><${tag} ${attr}="#g"/></svg>`,
                    ),
                },
            ]);
            expect(Buffer.from(media.data).toString('utf8')).not.toContain('#g');
        }
    });

    test('an xml:base cannot turn a kept fragment into a remote reference', () => {
        const out = svg('<image xml:base="http://evil.test/" href="#g"></image>');
        expect(out).not.toContain('evil.test');
    });

    test('a profile without SVG admits no <use>', () => {
        const out = sanitizeExportHtml('<p><use href="#glyph"></use></p>', { ALLOWED_TAGS: ['p'] });
        expect(out).toBe('<p></p>');
    });

    test('foreignObject stays dropped', () => {
        expect(svg('<foreignObject><div>x</div></foreignObject>')).not.toContain('foreignObject');
    });
});

// SVG media reaches the transform Worker as the file's own bytes, and every reader of it reads XML.
describe('export sanitize — SVG media', () => {
    const text = (data: ArrayBuffer) => Buffer.from(data).toString('utf8');

    test('an SVG gets the data-only pass and is written as XML; a raster passes untouched', () => {
        const raster = toTransferableText('raster bytes');
        const [svg, png] = sanitizeExportMedia([
            {
                name: 'a.svg',
                contentType: 'image/svg+xml',
                data: toTransferableText(
                    `<svg xmlns="http://www.w3.org/2000/svg"><text>a&nbsp;b<br></text><image href="http://evil.test/p.png"/></svg>`,
                ),
            },
            { name: 'b.png', contentType: 'image/png', data: raster },
        ]);
        expect(parseXml(text(svg.data))?.local).toBe('svg');
        expect(text(svg.data)).toContain('a\u00a0b');
        expect(text(svg.data)).not.toContain('evil.test');
        expect(png.data).toBe(raster);
    });
    test('a character XML cannot hold leaves the text and the attributes it was in', () => {
        const [svg] = sanitizeExportMedia([
            {
                name: 'a.svg',
                contentType: 'image/svg+xml',
                data: toTransferableText(
                    `<svg xmlns="http://www.w3.org/2000/svg"><text id="t\u0002">a\u0001b</text></svg>`,
                ),
            },
        ]);
        expect(parseXml(text(svg.data))?.local).toBe('svg');
        expect(text(svg.data)).toContain('>ab</text>');
    });

    test('a file typed SVG with no <svg> in it is dropped, not passed through', () => {
        const media = sanitizeExportMedia([
            { name: 'a.svg', contentType: 'image/svg+xml', data: toTransferableText('hello <b>x</b>') },
        ]);
        expect(media).toEqual([]);
    });
});

// Each <use> draws its target once per reference, so nested ones multiply: 1.2 KB of 6 levels × 10 ran WeasyPrint
// into its kill. Only a <use> whose target holds none stays, the one level matplotlib's glyphs need.
describe('export sanitize — SVG media <use> depth', () => {
    const sanitized = (svg: string) => {
        const [item] = sanitizeExportMedia([
            {
                name: 'a.svg',
                contentType: 'image/svg+xml',
                data: toTransferableText(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${svg}</svg>`),
            },
        ]);
        return Buffer.from(item.data).toString('utf8');
    };
    const uses = (xml: string): string[] => [...xml.matchAll(/<use\b[^>]*>/g)].map(([use]) => use);

    test('a 6 × 10 fan-out keeps only the uses whose target holds no <use>', () => {
        let levels = '<g id="l0"><rect width="1" height="1"/></g>';
        for (let i = 1; i <= 6; i++) {
            levels += `<g id="l${i}">${Array.from({ length: 10 }, () => `<use href="#l${i - 1}"/>`).join('')}</g>`;
        }
        const out = sanitized(`<defs>${levels}</defs><use href="#l6"/>`);
        expect(uses(out)).toEqual(Array(10).fill('<use href="#l0"/>'));
    });

    test('a glyph <use> survives, in both spellings', () => {
        const out = sanitized(
            '<defs><path id="g" d="M0 0h1v1z"/></defs><use href="#g" x="1"/><use xlink:href="#g" x="2" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
        );
        expect(uses(out)).toHaveLength(2);
    });

    const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
    test.each([
        ['a self-referencing <use>', '<use id="a" href="#a"/>', []],
        [
            'two groups using each other',
            '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>',
            [],
        ],
        [
            'a <use> of a <use>',
            '<defs><path id="p" d="M0 0"/><use id="u" href="#p"/></defs><use href="#u"/>',
            ['<use id="u" href="#p"/>'],
        ],
        ['a <use> with a missing target', '<use href="#nowhere"/>', []],
        [
            'a <use> whose second spelling targets a nested one',
            `<defs><path id="p" d="M0 0"/><g id="g"><use href="#p"/></g></defs><use href="#p" xlink:href="#g" ${XLINK}/>`,
            ['<use href="#p"/>'],
        ],
        // A reader may decode the escape and land on another id than the one looked up.
        ['a percent-encoded target', '<defs><g id="l%31"><path d="M0 0"/></g></defs><use href="#l%31"/>', []],
    ])('%s goes', (_, svg, kept) => {
        expect(uses(sanitized(svg))).toEqual(kept);
    });
});

const base64Svg = (svg: string, header = 'data:image/svg+xml;base64') =>
    `${header},${Buffer.from(svg).toString('base64')}`;
const percentSvg = (svg: string, header = 'data:image/svg+xml') => `${header},${encodeURIComponent(svg)}`;

// A data: URI with no fragment is kept as it came, whatever its type or payload: no browser fetches from an SVG drawn
// as an image, librsvg draws one from its bytes, and WeasyPrint's fetcher opens nothing but data: URIs.
describe('export sanitize — a data: URI passes as it is', () => {
    test.each([
        ['a PNG', DATA_PNG],
        ['a JPEG', `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`],
        ['a font', `data:font/woff2;base64,${Buffer.from('wOF2\0\x01').toString('base64')}`],
        ['a percent-encoded text', 'data:text/plain,hello%20world'],
        ['an SVG', base64Svg('<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.test/a"/></svg>')],
        ['a percent-encoded SVG', percentSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')],
    ])('%s', (_, uri) => {
        expect(sanitizeExportHtml(`<img src="${uri}">`)).toBe(`<img src="${uri}">`);
        expect(sanitizeExportHtml(`<style>.a{background:url("${uri}")}</style>`)).toBe(
            `<style>.a{background:url("${uri}")}</style>`,
        );
    });
});

// Firefox loads a data: SVG named with a fragment as a resource document, not an image, and fetches its @import.
describe('export sanitize — a data: URI with a fragment is refused', () => {
    const SVG = base64Svg(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://evil.test/i);</style><mask id="m"/></svg>',
    );

    test.each([
        ['an unquoted mask', `mask:url(${SVG}#m)`],
        ['a single-quoted clip-path', `clip-path:url('${SVG}#c')`],
        ['a double-quoted filter', `filter:url("${SVG}#f")`],
        ['a mask-image', `mask-image:url(${SVG}#m)`],
        ['an uppercase DATA: after spaces', `mask:URL( '${SVG.replace('data:', 'DATA:')}#m' )`],
        ['an empty fragment', `mask:url(${SVG}#)`],
    ])('%s goes from a style attribute and a style element', (_, css) => {
        expect(sanitizeExportHtml(`<div style="color:red;${css.replaceAll('"', '&quot;')}">x</div>`)).toBe(
            '<div>x</div>',
        );
        expect(sanitizeExportHtml(`<style>.a{${css}}.b{color:red}</style>`)).toBe('<style>.b{color:red}</style>');
    });

    test.each(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start'])(
        'a fragment url() in an SVG %s attribute goes, inline and in SVG media',
        (attr) => {
            for (const value of [`url(${SVG}#x)`, `url('${SVG}#x')`, `url(${SVG}\\23 x)`]) {
                expect(sanitizeExportHtml(`<svg><rect ${attr}="${value}"></rect></svg>`)).toBe(
                    '<svg><rect></rect></svg>',
                );
                const [media] = sanitizeExportMedia([
                    {
                        name: 'a.svg',
                        contentType: 'image/svg+xml',
                        data: toTransferableText(
                            `<svg xmlns="http://www.w3.org/2000/svg"><rect ${attr}="${value}"/></svg>`,
                        ),
                    },
                ]);
                expect(Buffer.from(media.data).toString('utf8')).not.toContain('data:');
            }
        },
    );

    test.each(['image', 'feImage', 'pattern', 'linearGradient', 'filter', 'textPath', 'mpath'])(
        'a fragment href on an SVG %s goes, in both spellings',
        (tag) => {
            for (const attr of ['href', 'xlink:href']) {
                const out = sanitizeExportHtml(
                    `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><${tag} ${attr}="${SVG}#g"></${tag}></svg>`,
                );
                expect(out).not.toContain('data:');
            }
        },
    );

    test('a fragment src, poster and background go', () => {
        expect(sanitizeExportHtml(`<img src="${SVG}#g">`)).toBe('<img>');
        expect(sanitizeExportHtml(`<video poster="${SVG}#g"></video>`)).toBe('<video></video>');
        expect(sanitizeExportHtml(`<table background="${SVG}#g"><tbody><tr><td>x</td></tr></tbody></table>`)).toBe(
            '<table><tbody><tr><td>x</td></tr></tbody></table>',
        );
    });

    test('a data: URI without a fragment, or with a percent-encoded hash, keeps its reference', () => {
        const kept = `<svg><rect fill="url(${SVG})" mask="url('${SVG}')" filter="url(${SVG}%23f)"></rect></svg>`;
        expect(sanitizeExportHtml(kept)).toBe(kept);
        expect(sanitizeExportHtml(`<div style="mask:url(${SVG})">x</div>`)).toBe(
            `<div style="mask:url(${SVG})">x</div>`,
        );
    });

    // Every fetch needs a function, and a CSS escape cannot spell the `(` that opens one.
    test('a backslash in a presentation attribute with no paren is kept', () => {
        expect(sanitizeExportHtml('<svg><rect fill="\\72 ed"></rect></svg>')).toBe(
            '<svg><rect fill="\\72 ed"></rect></svg>',
        );
    });
});

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

const page = (body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

// Renders the HTML to PDF against a local listener, and counts the connections WeasyPrint opened to it.
async function renderAgainstListener(
    html: (u: (name: string) => string) => string | Promise<string>,
): Promise<{ connections: number; pdf: Buffer }> {
    let connections = 0;
    const server = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
            open(socket) {
                connections++;
                socket.end();
            },
            data() {},
            close() {},
        },
    });
    try {
        const pdf = await htmlToPdf(await html((name) => `http://127.0.0.1:${server.port}/${name}`));
        await Bun.sleep(250); // let any async fetch land before asserting
        return { connections, pdf };
    } finally {
        server.stop(true);
    }
}

const connectionsWhileRendering = async (body: (u: (name: string) => string) => string): Promise<number> =>
    (await renderAgainstListener((u) => page(body(u)))).connections;

// A PDF's streams, inflated where they are compressed: page content, object streams, embedded files.
function pdfStreams(pdf: Buffer): string[] {
    const text = pdf.toString('latin1');
    return [...text.matchAll(/stream\r?\n/g)].map(({ index, 0: open }) => {
        const stream = pdf.subarray(index + open.length, text.indexOf('endstream', index + open.length));
        try {
            return inflateSync(stream).toString('latin1');
        } catch {
            return stream.toString('latin1');
        }
    });
}

suite('PDF export SSRF (WeasyPrint end-to-end)', () => {
    // Mirror an export path: sanitize the assembled body, then render — as every caller does. One body carrying every
    // known vector: plain and CSS-escaped url()/@import in both a style element and a style attribute, and an SVG image
    // and <use> reference through href and xlink:href.
    test('a sanitized body with an injected remote url() triggers no network fetch', async () => {
        const connections = await connectionsWhileRendering((u) =>
            sanitizeExportHtml(
                `<style>.pwn{background:url(${u('a.css')})}@import "${u('b.css')}";` +
                    `@\\69 mport "${u('c.css')}";.pwn2{background:\\75 rl(${u('d.png')})}</style>` +
                    `<div class="pwn" style="width:200px;height:100px;background-image:url(${u('e.png')})">x</div>` +
                    `<div style="background:\\75 rl(${u('f.png')})">y</div>` +
                    `<svg><image href="${u('g.png')}"></image><image xlink:href="${u('h.png')}"></image>` +
                    `<use href="${u('i.svg#g')}"></use><use xlink:href="${u('j.svg#g')}"></use></svg>`,
            ),
        );
        expect(connections).toBe(0);
    });

    // Each of these reached the listener past the url()/quote pair regex: a paren in a quoted URL, in a style
    // attribute, an &quot; string, a <style> rule and an @font-face src, and an uppercase URL(.
    test('a url() whose quoted URL holds a paren, or spelled URL(, triggers no network fetch', async () => {
        const box = 'width:50px;height:50px';
        const connections = await connectionsWhileRendering((u) =>
            sanitizeExportHtml(
                `<div style="${box};background-image:url('${u('a)')}')">a</div>` +
                    `<div style="${box};background-image:url(&quot;${u('b)')}&quot;)">b</div>` +
                    `<style>.c{${box};background-image:url('${u('c)')}')}</style><div class="c">c</div>` +
                    `<style>@font-face{font-family:Z;src:url("${u('d)')}")} p{font-family:Z}</style><p>d</p>` +
                    `<div style="${box};background-image:url('${u("e'")}')">e</div>` +
                    `<div style="${box};background-image:URL(${u('upper')})">f</div>` +
                    `<style>.g{${box};background-image:Url("${u('g)')}")}</style><div class="g">g</div>`,
            ),
        );
        expect(connections).toBe(0);
    });

    // No renderer here fetches a paint server today; the sanitizer is what keeps it that way.
    test('a remote url() in an SVG presentation attribute triggers no network fetch, inline or as media', async () => {
        const connections = await connectionsWhileRendering((u) => {
            const paint = (prefix: string) =>
                ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end']
                    .map((attr) => `${attr}="url(${u(`${prefix}-${attr}.svg#x`)})"`)
                    .join(' ');
            const [media] = sanitizeExportMedia([
                {
                    name: 'a.svg',
                    contentType: 'image/svg+xml',
                    data: toTransferableText(
                        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0h10v10z" ${paint('m')}/></svg>`,
                    ),
                },
            ]);
            const uri = `data:image/svg+xml;base64,${Buffer.from(media.data).toString('base64')}`;
            return (
                `<img src="${uri}">` +
                sanitizeExportHtml(`<svg width="20" height="20"><path d="M0 0h10v10z" ${paint('i')}></path></svg>`)
            );
        });
        expect(connections).toBe(0);
    });

    test('an attr() a collaborator wrote no longer fails the export', async () => {
        const body = sanitizeExportHtml(
            '<p data-x="data:image/png;base64,AAAA" style="width:9px;height:9px;background-image:attr(data-x url)">a</p>' +
                '<style>p::before{content:attr(data-x url)}</style>',
        );
        const pdf = await htmlToPdf(page(body));
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });

    test('a clean data: SVG nested in another still renders', async () => {
        const leaf =
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#00ff00"/></svg>';
        const outer = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="10" height="10" href="${base64Svg(leaf)}"/></svg>`;
        const body = sanitizeExportHtml(`<img src="${percentSvg(outer)}">`);
        const pdf = await htmlToPdf(page(body));
        // WeasyPrint draws an SVG as vector operators, the leaf's green fill one.
        expect(pdfStreams(pdf).join('\n')).toContain('0 1 0 rg');
    });

    test('a data: image and a data: font still render', async () => {
        const pdf = await htmlToPdf(
            page(
                `<style>${getFontFaceCSSForFamilies(['Excalifont'])}</style>` +
                    `<img src="${DATA_PNG}" style="width:50px;height:50px"><p style="font-family:Excalifont">drawn</p>`,
            ),
        );
        const streams = pdfStreams(pdf).join('\n');
        expect(pdf.toString('latin1')).toContain('/Subtype /Image');
        // No system font is named Excalifont: only the data: URI can have embedded it.
        expect(streams).toMatch(/\/BaseFont \/[A-Z]{6}\+Excalifont/);
    });
});

// The render script's fetcher opens only data: URIs, so it holds with the sanitizer bypassed: every body here is raw.
// WeasyPrint's CLI fetched each of these, the attachments embedding the response or the file in the PDF.
suite('PDF export SSRF (the data-only fetcher, sanitizer bypassed)', () => {
    let dir = '';
    let secretPath = '';
    const SECRET = `EIGEN-SSRF-SECRET-${crypto.randomUUID()}`;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'eigen-ssrf-'));
        secretPath = join(dir, 'secret.txt');
        writeFileSync(secretPath, SECRET);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const expectNothingFetched = ({ connections, pdf }: { connections: number; pdf: Buffer }) => {
        expect(connections).toBe(0);
        expect(pdfStreams(pdf).some((stream) => stream.includes(SECRET))).toBe(false);
        expect(pdf.toString('latin1')).not.toContain('/EmbeddedFile');
    };

    const fetchingSvg = (href: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="9" height="9" href="${href}"/><rect width="5" height="5" fill="url(${href}-fill)"/></svg>`;
    const base64 = (bytes: string | Buffer) => Buffer.from(bytes).toString('base64');
    const utf16 = (text: string) => Buffer.from(text, 'utf16le');

    test('a hostile body fetches nothing, from the network or the disk', async () => {
        const result = await renderAgainstListener((u) =>
            page(
                `<a rel="attachment" href="${u('attach')}">a</a>` +
                    `<a rel="attachment" href="${secretPath}">b</a>` +
                    `<a rel="attachment" href="file://${secretPath}">c</a>` +
                    `<a rel="attachment" href="secret.txt">d</a>` +
                    `<img src="${u('img')}"><img src="${u('protocol-relative').replace('http:', '')}">` +
                    `<img src="${secretPath}"><img src="file://${secretPath}">` +
                    `<img src="data:image/svg+xml;base64,${base64(fetchingSvg(u('nested')))}">` +
                    `<img src="data:image/png;base64,${base64(fetchingSvg(u('mistyped')))}">` +
                    `<img src="data:image/png;base64,${base64(utf16(` ${fetchingSvg(u('utf16le'))}`))}">` +
                    `<img src="data:image/png;base64,${base64(utf16(` ${fetchingSvg(u('utf16be'))}`).swap16())}">` +
                    `<div style="width:9px;height:9px;background:url(${u('css')})"></div>` +
                    `<style>@import "${u('import')}";@font-face{font-family:X;src:url(${u('font')})}p{font-family:X}</style>` +
                    `<link rel="stylesheet" href="${u('link')}">` +
                    `<svg width="20" height="20"><image width="9" height="9" href="${u('svg-image')}"></image>` +
                    `<use href="${u('use.svg#g')}"></use></svg>` +
                    `<object data="${u('object')}"></object><embed src="${u('embed')}"><p>x</p>`,
            ),
        );
        expectNothingFetched(result);
    });

    // WeasyPrint's CLI decoded each of these and fetched the drawing's <image href>, xlink:href and fill url(), and
    // parsed a payload Pillow cannot open as SVG under any type.
    test('a data: SVG fetches nothing, in any spelling, nesting or type', async () => {
        const result = await renderAgainstListener((u) => {
            const inner = (name: string, nested = '') =>
                `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><image width="10" height="10" href="${u(name)}"/><image width="10" height="10" xlink:href="${u(`${name}-x`)}"/><rect width="5" height="5" fill="url(${u(`${name}-fill`)})"/>${nested}</svg>`;
            const nested = base64Svg(
                inner('outer', `<image width="5" height="5" href="${base64Svg(inner('inner'))}"/>`),
            );
            const box = 'width:50px;height:50px';
            return page(
                `<img src="${base64Svg(inner('img'))}"><img src="${nested}">` +
                    `<div style="${box};background-image:url('${base64Svg(inner('css'))}')">a</div>` +
                    `<svg width="40" height="40"><image width="20" height="20" href="${base64Svg(inner('svgimg'))}"></image></svg>` +
                    `<img src="${percentSvg(inner('pct'))}">` +
                    `<div style="${box};background:url(${base64Svg(inner('upper'), 'DATA:IMAGE/SVG+XML;BASE64')})">u</div>` +
                    `<img src="${percentSvg(inner('charset'), 'data:image/svg+xml;charset=utf-8')}">` +
                    `<style>.n{${box};background:url("data:image/svg+xml,${inner('raw').replaceAll('"', "'")}")}</style><div class="n">n</div>` +
                    `<img src="${base64Svg(inner('png'), 'data:image/png;base64')}">` +
                    `<img src="${base64Svg(inner('text'), 'data:text/plain;base64')}">` +
                    `<img src="data:,${encodeURIComponent(inner('untyped'))}">` +
                    `<img src="data:image/png;base64 ,${encodeURIComponent(inner('marker'))}">` +
                    `<div style="${box};background-image:url('${base64Svg(inner('font'), 'data:font/woff2;base64')}')">f</div>`,
            );
        });
        expectNothingFetched(result);
    });

    // A doc link mark's rel reaches the anchor as the collaborator wrote it.
    test.each(['http', 'path'] as const)(
        'a doc link with rel=attachment to a %s target fetches nothing',
        async (kind) => {
            const result = await renderAgainstListener(async (u) => {
                const href = kind === 'http' ? u('attach') : secretPath;
                const doc = new Y.Doc();
                const link = { type: 'link', attrs: { href, rel: 'attachment' } };
                seedEigendoc(doc, {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [link] }] }],
                });
                const html = Buffer.from(
                    (await renderEigendocExport(doc, 'pdf-html', 'Doc', [], undefined)).data,
                ).toString();
                expect(html).toContain(`<a rel="attachment" href="${href}"`);
                return html;
            });
            expectNothingFetched(result);
        },
    );

    // A text box keeps only an http(s) or mailto: href (LIGHT_EDITOR_HREF), so no plain path reaches a deck.
    test('a deck link with rel=attachment to an http target fetches nothing', async () => {
        const result = await renderAgainstListener((u) => {
            const scene = buildGoldenDeckScene();
            const html = `<p><a href="${u('attach')}" rel="attachment">x</a></p>`;
            const doc = new Y.Doc();
            seedDeckDoc(doc, { ...scene, elements: scene.elements.map((el) => ('html' in el ? { ...el, html } : el)) });
            const out = Buffer.from(renderEigenslidesExport(doc, 'pdf-html', 'Deck', []).data).toString();
            expect(out).toContain(`<a href="${u('attach')}" rel="attachment"`);
            return out;
        });
        expectNothingFetched(result);
    });
});
