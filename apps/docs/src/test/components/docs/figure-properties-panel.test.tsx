// The Image panel follows the figure selection, so a write from the panel must keep the figure selected, and the
// panel must draw the new value though the selection didn't change.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The Replace image picker needs a signed-in user; the panel's writes don't.
const realDrive = await import('@workspace/ui/components/drive');
mock.module('@workspace/ui/components/drive', () => ({ ...realDrive, DrivePickerWithUpload: () => null }));

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../components/docs/extensions/figure');
const { FigurePropertiesPanel } = await import('../../../components/docs/figure-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

// "a" at 1, the figure at 2.
async function mount() {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['figure', 'comment'] }), Figure],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200 } },
                    ],
                },
            ],
        },
    });
    editor.commands.setNodeSelection(2);
    const rendered = await renderInDocument(createElement(FigurePropertiesPanel, { editor, onReplaceImage: () => {} }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

// The Style toggles, own line, wrap left and wrap right, come before Align's.
const styleToggles = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].slice(0, 3);

test('a Style toggle keeps the figure selected and lights the new layout', async () => {
    const editor = await mount();
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);

    await act(async () => styleToggles()[1]?.click());

    expect(editor.state.doc.nodeAt(2)?.attrs['layout']).toBe('wrap-left');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
});
