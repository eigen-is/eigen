// The active set counts a card anchored by the mark on text and one anchored by a node's attribute, and it reads as
// not ready until the first walk ran, so no card reads deleted before it.
import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { useActiveComments } = await import('../../../../components/docs/hooks/use-active-comments');

test('the first walk finds the cards on marks and on nodes, and then the set is ready', async () => {
    const editor = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'marked', marks: [{ type: 'comment', attrs: { cardId: 'on-text' } }] },
                        { type: 'equation', attrs: { commentCardId: 'on-node' } },
                        { type: 'text', text: ' plain' },
                    ],
                },
            ],
        },
    });
    let seen: ReturnType<typeof useActiveComments> = { ids: new Set(), ready: true };
    function Host() {
        seen = useActiveComments(editor);
        return null;
    }
    const { unmount } = await renderInDocument(createElement(Host));
    expect(seen.ready).toBe(false);
    expect(seen.ids.size).toBe(0);

    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(seen.ready).toBe(true);
    expect([...seen.ids].sort()).toEqual(['on-node', 'on-text']);

    await unmount();
    editor.destroy();
});
