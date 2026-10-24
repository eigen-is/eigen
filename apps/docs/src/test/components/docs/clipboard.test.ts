// A paste through the eigen clipboard: what a docs copy writes, placed by the paste.
import { expect, spyOn, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import { readLatex, writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { buildTextClipboardItem, classifyPaste } = await import('@workspace/lib/clipboard');
const { FLAT_CHART_LOOK } = await import('@workspace/lib/charts');
const { DOCUMENT_FONT, EIGEN_FONTS } = await import('@workspace/lib/constants/fonts');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { insertEigenItems, writeDocsClipboard } = await import('../../../components/docs/clipboard');
const { cleanPastedHTML } = await import('../../../components/docs/paste');
const { sampleChartParts } = await import('../../fixtures/chart-parts');

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string, ...marks: object[]) => ({ type: 'text', text: t, ...(marks.length > 0 ? { marks } : {}) });
const figure = (mediaName: string) => ({ type: 'figure', attrs: { mediaName, width: 200 } });

// A docs editor holding `content`, all of it selected, whose copy and cut write the clipboard as the editor's do.
// Every image but a pending upload resolves.
function source(content: object[]) {
    const write = (view: EditorView, event: ClipboardEvent) =>
        writeDocsClipboard(view, event, (name) =>
            name.startsWith('pending:') ? undefined : drivePath({ name, mimeType: 'image/png' }),
        );
    const editor = new Editor({
        extensions: getDocExtensions(),
        content: { type: 'doc', content },
        editorProps: { handleDOMEvents: { copy: write, cut: write } },
    });
    editor.commands.selectAll();
    return editor;
}

// The clipboard a `type` event on the editor's DOM writes.
function copyOrCut(editor: Editor, type: 'copy' | 'cut') {
    const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    if (!event.clipboardData) throw new Error('no clipboard');
    return classifyPaste(event.clipboardData);
}

const copy = (content: object[]) => copyOrCut(source(content), 'copy');

// A paste into an empty docs editor whose comments map holds `cardIds`, its images stored under `pastedMediaName`.
async function paste(
    clipboard: ReturnType<typeof copy>,
    pastedMediaName: (item: EigenClipboardImageItem) => Promise<string | null> = async (item) => item.mediaName,
    cardIds: ReadonlySet<string> = new Set(),
) {
    const target = new Editor({
        extensions: getDocExtensions(),
        editorProps: { transformPastedHTML: (html) => cleanPastedHTML(html, 600, cardIds, DOCUMENT_FONT) },
    });
    await insertEigenItems(target, clipboard.eigen?.items ?? [], clipboard.html, pastedMediaName, 600);
    return target;
}

// Each block as its text runs and image names.
function blocks(editor: Editor): string[][] {
    const result: string[][] = [];
    editor.state.doc.forEach((block) => {
        const leaves: string[] = [];
        block.forEach((node) => {
            leaves.push(node.text ?? node.attrs.mediaName);
        });
        result.push(leaves);
    });
    return result;
}

test('a docs copy pastes its heading, list, marks and figure back in order, the image under its new name', async () => {
    const content = (mediaName: string, ...commentMarks: object[]): object[] => [
        { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
        {
            type: 'bulletList',
            content: [
                { type: 'listItem', content: [paragraph(text('One'))] },
                { type: 'listItem', content: [paragraph(text('Two'))] },
            ],
        },
        paragraph(text('Bold', { type: 'bold' }), text(' and noted', ...commentMarks)),
        paragraph(figure(mediaName)),
    ];
    const target = await paste(
        copy(content('chart.png', { type: 'comment', attrs: { cardId: 'elsewhere' } })),
        async (item) => `copy-${item.mediaName}`,
    );
    const expected = new Editor({
        extensions: getDocExtensions(),
        content: { type: 'doc', content: content('copy-chart.png') },
    });
    expect(target.getJSON()).toEqual(expected.getJSON());
});

test('a copy of text and an image pastes both, in document order', async () => {
    const clipboard = copy([
        paragraph(text('Intro')),
        paragraph(figure('chart.png')),
        paragraph(text('One')),
        paragraph(text('Two')),
    ]);
    expect(blocks(await paste(clipboard))).toEqual([['Intro'], ['chart.png'], ['One'], ['Two']]);
});

// A figure whose file does not resolve, as one still uploading, has no item; its paragraph stays in the text.
test('a figure that does not resolve is left out', async () => {
    const clipboard = copy([
        paragraph(text('One')),
        paragraph(figure('pending:upload')),
        paragraph(text('Two'), figure('chart.png')),
    ]);
    expect(blocks(await paste(clipboard))).toEqual([['One'], [], ['Two', 'chart.png']]);
});

// Slides and sheets read the text item, so an equation beside an image keeps its linear form there.
test("an equation copied beside an image is its linear form in the copy's text item", () => {
    const latex = '\\pi r^2';
    const equation = { type: 'equation', attrs: { mathml: writeMathml(readLatex(latex), latex) } };
    const { eigen } = copy([paragraph(text('Area '), equation), paragraph(figure('chart.png'))]);
    expect(eigen?.items.map((item) => (item.type === 'text' ? item.text : item.type))).toEqual(['Area πr^2', 'image']);
});

// Another editor reads the <math> with its LaTeX, a plain-text one the linear form.
test('an equation copied writes its MathML in the HTML and its linear form as plain text', () => {
    const latex = '\\pi r^2';
    const equation = { type: 'equation', attrs: { mathml: writeMathml(readLatex(latex), latex) } };
    const { html, text: plain } = copy([paragraph(text('Area '), equation)]);
    expect(html).toContain(writeMathml(readLatex(latex), latex));
    expect(plain).toBe('Area πr^2');
});

test("a page number copied beside an image is # in the copy's text item", () => {
    const { eigen } = copy([
        paragraph(text('Page '), { type: 'pageNumber', attrs: { kind: 'page' } }),
        paragraph(figure('chart.png')),
    ]);
    expect(eigen?.items.map((item) => (item.type === 'text' ? item.text : item.type))).toEqual(['Page #', 'image']);
});

// A note is no part of the sentence around its reference, and its image no item of its own.
test("a copy's items leave a note's text and images out", () => {
    const { eigen } = copy([
        paragraph(
            text('Claim'),
            { type: 'footnote', content: [paragraph(text('Note'), figure('noted.png'))] },
            text('.'),
        ),
        paragraph(figure('chart.png')),
    ]);
    expect(
        eigen?.items.map((item) => (item.type === 'image' ? item.mediaName : item.type === 'text' && item.text)),
    ).toEqual(['Claim.', 'chart.png']);
});

test('a figure whose re-upload fails is left out', async () => {
    const clipboard = copy([paragraph(text('One'), figure('chart.png'))]);
    expect(blocks(await paste(clipboard, async () => null))).toEqual([['One']]);
});

test('an image cut and pasted in its own document keeps its comment card', async () => {
    const clipboard = copy([paragraph({ type: 'figure', attrs: { mediaName: 'chart.png', commentCardId: 'here' } })]);
    const target = await paste(clipboard, undefined, new Set(['here']));
    expect(target.state.doc.firstChild?.firstChild?.attrs.commentCardId).toBe('here');
});

test('a paste re-uploads its images at once, and an image copied twice once', async () => {
    const clipboard = copy([paragraph(figure('chart.png'), figure('map.png'), figure('chart.png'))]);
    const started: string[] = [];
    const { promise: uploaded, resolve: upload } = Promise.withResolvers<void>();
    const pasting = paste(clipboard, async (item) => {
        started.push(item.mediaName);
        await uploaded;
        return `copy-${item.mediaName}`;
    });
    expect(started).toEqual(['chart.png', 'map.png']);

    upload();
    expect(blocks(await pasting)).toEqual([['copy-chart.png', 'copy-map.png', 'copy-chart.png']]);
    expect(started).toEqual(['chart.png', 'map.png']);
});

// ProseMirror's own cut deletes the selection first, so the payload is written before it runs.
test('an image cut from one document pastes into another under the name its re-upload gives', async () => {
    const cutFrom = source([paragraph(text('Intro'), figure('chart.png'))]);
    const cut = copyOrCut(cutFrom, 'cut');
    expect(blocks(cutFrom)).toEqual([[]]);

    const target = await paste(cut, async (item) => `copy-${item.mediaName}`);
    expect(blocks(target)).toEqual([['Intro', 'copy-chart.png']]);
});

// Slides and sheets write no ProseMirror HTML, so their items are placed one by one.
test('a payload beside no docs HTML pastes its items in order', async () => {
    const { eigen } = copy([paragraph(text('Intro')), paragraph(figure('chart.png')), paragraph(text('One'))]);
    expect(blocks(await paste({ eigen, html: '', text: '', files: [], imageFiles: [] }))).toEqual([
        ['Intro'],
        ['chart.png'],
        ['One'],
    ]);
});

// Heading 6 draws an italic mark upright, as Google Docs does, which reads the run by its look.
test('a copy writes an italic mark in Heading 6 upright and pastes it back as the mark', async () => {
    const heading = (level: number) => ({
        type: 'heading',
        attrs: { level },
        content: [text('Fine '), text('print', { type: 'italic' })],
    });
    // A closing paragraph, as a paste into an empty editor keeps its empty paragraph after closed blocks.
    const content = [heading(6), heading(5), paragraph(text('Body'))];
    const clipboard = copy(content);
    const html = new DOMParser().parseFromString(clipboard.html, 'text/html');
    expect([...html.querySelectorAll('em')].map((em) => [em.closest('h5, h6')?.tagName, em.style.fontStyle])).toEqual([
        ['H6', 'normal'],
        ['H5', ''],
    ]);

    const target = await paste(clipboard);
    const expected = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
    expect(target.getJSON()).toEqual(expected.getJSON());
});

// A title's look is its node's, which Google Docs and Word don't read: the copy writes the size, in pt as the clipboard
// carries every size, and color the page draws it in on the p, the body's color left to the target, and a paste here
// reads the node from its data-type.
// happy-dom computes no nested CSS, so the page's look is stubbed.
test('a copy writes the title and subtitle look inline and pastes them back as the nodes', async () => {
    const content = [
        { type: 'title', content: [text('Report')] },
        { type: 'subtitle', content: [text('Third quarter')] },
        paragraph(text('Body')),
    ];
    const looks: Record<string, [string, string]> = {
        title: ['34.6667px', 'rgb(26, 26, 46)'],
        subtitle: ['20px', 'rgb(102, 102, 102)'],
    };
    const computed = spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
        const [fontSize, color] = looks[element.getAttribute('data-type') ?? ''] ?? ['14.6667px', 'rgb(26, 26, 46)'];
        const { style } = document.createElement('p');
        Object.assign(style, { fontSize, color });
        return style;
    });
    const clipboard = copy(content);
    computed.mockRestore();
    const html = new DOMParser().parseFromString(clipboard.html, 'text/html');
    expect(
        [...html.querySelectorAll<HTMLElement>('p')].map((p) => [p.dataset['type'], p.style.fontSize, p.style.color]),
    ).toEqual([
        ['title', '26pt', ''],
        ['subtitle', '15pt', 'rgb(102, 102, 102)'],
        [undefined, '', ''],
    ]);

    const target = await paste(clipboard);
    const expected = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
    expect(target.getJSON()).toEqual(expected.getJSON());
});

