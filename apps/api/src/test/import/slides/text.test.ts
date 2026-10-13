import { describe, expect, test } from 'bun:test';
import { MAX_HTML_BYTES } from '@workspace/lib/vector';
import { parseOoxml } from '../../../lib/core/ooxml';
import type { SlideTheme } from '../../../lib/import/slides/inherit';
import { richTextOf } from '../../../lib/import/slides/text';
import { NS, para, run } from '../../fixtures/pptx';

// A text body as one rich-text box: its paragraphs as HTML, the box styled by the run most of its text is in.

const THEME: SlideTheme = {
    colors: {
        scheme: new Map([
            ['dk1', '#000000'],
            ['accent1', '#4f81bd'],
        ]),
        map: new Map([
            ['tx1', 'dk1'],
            ['accent1', 'accent1'],
        ]),
    },
    fonts: { major: 'Georgia', minor: 'Consolas' },
    formats: undefined,
};

function textOf(paragraphs: string) {
    const body = parseOoxml(`<p:txBody ${NS}><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`);
    if (!body) throw new Error('no body');
    // 6,350 EMU a px: a point is 2 px.
    return richTextOf({ body, inherited: [], listStyle: undefined, style: undefined }, THEME, 1 / 6350);
}

describe('a text body', () => {
    test('is one paragraph each, escaped, its breaks and fields kept', () => {
        const html = textOf(
            `${para('a &lt;b&gt; &amp; "c"')}<a:p>${run('one')}<a:br/>${run('two')}<a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld></a:p><a:p/>`,
        )?.html;
        expect(html).toBe('<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>one<br>two3</p><p></p>');
    });

    test('with no visible text is none', () => {
        expect(textOf('<a:p/>')).toBeUndefined();
        expect(textOf(para('   '))).toBeUndefined();
    });

    test('takes its font, size and colour from the run that covers the most characters', () => {
        const heading = '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/>';
        const found = textOf(`<a:p>${run('tiny', ' sz="800"')}${run('most of the text', ' sz="2400"', heading)}</a:p>`);
        expect(found).toMatchObject({ fontSize: 48, color: '#4f81bd', fontFamily: 'Source Serif 4' });
        expect(textOf(para('plain'))).toMatchObject({ fontSize: 36, color: '#000000', fontFamily: 'Inter' });
        expect(textOf(para('code', '', '<a:latin typeface="+mn-lt"/>'))).toMatchObject({
            fontFamily: 'JetBrains Mono',
        });
    });

    test(`is cut at a paragraph so its HTML stays within the ${MAX_HTML_BYTES} bytes the canvas keeps`, () => {
        const paragraph = para('x'.repeat(1000));
        const html = textOf(paragraph.repeat(100))?.html ?? '';
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MAX_HTML_BYTES);
        expect(html.endsWith('</p>')).toBe(true);
        expect(html.split('<p>')).toHaveLength(Math.floor(MAX_HTML_BYTES / 1007) + 1);
    });
});
