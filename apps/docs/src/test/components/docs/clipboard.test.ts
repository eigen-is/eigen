// A docs-to-docs paste through the eigen clipboard: the items a copy writes, placed by the paste.
import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { copiedClipboardItems, insertEigenItems } = await import('../../../components/docs/clipboard');

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });
const figure = (mediaName: string) => ({ type: 'figure', attrs: { mediaName, width: 200 } });

async function copyThenPaste(content: object[]) {
    const source = new Editor({ extensions: getDocExtensions(), content: { type: 'doc', content } });
    const chart = drivePath({ name: 'chart.png', mimeType: 'image/png' });
    const items = copiedClipboardItems(source, 0, source.state.doc.content.size, (name) =>
        name === 'chart.png' ? chart : undefined,
    );
    const target = new Editor({ extensions: getDocExtensions() });
    await insertEigenItems(target, items, async (item) => item.mediaName);
    // Each block as its text runs and image names.
    const blocks: string[][] = [];
    target.state.doc.forEach((block) => {
        const leaves: string[] = [];
        block.forEach((node) => {
            leaves.push(node.text ?? node.attrs.mediaName);
        });
        blocks.push(leaves);
    });
    return blocks;
}

test('a copy of text and an image pastes both, in document order', async () => {
    expect(
        await copyThenPaste([
            paragraph(text('Intro')),
            paragraph(figure('chart.png')),
            paragraph(text('One')),
            paragraph(text('Two')),
        ]),
    ).toEqual([['Intro'], ['chart.png'], ['One'], ['Two']]);
});

// A figure whose file does not resolve, as one still uploading, has no item; its paragraph stays in the text.
test('a figure that does not resolve is left out', async () => {
    expect(
        await copyThenPaste([
            paragraph(text('One')),
            paragraph(figure('pending:upload')),
            paragraph(text('Two'), figure('chart.png')),
        ]),
    ).toEqual([['One'], [], ['Two'], ['chart.png']]);
});
