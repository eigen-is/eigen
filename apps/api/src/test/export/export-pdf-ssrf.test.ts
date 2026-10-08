import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import * as Y from 'yjs';
import { parseXml } from '../../lib/core/xml';
import { SVG_INLINE_MAX_BYTES, toTransferableText } from '../../lib/document/transform/protocol';
import { renderEigenslidesExport } from '../../lib/export/canvas/transform';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import { sanitizeExportHtml, sanitizeExportMedia } from '../../lib/export/sanitize';
import { renderSheetsExportDocument, renderSheetsPdfDocument } from '../../lib/export/sheets/render';
import { renderEigenvectorExport } from '../../lib/export/vector/transform';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import {
    buildGoldenDeckScene,
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    seedDeckDoc,
    seedEigendoc,
    seedVectorDoc,
} from '../fixtures/golden-documents';

// SSRF regression: a collaborator can inject `url(http://…)` or `<img src=http://…>` into a
// schemaless slide/sheet color or text. It lands in CSS the server-side PDF renderer would
// otherwise fetch (SSRF from the API host). All legit export resources are embedded as `data:`
// URIs, so sanitizeExportHtml — run by every export path before htmlToPdf — strips every non-data
// ref. That layer is tested unconditionally (WeasyPrint's CLI can't restrict protocols, so the
// strip must not depend on the renderer being present); the end-to-end run is skipped where absent.

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
// and the CSS parser reads `URL(` as `url(`. WeasyPrint fetched every one of these past the pair regex.
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
// <svg><image href="http://…">, and WeasyPrint fetches it while rendering.
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

