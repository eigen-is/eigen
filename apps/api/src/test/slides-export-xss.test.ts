import { describe, expect, test } from 'bun:test';
import type { SlideItem, TextObject } from '@workspace/lib/slides';
import { renderSlideHtml, renderSlideObjectHtml, responsiveSizeUnit } from '../lib/export/slides/render';

function makeText(overrides: Partial<TextObject>): TextObject {
    return {
        id: 'obj1',
        slideId: 'slide1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        angle: 0,
        borderColor: '',
        borderWidth: 0,
        borderRadius: 0,
        commentCardIds: [],
        text: '',
        fontFamily: 'Inter',
        fontSize: 24,
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        textAlign: 'left',
        verticalAlign: 'top',
        color: '#000000',
        letterSpacing: 0,
        lineHeight: 1.2,
        highlightColor: '',
        background: null,
        ...overrides,
    };
}

describe('slides export XSS', () => {
    test('strips <script> from obj.text', () => {
        const html = renderSlideObjectHtml(
            makeText({ text: '<p>hello</p><script>alert(1)</script>' }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toContain('<script');
        expect(html).not.toContain('alert(1)');
        expect(html).toContain('<p>hello</p>');
    });

    test('strips event handlers like onerror from obj.text', () => {
        const html = renderSlideObjectHtml(
            makeText({ text: '<img src=x onerror="alert(1)">' }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html.toLowerCase()).not.toContain('onerror');
    });

    test('escapes highlightColor so it cannot break out of the style attribute', () => {
        const html = renderSlideObjectHtml(
            makeText({
                text: '<p>hi</p>',
                highlightColor: 'red"><img src=x onerror=alert(1)>',
            }),
            responsiveSizeUnit,
            () => null,
        );
        // Quote + < + > all escaped, so the payload stays inside the style attribute as a (broken) CSS value.
        expect(html).toContain('&quot;');
        expect(html).toContain('&lt;img');
        // No real <img> element ever materializes; the intended next token still follows our value.
        expect(html).not.toMatch(/<img\s/i);
        expect(html).toContain(';box-decoration-break:clone');
    });

    test('preserves legitimate StarterKit output', () => {
        const html = renderSlideObjectHtml(
            makeText({
                text: '<p><strong>bold</strong> <em>italic</em> <a href="https://example.com">link</a></p><ul><li>item</li></ul><blockquote>quote</blockquote>',
            }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<em>italic</em>');
        expect(html).toContain('<a ');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('<ul>');
        expect(html).toContain('<li>item</li>');
        expect(html).toContain('<blockquote>quote</blockquote>');
    });
});

// Colors/fonts are schemaless Yjs strings a collaborator can set to anything — they must
// not be able to break out of style="…" (attribute-breakout XSS) once embedded in the export.
describe('slides export — style-value escaping', () => {
    test('escapes text color', () => {
        const html = renderSlideObjectHtml(
            makeText({ text: '<p>hi</p>', color: 'red;" onload="alert(1)' }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toMatch(/"\s*onload/i);
        expect(html).toContain('&quot;');
    });

    test('escapes borderColor', () => {
        const html = renderSlideObjectHtml(
            makeText({ text: '<p>hi</p>', borderWidth: 2, borderColor: 'red;"><script>alert(1)</script>' }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&lt;script');
        expect(html).toContain('&quot;');
    });

    test('escapes solid text-background color', () => {
        const html = renderSlideObjectHtml(
            makeText({
                text: '<p>hi</p>',
                background: { type: 'solid', color: 'red;"><img src=x onerror=alert(1)>' },
            }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toMatch(/<img\s/i);
        expect(html).toContain('&quot;');
    });

    test('escapes gradient stops', () => {
        const html = renderSlideObjectHtml(
            makeText({
                text: '<p>hi</p>',
                background: { type: 'gradient', from: 'red;"><script>alert(1)</script>', to: 'blue', angle: 45 },
            }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
    });

    test('escapes fontFamily', () => {
        const html = renderSlideObjectHtml(
            makeText({ text: '<p>hi</p>', fontFamily: 'x"><script>alert(1)</script>' }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
    });

    test('escapes the slide background color', () => {
        const slide: SlideItem = {
            id: 's1',
            objectIds: [],
            background: { type: 'solid', color: 'red;"><script>alert(1)</script>' },
        };
        const html = renderSlideHtml(slide, [], responsiveSizeUnit, () => null);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('&quot;');
    });

    test('preserves legitimate colors, fonts and gradients', () => {
        const html = renderSlideObjectHtml(
            makeText({
                text: '<p>hi</p>',
                color: '#ff0000',
                fontFamily: 'Inter',
                background: { type: 'gradient', from: '#000000', to: '#ffffff', angle: 90 },
            }),
            responsiveSizeUnit,
            () => null,
        );
        expect(html).toContain('color:#ff0000');
        expect(html).toContain('background-image:linear-gradient(90deg, #000000, #ffffff)');
        expect(html).toContain('font-family:&#39;Inter&#39;, sans-serif');
    });
});
