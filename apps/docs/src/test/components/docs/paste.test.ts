import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, getSchema } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { DOCUMENT_FONT, getFontName } = await import('@workspace/lib/constants/fonts');
const { cleanPastedHTML } = await import('../../../components/docs/paste');
const { DEFAULT_PAGE_SETUP, getDocExtensions } = await import('@workspace/lib/docs/eigendoc');

// An 800 px paper with 100 px margins: a 600 px text column.
const PAGE = { ...DEFAULT_PAGE_SETUP, width: 800, margin: { top: 100, right: 100, bottom: 100, left: 100 } };

const schema = getSchema(getDocExtensions());

// The name the textStyle mark's parseHTML reads from the pasted stack.
function pastedFont(fontFamily: string, normalFont = DOCUMENT_FONT): string {
    const html = cleanPastedHTML(
        `<p><span style="font-family: ${fontFamily}">x</span></p>`,
        PAGE,
        new Set(),
        normalFont,
    );
    const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span');
    if (!span) throw new Error('span gone');
    return getFontName(span.style.fontFamily);
}

// Text without a mark draws in the doc's Normal font, so only that font goes, Inter staying a mark in a Times doc.
test("a font is dropped only where it is the doc's Normal font", () => {
    expect(pastedFont('Arial', 'Source Serif 4')).toBe('Inter');
    expect(pastedFont("'Times New Roman'", 'Source Serif 4')).toBe('');
    expect(pastedFont('Arial')).toBe('');
});

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

    // Google Docs writes a run's font as a stack, Word as a quoted name before its generic family.
    test.each([
        ["'Times New Roman', serif", 'Source Serif 4'],
        ['Georgia,serif', 'Source Serif 4'],
        ["'Source Serif 4', serif", 'Source Serif 4'],
        ["Wingdings, 'Courier New', monospace", 'JetBrains Mono'],
    ])('the stack %s pastes as its first bundled family, %s', (stack, bundled) => {
        expect(pastedFont(stack)).toBe(bundled);
    });

    test.each(['Arial', 'Calibri', 'Roboto', 'Inter', 'Wingdings', 'Arial, serif'])(
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
        const html = cleanPastedHTML(`<p><span style="${style}">x</span></p>`, PAGE, new Set(), DOCUMENT_FONT);
        const marks = createDocument(html, schema).firstChild?.firstChild?.marks ?? [];
        expect(marks.find((mark) => mark.type.name === 'textStyle')?.attrs['caps'] ?? null).toBe(caps);
    });
});

// Google Docs writes a size on every span, its body's 11 pt and a heading's own included, which the doc draws already.
describe('paste keeps a size the doc does not draw', () => {
    const pastedSizes = (html: string) => {
        const sizes: [string, unknown][] = [];
        createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
            if (node.isText)
                sizes.push([
                    node.text ?? '',
                    node.marks.find((mark) => mark.type.name === 'textStyle')?.attrs['fontSize'] ?? null,
                ]);
        });
        return sizes;
    };

    test("the body's 11 pt is no size, another one is", () => {
        expect(
            pastedSizes(
                '<p><span style="font-size:11pt">body </span><span style="font-size:14pt">big </span><span style="font-size:16px">px</span></p>',
            ),
        ).toEqual([
            ['body ', null],
            ['big ', 14],
            ['px', 12],
        ]);
    });

    test("another app's heading draws at the doc's heading size", () => {
        expect(
            pastedSizes('<b id="docs-internal-guid-1"><h1 dir="ltr"><span style="font-size:20pt">Plan</span></h1></b>'),
        ).toEqual([['Plan', null]]);
    });

    test("a docs copy keeps its sizes, the body's in a heading included", () => {
        const sized = (text: string, fontSize: number) => ({
            type: 'text',
            text,
            marks: [{ type: 'textStyle', attrs: { fontSize } }],
        });
        const source = new Editor({
            extensions: getDocExtensions(),
            content: {
                type: 'doc',
                content: [
                    { type: 'heading', attrs: { level: 1 }, content: [sized('big', 30), sized('body', 11)] },
                    { type: 'paragraph', content: [sized('fine', 9)] },
                ],
            },
        });
        const { dom } = source.view.serializeForClipboard(source.state.doc.slice(0, source.state.doc.content.size));
        expect(pastedSizes(dom.innerHTML)).toEqual([
            ['big', 30],
            ['body', 11],
            ['fine', 9],
        ]);
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
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
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
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.isText) runs.push([node.text ?? '', node.marks.some((mark) => mark.type.name === 'italic')]);
    });
    expect(runs).toEqual([
        ['a', true],
        ['b', false],
        ['c', true],
    ]);
});

// D13: Google Docs writes its body's line height and margins on every paragraph, which would read as a format typed
// text lacks; another app's paragraph CSS is its own look, so a paste takes the doc's.
test("a paragraph pasted from Google Docs takes the doc's spacing and indents", () => {
    const html =
        '<b id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;margin-left:36pt;text-indent:-18pt"><span style="font-size:11pt">a</span></p></b>';
    const formats: Record<string, unknown>[] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'paragraph')
            formats.push(
                Object.fromEntries(
                    Object.entries(node.attrs).filter(([key, value]) => key !== 'textAlign' && value !== null),
                ),
            );
    });
    expect(formats).toEqual([{}]);
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
        [
            'a heading and a paragraph keep their spacing and indents',
            [
                { type: 'heading', attrs: { level: 2, spaceBefore: 6, indentLeft: 36 }, content: [text('a')] },
                {
                    type: 'paragraph',
                    attrs: { lineSpacing: 1.15, spaceAfter: 0, indentFirstLine: -18 },
                    content: [text('b')],
                },
            ],
        ],
    ])('%s', (_name, content) => {
        const source = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
        const { dom } = source.view.serializeForClipboard(source.state.doc.slice(0, source.state.doc.content.size));
        const target = new Editor({
            extensions: getDocExtensions(),
            editorProps: { transformPastedHTML: (html) => cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT) },
        });
        target.view.pasteHTML(dom.innerHTML);
        expect(target.getJSON()).toEqual(source.getJSON());
    });
});