// A title in a quote draws the quote's grey, which is not the title's own: the copy compares a node's color with the
// one it inherits, so neither title carries it and the subtitle keeps its own grey.
test("a copy leaves a quote's color off every title and writes the subtitle's own", () => {
    const quoteGrey = 'rgb(107, 114, 128)';
    const computed = spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
        const type = element.getAttribute('data-type');
        const quoted = element.closest('blockquote') !== null;
        const color = type === 'subtitle' ? 'rgb(102, 102, 102)' : quoted ? quoteGrey : 'rgb(26, 26, 46)';
        const { style } = document.createElement('p');
        Object.assign(style, { fontSize: type ? '20px' : '14.6667px', color });
        return style;
    });
    const clipboard = copy([
        { type: 'blockquote', content: [{ type: 'title', content: [text('Quoted')] }] },
        { type: 'title', content: [text('Plain')] },
        { type: 'subtitle', content: [text('Third quarter')] },
    ]);
    computed.mockRestore();
    const html = new DOMParser().parseFromString(clipboard.html, 'text/html');
    expect(
        [...html.querySelectorAll<HTMLElement>('p[data-type]')].map((p) => [p.dataset['type'], p.style.color]),
    ).toEqual([
        ['title', ''],
        ['title', ''],
        ['subtitle', 'rgb(102, 102, 102)'],
    ]);
});

