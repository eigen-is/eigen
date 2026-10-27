import { describe, expect, test } from 'bun:test';
import { countTaskItems, escapeHtml, stripTagsServer, unescapeHtml } from '../../core/html';

describe('countTaskItems', () => {
    const item = (checked: boolean, text: string) =>
        `<li data-checked="${checked}" data-type="taskItem"><label><input type="checkbox"${checked ? ' checked="checked"' : ''}></label><div><p>${text}</p></div></li>`;

    test('counts the checked and total items of a task list', () => {
        const html = `<p>Intro</p><ul data-type="taskList">${item(true, 'A')}${item(false, 'B')}${item(true, 'C')}</ul>`;
        expect(countTaskItems(html)).toEqual({ checked: 2, total: 3 });
    });

    test('a nested task list counts too, and a plain list item does not', () => {
        const nested = `<ul data-type="taskList">${item(true, 'Child')}</ul>`;
        const parent = `<li data-checked="false" data-type="taskItem"><label><input type="checkbox"></label><div><p>Parent</p>${nested}</div></li>`;
        const html = `<ul><li>Plain</li></ul><ul data-type="taskList">${parent}</ul>`;
        expect(countTaskItems(html)).toEqual({ checked: 1, total: 2 });
    });

    test('text that only mentions data-checked counts nothing', () => {
        expect(countTaskItems('<p>Just text with data-checked="true" in it</p>')).toEqual({ checked: 0, total: 0 });
        expect(countTaskItems('')).toEqual({ checked: 0, total: 0 });
    });
});

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

    // A `<` the tag pattern can't close must not rescan the rest of the input: 64 KiB of them took a second.
    test('strips in linear time when no tag closes', () => {
        const start = performance.now();
        stripTagsServer('<'.repeat(64 * 1024));
        expect(performance.now() - start).toBeLessThan(100);
        expect(stripTagsServer('a < b <p>c</p>')).toBe('a < b c');
    });

    // A raw-text element's content is code or a fallback no page shows, never text: drop it whole.
    test('drops script, style, title, noscript and iframe with their content', () => {
        expect(stripTagsServer('<title>T</title><style>p{}</style><p>a<script>x<y</script>b</p>')).toBe('ab');
        expect(stripTagsServer('<NoScript><p>n</p></noscript><iframe>f</iframe>c')).toBe('c');
        expect(stripTagsServer('<p>a</p><stylex>b</stylex><styles>c')).toBe('a\n\nbc');
    });

    test('an unclosed raw-text element swallows the rest, in linear time', () => {
        expect(stripTagsServer('a<style>b</styl')).toBe('a');
        expect(stripTagsServer('a<script>b</script')).toBe('a');
        const start = performance.now();
        stripTagsServer('<style> </style'.repeat(4 * 1024));
        stripTagsServer('<p><script>'.repeat(4 * 1024));
        expect(performance.now() - start).toBeLessThan(100);
    });

    test('handles empty input', () => {
        expect(stripTagsServer('')).toBe('');
    });

    // The decode order is the same one unescapeHtml documents: `&amp;` last, so an
    // escaped entity stays the literal text it was. Decoding it first turned
    // `&amp;lt;` into a `<` the source never contained.
    test('decodes &amp; last so an escaped entity stays literal', () => {
        expect(stripTagsServer('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
    });

    test('still decodes the other entities and &nbsp;', () => {
        expect(stripTagsServer('<p>a&nbsp;&amp;&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>')).toBe(
            `a & b <c> "d" 'e'`,
        );
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
