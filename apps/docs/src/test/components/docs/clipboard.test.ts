// A paste through the eigen clipboard: what a docs copy writes, placed by the paste.
import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { classifyPaste } = await import('@workspace/lib/clipboard');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { insertEigenItems, writeDocsClipboard } = await import('../../../components/docs/clipboard');
const { cleanPastedHTML } = await import('../../../components/docs/paste');

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
        editorProps: { transformPastedHTML: (html) => cleanPastedHTML(html, 600, cardIds) },
    });
    await insertEigenItems(target, clipboard.eigen?.items ?? [], clipboard.html, pastedMediaName);
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
