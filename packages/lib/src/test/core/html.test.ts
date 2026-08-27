import { describe, expect, test } from 'bun:test';
import { escapeHtml, stripTagsServer, unescapeHtml } from '../../core/html';

describe('stripTagsServer', () => {
    test('strips simple tags', () => {
        expect(stripTagsServer('<p>hello <b>world</b></p>')).toBe('hello world');
    });

    test('decodes common entities', () => {
        expect(stripTagsServer('&amp; &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39;')).toBe(
            '& <tag> "quoted" \'apos\'',
        );
    });

    test('preserves block-level whitespace', () => {
        expect(stripTagsServer('<p>line one</p><p>line two</p>')).toBe('line one\n\nline two');
    });

    test('collapses redundant whitespace', () => {
        expect(stripTagsServer('  <p>  hello   world  </p>  ')).toBe('hello world');
    });

    test('handles empty input', () => {
        expect(stripTagsServer('')).toBe('');
    });
});

describe('unescapeHtml', () => {
    test('round-trips escapeHtml', () => {
        for (const raw of ['a & b', '<img src=x>', `it's "quoted"`, '=A1<>B1', 'plain']) {
            expect(unescapeHtml(escapeHtml(raw))).toBe(raw);
        }
    });

    test('decodes &amp; last so an escaped entity stays literal', () => {
        // `&lt;` typed by a user escapes to `&amp;lt;` and must come back as `&lt;`, not `<`.
        expect(unescapeHtml(escapeHtml('&lt;'))).toBe('&lt;');
    });
});
