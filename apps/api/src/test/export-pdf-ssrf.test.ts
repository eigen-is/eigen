import { describe, expect, test } from 'bun:test';
import { sanitizeExportHtml } from '../lib/export/sanitize';
import { htmlToPdf, isWeasyPrintAvailable } from '../lib/export/weasyprint';

// SSRF regression: a collaborator can inject `url(http://…)` or `<img src=http://…>` into a
// schemaless slide/sheet color or text. It lands in CSS the server-side PDF renderer would
// otherwise fetch (SSRF from the API host). All legit export resources are embedded as `data:`
// URIs, so sanitizeExportHtml — run by every export path before htmlToPdf — strips every non-data
// ref. That layer is tested unconditionally (WeasyPrint's CLI can't restrict protocols, so the
// strip must not depend on the renderer being present); the end-to-end run is skipped where absent.

// 1x1 PNG — the only legitimate resource shape exports embed (fonts/images are data: URIs).
const DATA_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
});

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

suite('PDF export SSRF (WeasyPrint end-to-end)', () => {
    test('a sanitized body with an injected remote url() triggers no network fetch', async () => {
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
            // Mirror an export path: sanitize the assembled body, then render — as every
            // caller does. One body carrying every known vector: plain and CSS-escaped
            // url()/@import in both a style element and a style attribute, and an SVG
            // image reference through href and xlink:href.
            const u = (name: string) => `http://127.0.0.1:${server.port}/${name}`;
            const body = sanitizeExportHtml(
                `<style>.pwn{background:url(${u('a.css')})}@import "${u('b.css')}";` +
                    `@\\69 mport "${u('c.css')}";.pwn2{background:\\75 rl(${u('d.png')})}</style>` +
                    `<div class="pwn" style="width:200px;height:100px;background-image:url(${u('e.png')})">x</div>` +
                    `<div style="background:\\75 rl(${u('f.png')})">y</div>` +
                    `<svg><image href="${u('g.png')}"></image><image xlink:href="${u('h.png')}"></image></svg>`,
            );
            await htmlToPdf(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
            await Bun.sleep(250); // let any async fetch land before asserting
            expect(connections).toBe(0);
        } finally {
            server.stop(true);
        }
    });

    test('an embedded data: image still renders (legit resources unaffected)', async () => {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><img src="${DATA_PNG}" style="width:50px;height:50px"></body></html>`;
        const pdf = await htmlToPdf(html);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });
});