test('a pasted chart wider than the column shrinks to it, keeping its shape', () => {
    const html =
        '<p><span class="chart" data-chart="{}" data-width="1200" data-height="742"></span>' +
        '<span class="chart" data-chart="{}" data-width="400" data-height="300"></span></p>';
    const sizes: unknown[][] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'chart') sizes.push([node.attrs.width, node.attrs.height]);
    });
    expect(sizes).toEqual([
        [600, 371],
        [400, 300],
    ]);
});

// A cut keeps its comment because the card stays in the document's map; another document's card is not there.
test('paste keeps the comment anchors this document has cards for and strips the rest', () => {
    const html =
        '<p><span data-comment-id="here">a</span><span data-comment-id="elsewhere">b</span></p>' +
        '<p><span class="figure" data-comment-id="here"><img data-media-name="a.png"></span>' +
        '<span class="figure" data-comment-id="elsewhere"><img data-media-name="b.png"></span></p>';
    const anchors: unknown[][] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(['here']), DOCUMENT_FONT), schema).descendants((node) => {
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

// The schema's reading of each <math> is the equation node's (packages/lib's equation tests); here only that the paste
// drops a drawn equation's glyphs first.
test("a KaTeX equation's drawn glyphs are not pasted beside its <math>", () => {
    const math =
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>';
    const drawn = `<span class="katex"><span class="katex-mathml">${math}</span><span class="katex-html" aria-hidden="true"><span class="mord mathnormal">x</span></span></span>`;
    expect(cleanPastedHTML(`<p>a ${drawn} b</p>`, PAGE, new Set(), DOCUMENT_FONT)).toBe(
        cleanPastedHTML(`<p>a ${math} b</p>`, PAGE, new Set(), DOCUMENT_FONT),
    );
});

// A positioned image keeps to the paper: 800 px, its paragraph taken at the column's left, 100 px in, and below the
// page's top, its paragraph taken at the column's top, 100 px down.
test.each([
    [900, 50, 30, 800, -100, 30],
    [300, 600, 30, 300, 400, 30],
    [300, -500, -500, 300, -100, -100],
])('a pasted %d px image in front of the text at %d, %d is %d px wide at %d, %d', (width, x, y, capped, cx, cy) => {
    const html = `<p><span class="figure" data-layout="front" data-offset-x="${x}" data-offset-y="${y}"><img src="data:image/png;base64," width="${width}"></span>x</p>`;
    const found: object[] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'figure') found.push(node.attrs);
    });
    expect(found).toMatchObject([{ layout: 'front', width: capped, offsetX: cx, offsetY: cy }]);
});

// The HTML download writes the box's width as data-width and the image's only as a style, so the paste reads the box's.
test('a pasted image from the HTML download keeps on the paper by its width', () => {
    const html =
        '<p><span class="figure" data-layout="front" data-alignment="center" data-offset-x="550" data-offset-y="0" data-width="300" style="left: 550px; top: 0px; width: 300px"><img src="data:image/png;base64," alt="" style="width: 300px; max-width: 100%" /></span>x</p>';
    const found: object[] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'figure') found.push(node.attrs);
    });
    expect(found).toMatchObject([{ layout: 'front', width: 300, offsetX: 400 }]);
});

// A text box keeps its width on its own span inside the frame, beside its paragraphs, so the paste reads the box's.
test('a pasted text box in front of the text keeps on the paper by its own width', () => {
    const doc = schema.nodeFromJSON({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    {
                        type: 'textBox',
                        attrs: { layout: 'front', offsetX: 550, offsetY: 0, width: 300 },
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] }],
                    },
                    { type: 'text', text: 'x' },
                ],
            },
        ],
    });
    const holder = document.createElement('div');
    holder.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    const found: object[] = [];
    createDocument(cleanPastedHTML(holder.innerHTML, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'textBox') found.push(node.attrs);
    });
    expect(found).toMatchObject([{ layout: 'front', width: 300, offsetX: 400 }]);
});

// A stretched picture keeps its shape as the column shrinks it, as a chart does.
test('a pasted stretched image wider than the column shrinks to it, its height alongside', () => {
    const html = '<p><span class="figure"><img src="data:image/png;base64," width="1200" height="300"></span></p>';
    const found: object[] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'figure') found.push(node.attrs);
    });
    expect(found).toMatchObject([{ width: 600, height: 150 }]);
});

test('a pasted image in the flow still caps at the column', () => {
    const html = '<p><img src="data:image/png;base64," width="700"></p>';
    const found: unknown[] = [];
    createDocument(cleanPastedHTML(html, PAGE, new Set(), DOCUMENT_FONT), schema).descendants((node) => {
        if (node.type.name === 'figure') found.push(node.attrs['width']);
    });
    expect(found).toEqual([600]);
});