// A data: SVG a collaborator wrote is still an SVG to WeasyPrint, which decodes it and fetches its nested <image href>
// and url(). So one that is not the export's own media takes the media's pass and is written back in its own encoding.
const NESTED_EVIL = 'http://evil.test';
const fetchingSvg = (name: string, inner = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><image width="10" height="10" href="${NESTED_EVIL}/${name}"/><rect id="${name}" width="5" height="5" fill="url(${NESTED_EVIL}/${name}-fill)"/>${inner}</svg>`;
const base64Svg = (svg: string, header = 'data:image/svg+xml;base64') =>
    `${header},${Buffer.from(svg).toString('base64')}`;
const percentSvg = (svg: string, header = 'data:image/svg+xml') => `${header},${encodeURIComponent(svg)}`;

const SVG_DATA_URI = /data:image\/svg\+xml(;charset=utf-8)?(;base64)?,([^"'()\s]*)/gi;

// Every data: SVG in a sanitized string, decoded, and the ones nested in those after them.
function nestedSvgs(text: string): string[] {
    return [...text.matchAll(SVG_DATA_URI)].flatMap(([, , base64, payload]) => {
        const svg = base64 ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
        return [svg, ...nestedSvgs(svg)];
    });
}

// A chain of data: SVGs, each holding a <rect id="lN"> and the next level in its <image href>.
function svgChain(levels: number, uri = base64Svg): string {
    let href = '';
    for (let level = levels; level >= 1; level--) {
        const image = href ? `<image width="5" height="5" href="${href}"/>` : '';
        href = uri(
            `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="l${level}"/>${image}</svg>`,
        );
    }
    return href;
}

const svgMedia = (svg: string) => {
    const [item] = sanitizeExportMedia([
        { name: 'a.svg', contentType: 'image/svg+xml', data: toTransferableText(svg) },
    ]);
    return Buffer.from(item.data).toString('utf8');
};

describe('export sanitize — a data: SVG is sanitized as SVG media are', () => {
    const uri = base64Svg(fetchingSvg('nested'));

    test.each([
        ['an <img src>', `<img src="${uri}">`],
        ['a style url()', `<div style="background-image:url('${uri}')">a</div>`],
        [
            'an SVG <image href>',
            `<svg width="40" height="40"><image width="20" height="20" href="${uri}"></image></svg>`,
        ],
        ['an SVG <image xlink:href>', `<svg><image xlink:href="${uri}"></image></svg>`],
        ['a <style> rule', `<style>.a{background:url("${uri}")}</style><div class="a">a</div>`],
    ])('in %s it keeps its drawing and loses what fetches', (_, html) => {
        const out = sanitizeExportHtml(html);
        const [svg] = nestedSvgs(out);
        expect(parseXml(svg)?.local).toBe('svg');
        expect(svg).toContain('<rect id="nested" width="5" height="5"/>');
        expect(svg).not.toContain('evil.test');
        expect(out).not.toContain(uri);
    });

    test.each([
        ['base64', base64Svg, /data:image\/svg\+xml;base64,/],
        ['percent-encoded', percentSvg, /data:image\/svg\+xml,%3Csvg/],
        [
            'uppercase base64',
            (svg: string) => base64Svg(svg, 'DATA:IMAGE/SVG+XML;BASE64'),
            /data:image\/svg\+xml;base64,/,
        ],
        [
            'uppercase percent-encoded',
            (svg: string) => percentSvg(svg, 'DATA:IMAGE/SVG+XML'),
            /data:image\/svg\+xml,%3Csvg/,
        ],
        [
            'base64 with a charset',
            (svg: string) => base64Svg(svg, 'data:image/svg+xml;charset=utf-8;base64'),
            /data:image\/svg\+xml;charset=utf-8;base64,/,
        ],
        [
            'percent-encoded with a charset and another parameter',
            (svg: string) => percentSvg(svg, 'data:image/svg+xml;charset=UTF-8;foo=bar'),
            /data:image\/svg\+xml;charset=utf-8,%3Csvg/,
        ],
    ])('a %s one is written back in its own encoding', (_, encode, written) => {
        // DOMPurify drops a src whose scheme is not lowercase `data:`; a CSS parser reads any case.
        const out = sanitizeExportHtml(`<p style="background:url('${encode(fetchingSvg('form'))}')">a</p>`);
        expect(out).toMatch(written);
        const [svg] = nestedSvgs(out);
        expect(svg).toContain('<rect id="form" width="5" height="5"/>');
        expect(svg).not.toContain('evil.test');
    });

    // The common way to put an SVG in CSS: unencoded inside a quoted url(), its `%` a literal one.
    test('an unencoded one in a quoted url() keeps its text and its stray %', () => {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg'><text>100%</text><image href='${NESTED_EVIL}/raw'/></svg>`;
        const out = sanitizeExportHtml(`<style>.a{background:url("data:image/svg+xml,${svg}")}.b{color:red}</style>`);
        expect(out).toContain('.b{color:red}');
        const [kept] = nestedSvgs(out);
        expect(kept).toContain('<text>100%</text>');
        expect(kept).not.toContain('evil.test');
    });

    test('one inside SVG media is sanitized too, at every level', () => {
        const media = svgMedia(fetchingSvg('outer', `<image href="${base64Svg(fetchingSvg('inner'))}"/>`));
        expect(media).not.toContain('evil.test');
        const [inner] = nestedSvgs(media);
        expect(inner).toContain('<rect id="inner" width="5" height="5"/>');
        expect(inner).not.toContain('evil.test');
    });

    // The inliner nests sibling SVGs three deep below the one it serves; one deeper than that is no drawing it built.
    test.each([
        [
            'SVG media',
            (chain: string) => svgMedia(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${chain}"/></svg>`),
        ],
        ['an <img src>', (chain: string) => sanitizeExportHtml(`<img src="${chain}">`)],
    ])('in %s, three levels stay and a fourth goes', (_, sanitize) => {
        for (const uri of [base64Svg, percentSvg]) {
            const ids = nestedSvgs(sanitize(svgChain(4, uri))).map((svg) => svg.match(/<rect id="(l\d)"/)?.[1]);
            expect(ids).toEqual(['l1', 'l2', 'l3']);
        }
    });

    test.each([
        ['bad base64', 'data:image/svg+xml;base64,@@@@'],
        ['base64 cut mid-quantum', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=A'],
        ['no <svg> in it', percentSvg('hello <b>x</b>')],
        ['an empty payload', 'data:image/svg+xml,'],
        ['no comma', 'data:image/svg+xml;base64'],
    ])('one with %s is removed like a refused ref', (_, bad) => {
        expect(sanitizeExportHtml(`<img src="${bad}" alt="a">`)).toBe('<img alt="a">');
        expect(sanitizeExportHtml(`<p style="color:red;background:url('${bad}')">a</p>`)).toBe('<p>a</p>');
        const sheet = sanitizeExportHtml(`<style>.a{background:url("${bad}")}.b{color:red}</style>`);
        expect(sheet).toBe('<style>.b{color:red}</style>');
        expect(svgMedia(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${bad}"/></svg>`)).toContain('<image/>');
    });

    test('one longer than the inliner builds is removed', () => {
        const big = base64Svg(
            `<svg xmlns="http://www.w3.org/2000/svg"><desc>${'x'.repeat(SVG_INLINE_MAX_BYTES)}</desc></svg>`,
        );
        expect(sanitizeExportHtml(`<img src="${big}" alt="a">`)).toBe('<img alt="a">');
    });

    test('in a presentation attribute, which paints from none, it is refused with the attribute', () => {
        for (const attr of ['fill', 'filter', 'mask', 'clip-path', 'marker-end']) {
            const out = sanitizeExportHtml(`<svg><rect id="r" ${attr}="url('${uri}#x')"></rect></svg>`);
            expect(out).toBe('<svg><rect id="r"></rect></svg>');
        }
    });

    test('a url() spelling the renderer would read past is removed', () => {
        const uri = percentSvg('<svg xmlns="http://www.w3.org/2000/svg"/>');
        for (const css of [`url('${uri}'x)`, `url(${uri} x)`, `url('${uri}`, `url(${uri}`]) {
            expect(sanitizeExportHtml(`<p style="background:${css}">a</p>`)).toBe('<p>a</p>');
        }
        // An escaped quote in an attribute only a CSS parser ends the string at.
        const escaped = `url('data:image/svg+xml,<svg>\\'<image href=${NESTED_EVIL}/esc>')`;
        expect(sanitizeExportHtml(`<svg><rect fill="${escaped}"></rect></svg>`)).not.toContain('evil.test');
    });

    test('the export’s own media, in allowedRefs, is embedded as the Worker already sanitized it', () => {
        const own = base64Svg(svgMedia(`<svg xmlns="http://www.w3.org/2000/svg"><rect></rect></svg>`));
        const out = sanitizeExportHtml(`<img src="${own}"><div style="background:url(${own})">a</div>`, {
            allowedRefs: new Set([own]),
        });
        expect(out.split(own)).toHaveLength(3);
    });

    test('a data: image of another type passes untouched', () => {
        const font = `data:font/woff2;base64,${Buffer.from('wOF2 font bytes').toString('base64')}`;
        const out = sanitizeExportHtml(
            `<img src="${DATA_PNG}"><style>@font-face{font-family:Z;src:url("${font}") format("woff2")}</style>`,
        );
        expect(out).toContain(`src="${DATA_PNG}"`);
        expect(out).toContain(`src:url("${font}")`);
    });
});

// WeasyPrint opens any image not typed SVG with Pillow, and parses one Pillow cannot read as an SVG. So a data: URI
// whose payload starts as XML is an SVG whatever its type says, read raw or as the base64 its handler decodes.
describe('export sanitize — a data: payload WeasyPrint reads as SVG, whatever its type', () => {
    // No url() in it, which the url( scan would refuse on its own.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${NESTED_EVIL}/mistyped"/></svg>`;
    const b64 = Buffer.from(svg).toString('base64');

    test.each([
        ['typed PNG', `data:image/png;base64,${b64}`],
        ['typed text', `data:text/plain;base64,${b64}`],
        ['typed as a font', `data:font/woff2;base64,${b64}`],
        ['untyped and percent-encoded', `data:,${encodeURIComponent(svg)}`],
        ['led by whitespace', `data:image/png;base64,${Buffer.from(`\n\t  ${svg}`).toString('base64')}`],
        ['led by encoded whitespace', `data:image/png,%20%0A${encodeURIComponent(svg)}`],
        ['led by a UTF-8 byte order mark', `data:image/png;base64,${Buffer.from(`\ufeff${svg}`).toString('base64')}`],
        ['in UTF-16', `data:image/png;base64,${Buffer.from(`\ufeff${svg}`, 'utf16le').toString('base64')}`],
        ['base64 led by characters the decoder skips', `data:image/png;base64,!!!!${b64}`],
        ['base64 percent-encoded', `data:image/png;base64,${b64.replace(/P/g, '%50')}`],
        ['behind a base64 marker the handler does not read', `data:image/png;base64 ,${encodeURIComponent(svg)}`],
    ])('one %s is removed', (_, uri) => {
        expect(sanitizeExportHtml(`<img src="${uri}" alt="a">`)).toBe('<img alt="a">');
        expect(sanitizeExportHtml(`<p style="color:red;background:url('${uri}')">a</p>`)).toBe('<p>a</p>');
        expect(sanitizeExportHtml(`<style>.a{background:url("${uri}")}.b{color:red}</style>`)).toBe(
            '<style>.b{color:red}</style>',
        );
        expect(sanitizeExportHtml(`<svg><rect id="r" fill="url('${uri}')"></rect></svg>`)).toBe(
            '<svg><rect id="r"></rect></svg>',
        );
        expect(svgMedia(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${uri}"/></svg>`)).toContain('<image/>');
    });

    test.each([
        ['a PNG', DATA_PNG],
        ['a JPEG', `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`],
        ['a font', `data:font/woff2;base64,${Buffer.from('wOF2\0\x01').toString('base64')}`],
        ['a percent-encoded text', 'data:text/plain,hello%20world'],
    ])('%s passes untouched', (_, uri) => {
        expect(sanitizeExportHtml(`<img src="${uri}">`)).toBe(`<img src="${uri}">`);
        expect(sanitizeExportHtml(`<style>.a{background:url("${uri}")}</style>`)).toBe(
            `<style>.a{background:url("${uri}")}</style>`,
        );
    });
});

// Each arm embeds the media the Worker sanitized, so a drawing the inliner nested three deep keeps every level.
describe('export sanitize — every arm embeds its own media as sanitized', () => {
    const OWN = sanitizeExportMedia([
        {
            name: GOLDEN_MEDIA_NAME,
            contentType: 'image/svg+xml',
            data: toTransferableText(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${svgChain(3)}"/></svg>`),
        },
    ]);
    const embedded = base64Svg(Buffer.from(OWN[0].data).toString('utf8'));
    const text = (data: ArrayBuffer) => Buffer.from(data).toString('utf8');

    test.each(['html', 'pdf-html'] as const)('a doc figure, %s', async (format) => {
        const doc = new Y.Doc();
        seedEigendoc(doc, { type: 'doc', content: [{ type: 'figure', attrs: { mediaName: GOLDEN_MEDIA_NAME } }] });
        const { data } = await renderEigendocExport(doc, format, 'Doc', OWN, undefined);
        expect(text(data)).toContain(embedded);
    });

    test.each(['html', 'pdf-html'] as const)('a deck image and frame background, %s', (format) => {
        const doc = new Y.Doc();
        seedDeckDoc(doc, buildGoldenDeckScene());
        expect(text(renderEigenslidesExport(doc, format, 'Deck', OWN).data)).toContain(embedded);
    });

    test.each(['svg', 'pdf-html'] as const)('a drawing image, %s', (format) => {
        const doc = new Y.Doc();
        seedVectorDoc(doc, buildGoldenVectorScene());
        expect(text(renderEigenvectorExport(doc, format, 'Drawing', OWN).data)).toContain(embedded);
    });

    test.each([
        ['html', renderSheetsExportDocument],
        ['pdf-html', renderSheetsPdfDocument],
    ])('a sheet image, %s', (_, render) => {
        const sheet = {
            name: 'Sheet1',
            celldata: [],
            images: [{ id: 'img_1', mediaName: GOLDEN_MEDIA_NAME, x: 0, y: 0, width: 10, height: 10 }],
        };
        expect(render([sheet], 'Sheet', new Map([[GOLDEN_MEDIA_NAME, embedded]]))).toContain(embedded);
    });
});

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

// Renders the sanitized body to PDF against a local listener, and counts the connections WeasyPrint opened to it.
async function connectionsWhileRendering(body: (u: (name: string) => string) => string): Promise<number> {
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
        const html = body((name) => `http://127.0.0.1:${server.port}/${name}`);
        await htmlToPdf(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
        await Bun.sleep(250); // let any async fetch land before asserting
        return connections;
    } finally {
        server.stop(true);
    }
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

    // nested.ts: a collaborator's data: SVG in an <img>, a style url() and an SVG <image> reached the listener as /img,
    // /css and /svgimg, through the drawing's own <image href> and fill url().
    test('a data: SVG a collaborator wrote triggers no network fetch, in any spelling or nesting', async () => {
        const connections = await connectionsWhileRendering((u) => {
            const inner = (name: string, nested = '') =>
                `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><image width="10" height="10" href="${u(name)}"/><image width="10" height="10" xlink:href="${u(`${name}-x`)}"/><rect width="5" height="5" fill="url(${u(`${name}-fill`)})"/>${nested}</svg>`;
            const nested = base64Svg(
                inner('outer', `<image width="5" height="5" href="${base64Svg(inner('inner'))}"/>`),
            );
            const [media] = sanitizeExportMedia([
                {
                    name: 'a.svg',
                    contentType: 'image/svg+xml',
                    data: toTransferableText(inner('media', `<image href="${nested}"/>`)),
                },
            ]);
            const body = sanitizeExportHtml(
                `<img src="${base64Svg(inner('img'))}">` +
                    `<div style="width:50px;height:50px;background-image:url('${base64Svg(inner('css'))}')">a</div>` +
                    `<svg width="40" height="40"><image width="20" height="20" href="${base64Svg(inner('svgimg'))}"></image></svg>` +
                    `<img src="${percentSvg(inner('pct'))}">` +
                    `<div style="width:50px;height:50px;background:url(${base64Svg(inner('upper'), 'DATA:IMAGE/SVG+XML;BASE64')})">u</div>` +
                    `<img src="${percentSvg(inner('charset'), 'data:image/svg+xml;charset=utf-8')}">` +
                    `<style>.n{width:50px;height:50px;background:url("data:image/svg+xml,${inner('raw').replaceAll('"', "'")}")}</style><div class="n">n</div>` +
                    `<img src="${nested}">`,
            );
            // The media pass's output, embedded as an arm embeds it.
            return `${body}<img src="${base64Svg(Buffer.from(media.data).toString('utf8'))}">`;
        });
        expect(connections).toBe(0);
    });

    // WeasyPrint fetched each of these: Pillow cannot open them, so it parsed them as the SVG they are.
    test('an SVG under another data: type triggers no network fetch', async () => {
        const connections = await connectionsWhileRendering((u) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="10" height="10" href="${u('mistyped')}"/></svg>`;
            const b64 = Buffer.from(svg).toString('base64');
            return sanitizeExportHtml(
                `<img src="data:image/png;base64,${b64}">` +
                    `<img src="data:text/plain;base64,${b64}">` +
                    `<img src="data:,${encodeURIComponent(svg)}">` +
                    `<img src="data:image/png;base64 ,${encodeURIComponent(svg)}">` +
                    `<div style="width:50px;height:50px;background-image:url('data:font/woff2;base64,${b64}')">a</div>`,
            );
        });
        expect(connections).toBe(0);
    });

    test('a clean data: SVG nested in another still renders', async () => {
        const leaf =
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#00ff00"/></svg>';
        const outer = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="10" height="10" href="${base64Svg(leaf)}"/></svg>`;
        const body = sanitizeExportHtml(`<img src="${percentSvg(outer)}">`);
        const pdf = await htmlToPdf(
            `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
        );
        // The page's content streams, inflated: WeasyPrint draws an SVG as vector operators, the leaf's green fill one.
        const text = pdf.toString('latin1');
        const streams = [...text.matchAll(/stream\r?\n/g)].map(({ index, 0: open }) => {
            const start = index + open.length;
            try {
                return inflateSync(pdf.subarray(start, text.indexOf('endstream', start))).toString('latin1');
            } catch {
                return '';
            }
        });
        expect(streams.join('\n')).toContain('0 1 0 rg');
    });

    test('an embedded data: image still renders (legit resources unaffected)', async () => {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><img src="${DATA_PNG}" style="width:50px;height:50px"></body></html>`;
        const pdf = await htmlToPdf(html);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });
});