// ProseMirror's copy writes a font as its CSS stack, which the paste reads back as the font.
test.each(EIGEN_FONTS.map((font) => font.name))('a run in %s copies and pastes back in it', async (font) => {
    const clipboard = copy([paragraph(text('Body', { type: 'textStyle', attrs: { fontFamily: font } }))]);
    const marks = (await paste(clipboard)).state.doc.firstChild?.firstChild?.marks ?? [];
    const fontFamily = marks.find((mark) => mark.type.name === 'textStyle')?.attrs['fontFamily'];
    expect(fontFamily).toBe(font === DOCUMENT_FONT ? undefined : font);
});

// A text item is plain, so its text lands as typed, never read as markup.
test('a text item pastes its text literally', async () => {
    const item = buildTextClipboardItem({ text: 'if a<b and c>d then\nAT&amp;T', box: { width: 100, height: 20 } });
    const target = await paste({ eigen: { version: 1, items: [item] }, html: '', text: '', files: [], imageFiles: [] });
    expect(blocks(target)).toEqual([['if a<b and c>d then'], ['AT&amp;T']]);
});

const LOOK = {
    fill: JSON.stringify({ type: 'solid', color: '#ffeeaa', style: 'zigzag' }),
    color: '#ffffff',
    strokeColor: '#336699',
    strokeWidth: 4,
    strokeStyle: 'dotted',
    roughness: 2,
    seed: 77,
} as const;

