import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, getSchema } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { getFontName } = await import('@workspace/lib/constants/fonts');
const { cleanPastedHTML } = await import('../../../components/docs/paste');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');

const schema = getSchema(getDocExtensions());

// The name the textStyle mark's parseHTML reads from the pasted stack.
function pastedFont(fontFamily: string): string {
    const html = cleanPastedHTML(`<p><span style="font-family: ${fontFamily}">x</span></p>`, 600, new Set());
    const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span');
    if (!span) throw new Error('span gone');
    return getFontName(span.style.fontFamily);
}

describe('paste maps foreign fonts onto the bundled ones', () => {
    test.each([
        ['Times New Roman', 'Source Serif 4'],
        ['Georgia', 'Source Serif 4'],
        ['Palatino', 'Source Serif 4'],
        ['Palatino Linotype', 'Source Serif 4'],
        ['Courier New', 'JetBrains Mono'],
        ['Consolas', 'JetBrains Mono'],
        ['Comic Sans MS', 'Excalifont'],
    ])('%s pastes as %s', (font, bundled) => {
        expect(pastedFont(`'${font}'`)).toBe(bundled);
    });

    test.each([
        ['Garamond', 'Source Serif 4'],
        ['Lora', 'Source Serif 4'],
        ['Menlo', 'JetBrains Mono'],
        ['Source Serif 4', 'Source Serif 4'],
    ])('%s pastes as %s through the shared font map', (font, bundled) => {
        expect(pastedFont(`'${font}'`)).toBe(bundled);
    });

    test.each(['Arial', 'Calibri', 'Roboto', 'Inter', 'Wingdings', "'Times New Roman', serif"])(
        '%s pastes in the document font',
        (font) => {
            expect(pastedFont(font)).toBe('');
        },
    );
});

// Word's clipboard spells caps as CSS on the run's span, beside the font the cleaner rewrites.
describe('paste keeps caps', () => {
    test.each([
        ["font-family:'Times New Roman';text-transform:uppercase", 'all'],
        ['font-family:Calibri;font-variant:small-caps', 'small'],
        ['font-variant:normal;text-transform:none', null],
    ])('%s pastes as caps %s', (style, caps) => {
        const html = cleanPastedHTML(`<p><span style="${style}">x</span></p>`, 600, new Set());
        const marks = createDocument(html, schema).firstChild?.firstChild?.marks ?? [];
        expect(marks.find((mark) => mark.type.name === 'textStyle')?.attrs['caps'] ?? null).toBe(caps);
    });
});

// Google Docs spells its italic Heading 6 on every run, and a run in it set upright as font-style normal. Heading 6
// draws an italic mark upright, so the upright run is the mark and the italic one plain.
test('an upright run in a pasted Google Docs Heading 6 is italic, its italic runs are not', () => {
    const span = (text: string, fontStyle: string) =>
        `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#666666;font-weight:400;font-style:${fontStyle};">${text}</span>`;
    const html =
        `<b style="font-weight:normal;" id="docs-internal-guid-1"><h6 dir="ltr">${span('Fine ', 'italic')}${span('print', 'normal')}</h6>` +
        `<p dir="ltr">${span('Said ', 'italic')}${span('plainly', 'normal')}</p></b>`;
    const runs: [string, string[]][] = [];
    createDocument(cleanPastedHTML(html, 600, new Set()), schema).descendants((node) => {
        if (node.isText) runs.push([node.text ?? '', node.marks.map((mark) => mark.type.name)]);
    });
    expect(runs.map(([text, marks]) => [text, marks.includes('italic')])).toEqual([
        ['Fine ', false],
        ['print', true],
        ['Said ', true],
        ['plainly', false],
    ]);
});

// A run's look is its nearest font-style, so an italic run inside an upright one stays plain.
test.each([
    ['an upright heading', '<h6 style="font-style:normal">a<span style="font-style:italic">b</span>c</h6>'],
    ['an upright run', '<h6><span style="font-style:normal">a<span style="font-style:italic">b</span>c</span></h6>'],
])('an italic run inside %s of a pasted Heading 6 stays plain', (_name, html) => {
    const runs: [string, boolean][] = [];
    createDocument(cleanPastedHTML(html, 600, new Set()), schema).descendants((node) => {
        if (node.isText) runs.push([node.text ?? '', node.marks.some((mark) => mark.type.name === 'italic')]);
    });
    expect(runs).toEqual([
        ['a', true],
        ['b', false],
        ['c', true],
    ]);
});

// A docs copy pasted back through ProseMirror's own HTML, the way a docs editor reads it.
describe('a docs copy pastes back as it was copied', () => {
    const figure = {
        type: 'figure',
        attrs: { mediaName: 'a.png', width: 200, caption: 'Sales', alignment: 'right', layout: 'wrap-left' },
    };
    const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
    const text = (t: string) => ({ type: 'text', text: t });

    test.each([
        [
            'a figure in a paragraph of its own adds no empty paragraphs',
            [paragraph(text('a')), paragraph(figure), paragraph(text('b'))],
        ],
        ['a figure between text keeps its paragraph whole', [paragraph(text('a'), figure, text('b'))]],
    ])('%s', (_name, content) => {
        const source = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
        const { dom } = source.view.serializeForClipboard(source.state.doc.slice(0, source.state.doc.content.size));
        const target = new Editor({
            extensions: getDocExtensions(),
            editorProps: { transformPastedHTML: (html) => cleanPastedHTML(html, 600, new Set()) },
        });
        target.view.pasteHTML(dom.innerHTML);
        expect(target.getJSON()).toEqual(source.getJSON());
    });
});

// A cut keeps its comment because the card stays in the document's map; another document's card is not there.
test('paste keeps the comment anchors this document has cards for and strips the rest', () => {
    const html =
        '<p><span data-comment-id="here">a</span><span data-comment-id="elsewhere">b</span></p>' +
        '<p><span class="figure" data-comment-id="here"><img data-media-name="a.png"></span>' +
        '<span class="figure" data-comment-id="elsewhere"><img data-media-name="b.png"></span></p>';
    const anchors: unknown[][] = [];
    createDocument(cleanPastedHTML(html, 600, new Set(['here'])), schema).descendants((node) => {
        const mark = node.marks.find((m) => m.type.name === 'comment');
        if (node.isLeaf)
            anchors.push([node.text ?? node.attrs.mediaName, node.attrs.commentCardId, mark?.attrs.cardId]);
    });
    expect(anchors).toEqual([
        ['a', undefined, 'here'],
        ['b', undefined, undefined],
        ['a.png', 'here', undefined],
        ['b.png', null, undefined],
    ]);
});
