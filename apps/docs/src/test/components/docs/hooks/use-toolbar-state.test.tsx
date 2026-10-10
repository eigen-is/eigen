// The toolbar draws the marks and the block at the caret, and a caret move is a transaction that changes no content.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { useToolbarState } = await import('../../../../components/docs/hooks/use-toolbar-state');

let unmount = async () => {};
afterEach(() => unmount());

// "plain " at 1-7, the bold Source Serif 4 "caps" at 7-11, then a heading.
const editor = new Editor({
    extensions: getDocExtensions(),
    content: {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'plain ' },
                    {
                        type: 'text',
                        text: 'caps',
                        marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { fontFamily: 'Source Serif 4' } }],
                    },
                ],
            },
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        ],
    },
});

let seen: ReturnType<typeof useToolbarState>[] = [];
function Probe({ of = editor }: { of?: typeof editor }) {
    seen.push(useToolbarState(of));
    return null;
}

test('a caret move alone updates what the toolbar draws', async () => {
    editor.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    expect(seen.at(-1)).toMatchObject({ bold: false, fontName: 'Inter', headingLevel: undefined });

    const before = editor.state.doc;
    await act(async () => editor.commands.setTextSelection(9));
    expect(editor.state.doc).toBe(before);
    expect(seen.at(-1)).toMatchObject({ bold: true, fontName: 'Source Serif 4' });

    await act(async () => editor.commands.setTextSelection(14));
    expect(seen.at(-1)).toMatchObject({ bold: false, fontName: 'Inter', headingLevel: 2 });
});

test('a caret move that changes nothing drawn renders nothing', async () => {
    editor.commands.setTextSelection(2);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    seen = [];
    await act(async () => editor.commands.setTextSelection(4));
    expect(seen).toEqual([]);
});

// The first 10,000 positions are read as a range, as a check over the whole selection would cost every transaction a walk of it.
test('a long selection draws what its first 10,000 positions are, a short one what all of it is', async () => {
    const words = 'plain words that run on '.repeat(4);
    const long = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: Array.from({ length: 20_000 }, (_, index) => ({
                type: 'paragraph',
                content: [
                    { type: 'text', text: `Item ${index} `, marks: [{ type: 'bold' }] },
                    { type: 'text', text: words },
                ],
            })),
        },
    });
    long.commands.setTextSelection({ from: 1, to: 9000 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: long })));
    expect(seen.at(-1)).toMatchObject({ bold: false, selectionEmpty: false });

    await act(async () => long.commands.selectAll());
    expect(seen.at(-1)).toMatchObject({ bold: false, selectionEmpty: false });

    const started = performance.now();
    for (let index = 0; index < 20; index++)
        await act(async () => long.view.dispatch(long.state.tr.setMeta('remote', index)));
    expect((performance.now() - started) / 20).toBeLessThan(10);
    long.destroy();
});

// A caret takes the marks and the block before it, so a long selection starting after them must not.
test('a long selection starting after a bold word or a heading reads none of them', async () => {
    const plain = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const long = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
                ...Array.from({ length: 3000 }, () => plain('plain words that run on')),
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
                ...Array.from({ length: 3000 }, () => plain('plain words that run on')),
            ],
        },
    });
    long.commands.setTextSelection({ from: 5, to: long.state.doc.content.size - 1 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: long })));
    expect(seen.at(-1)).toMatchObject({ bold: false, headingLevel: undefined });

    let headingEnd = 0;
    long.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headingEnd = pos + node.nodeSize - 1;
    });
    await act(async () => long.commands.setTextSelection({ from: headingEnd, to: long.state.doc.content.size - 1 }));
    expect(seen.at(-1)).toMatchObject({ bold: false, headingLevel: undefined });
    long.destroy();
});