// A chart writes its item for the other apps, and within Docs pastes back whole through the docs HTML, alone or
// beside a figure.
test('a chart copies and pastes back whole within Docs, alone or beside a figure', async () => {
    const chart = {
        type: 'chart',
        attrs: {
            ...sampleChartParts('pie'),
            width: 300,
            height: 200,
            caption: 'Share',
            alignment: 'center',
            layout: 'wrap-left',
            commentCardId: null,
            ...LOOK,
        },
    };
    const chartsIn = (editor: Editor) => {
        const attrs: Record<string, unknown>[] = [];
        editor.state.doc.descendants((node) => {
            if (node.type.name === 'chart') attrs.push(node.attrs);
        });
        return attrs;
    };

    const alone = copy([paragraph(text('a'), chart)]);
    expect(alone.eigen?.items.at(-1)).toEqual({
        type: 'chart',
        parts: sampleChartParts('pie'),
        width: 300,
        height: 200,
        look: LOOK,
    });
    expect(chartsIn(await paste(alone))).toEqual([chart.attrs]);

    const beside = copy([paragraph(figure('a.png'), chart)]);
    expect(beside.eigen?.items.map((item) => item.type)).toEqual(['image', 'chart']);
    expect(chartsIn(await paste(beside))).toEqual([chart.attrs]);

    const placeholder = copy([paragraph(text('a'), { ...chart, attrs: { ...chart.attrs, specData: '{' } })]);
    expect(placeholder.eigen).toBeUndefined();
});

// Sheets, Slides and Vector write no docs HTML: a chart item lands as a chart node, its width capped at the column
// with its shape kept, and its sizes otherwise as they came.
test('a chart item from another app pastes as a chart, capped at the column', async () => {
    const parts = sampleChartParts('line');
    const items = [
        { type: 'chart' as const, parts, width: 400.5, height: 250.25, look: LOOK },
        { type: 'chart' as const, parts, width: 1200, height: 675, look: FLAT_CHART_LOOK },
    ];
    const target = await paste({ eigen: { version: 1, items }, html: '', text: '', files: [], imageFiles: [] });
    const charts: Record<string, unknown>[] = [];
    target.state.doc.descendants((node) => {
        if (node.type.name === 'chart') charts.push(node.attrs);
    });
    expect(charts).toMatchObject([
        { ...parts, width: 400.5, height: 250.25, ...LOOK },
        { ...parts, width: 600, height: 337.5, ...FLAT_CHART_LOOK },
    ]);
});

// A copy with no figure, title or upright italic is ProseMirror's own, so it never serializes the selection itself.
test('a plain copy leaves the event to ProseMirror without serializing', () => {
    const editor = source([
        { type: 'heading', attrs: { level: 6 }, content: [text('Fine print')] },
        paragraph(text('Body', { type: 'italic' })),
    ]);
    const serialize = spyOn(editor.view, 'serializeForClipboard');
    const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true });
    expect(writeDocsClipboard(editor.view, event, () => undefined)).toBe(false);
    expect(serialize).not.toHaveBeenCalled();
});
