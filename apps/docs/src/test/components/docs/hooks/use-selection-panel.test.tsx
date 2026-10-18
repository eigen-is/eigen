// The selection opens a properties panel. An equation's opens on a click, Insert › Equation or Enter, never on an
// arrow passing it, and Insert › Equation focuses its field; a phone has no Insert › Equation.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { NodeSelection } = await import('@tiptap/pm/state');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Equation } = await import('../../../../components/docs/extensions/equation');
const { EquationPropertiesPanel } = await import('../../../../components/docs/equation-properties-panel');
const { useSelectionPanel } = await import('../../../../components/docs/hooks/use-selection-panel');

let unmount = async () => {};
afterEach(() => unmount());

let state: ReturnType<typeof useSelectionPanel> | undefined;
const closePanels = mock(() => {});

// "a" at 1, an empty equation at 2, "b" at 3, the caret after "a".
async function mount(isMobile = false) {
    let editEquation = () => {};
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [
            ...getDocExtensions({ exclude: ['equation'] }),
            Equation.configure({ onEdit: () => editEquation() }),
        ],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'a' }, { type: 'equation' }, { type: 'text', text: 'b' }],
                },
            ],
        },
    });
    editor.commands.setTextSelection(2);
    function Host() {
        state = useSelectionPanel(editor, isMobile, closePanels);
        editEquation = state.editEquation;
        return state.selectionPanel === 'equation'
            ? createElement(EquationPropertiesPanel, { editor, fieldRef: state.equationFieldRef })
            : null;
    }
    const rendered = await renderInDocument(createElement(Host));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

const field = () => document.querySelector('textarea[aria-label="LaTeX"]');

test('Insert › Equation puts an equation at the caret and focuses its panel’s field', async () => {
    const editor = await mount();
    // A browser runs a frame's callbacks after React's effects, where the test window runs them inline.
    const frames: FrameRequestCallback[] = [];
    const inline = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    await act(async () => state?.insertEquation?.());
    globalThis.requestAnimationFrame = inline;
    await act(async () => {
        for (const callback of frames) callback(0);
    });

    expect(closePanels).toHaveBeenCalled();
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(editor.state.doc.nodeAt(3)?.type.name).toBe('equation');
    expect(state?.selectionPanel).toBe('equation');
    expect(document.activeElement).toBe(field());
});

test('a phone has no Insert › Equation', async () => {
    await mount(true);
    expect(state?.insertEquation).toBeUndefined();
});

test('an arrow selecting an equation opens no panel, and a click does until the selection leaves it', async () => {
    const editor = await mount();
    await act(async () =>
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2))),
    );
    expect(state?.selectionPanel).toBe('document');
    expect(field()).toBeNull();

    await act(async () => editor.commands.setTextSelection(1));
    await act(async () =>
        editor.view.dispatch(
            editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2)).setMeta('pointer', true),
        ),
    );
    expect(state?.selectionPanel).toBe('equation');

    // Shift and an arrow from it select it as text, and the panel stays.
    await act(async () => editor.commands.setTextSelection({ from: 2, to: 3 }));
    expect(state?.selectionPanel).toBe('equation');

    await act(async () => editor.commands.setTextSelection(1));
    expect(state?.selectionPanel).toBe('document');
});

// ProseMirror runs a click's handlers and then dispatches only a selection that differs, so no `pointer` meta comes.
test('a click on an equation an arrow selected opens its panel with the field focused', async () => {
    const editor = await mount();
    await act(async () =>
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2))),
    );
    const equation = editor.state.doc.child(0).child(1);
    await act(async () => {
        editor.view.someProp('handleClickOn', (handle) =>
            handle(editor.view, 2, equation, 2, new MouseEvent('click'), true),
        );
    });

    expect(state?.selectionPanel).toBe('equation');
    expect(document.activeElement).toBe(field());
});

test('Enter on a selected equation opens its panel with the field focused', async () => {
    const editor = await mount();
    await act(async () =>
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2))),
    );
    await act(async () => {
        editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(state?.selectionPanel).toBe('equation');
    expect(document.activeElement).toBe(field());
    expect(editor.state.doc.childCount).toBe(1);
});
