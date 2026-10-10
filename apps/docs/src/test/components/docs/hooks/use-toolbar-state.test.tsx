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

// "plain " at 1-7, the bold small caps "caps" at 7-11, then a heading.
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
                        marks: [
                            { type: 'bold' },
                            { type: 'textStyle', attrs: { fontFamily: 'Source Serif 4', caps: 'small' } },
                        ],
                    },
                ],
            },
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        ],
    },
});

let seen: ReturnType<typeof useToolbarState>[] = [];
function Probe() {
    seen.push(useToolbarState(editor));
    return null;
}

test('a caret move alone updates what the toolbar draws', async () => {
    editor.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    expect(seen.at(-1)).toMatchObject({ bold: false, smallCaps: false, fontName: 'Inter', headingLevel: undefined });

    const before = editor.state.doc;
    await act(async () => editor.commands.setTextSelection(9));
    expect(editor.state.doc).toBe(before);
    expect(seen.at(-1)).toMatchObject({ bold: true, smallCaps: true, allCaps: false, fontName: 'Source Serif 4' });

    await act(async () => editor.commands.setTextSelection(14));
    expect(seen.at(-1)).toMatchObject({ bold: false, smallCaps: false, headingLevel: 2 });
});

test('a caret move that changes nothing drawn renders nothing', async () => {
    editor.commands.setTextSelection(2);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    seen = [];
    await act(async () => editor.commands.setTextSelection(4));
    expect(seen).toEqual([]);
});
