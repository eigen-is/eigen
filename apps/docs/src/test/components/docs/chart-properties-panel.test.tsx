// The Chart panel edits the selected chart's spec and frame through the doc's own undo manager: each change one undo
// step, a typed title too, and Edit data's Save one write.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, useState } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { parseChartSpec } = await import('@workspace/lib/charts');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Chart } = await import('../../../components/docs/extensions/chart');
const { createDocUndoManager } = await import('../../../components/docs/page-setup');
const { ChartDataEditor, ChartPropertiesPanel } = await import('../../../components/docs/chart-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

// A collab editor holding one inserted chart, selected, its panel and its Edit data dialog mounted as the editor
// mounts them. Every write past the insert would be its own undo step but for a hold, as captureTimeout is 0.
async function mount() {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['chart'] }),
            Chart,
            Collaboration.configure({ document: doc, yUndoOptions: { undoManager } }),
        ],
    });
    editor.commands.insertChart('column');
    undoManager.stopCapturing();
    undoManager.captureTimeout = 0;
    function Host() {
        const [open, setOpen] = useState(false);
        return createElement(
            'div',
            null,
            createElement('div', { 'data-document': '' }, createElement(EditorContent, { editor })),
            createElement(ChartPropertiesPanel, { editor, undoManager, onEditData: () => setOpen(true) }),
            open && createElement(ChartDataEditor, { editor, undoManager, onClose: () => setOpen(false) }),
        );
    }
    const rendered = await renderInDocument(createElement(Host));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    const spec = () => parseChartSpec(editor.state.doc.nodeAt(1)?.attrs.spec ?? '');
    return { editor, undoManager, spec };
}

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
const button = (scope: ParentNode | undefined, label: string) => {
    const found = [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (el) => el.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const click = (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
        if (!input) throw new Error('no field to type in');
        input.focus();
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
// A keydown on the field, returned so the test can see whether the browser's own handling of it was prevented.
const press = async (input: HTMLInputElement | null, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => {
        input?.dispatchEvent(event);
    });
    return event;
};

test('a title typed into the panel is one undo step, and the chart stays selected', async () => {
    const { editor, undoManager, spec } = await mount();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Chart title"]');
    for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
    await act(async () => {
        input?.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
    expect(spec()?.title).toBe('Goal');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });

    undoManager.undo();
    expect(spec()?.title).toBe('Points scored');
});

// The field still holds the caret after typing, so ⌘Z reaches the field, not the editor's keymap. The browser's own
// field undo would walk the text back a character at a time, writing each one.
const fieldTitle = {
    'Chart title': (spec: ReturnType<typeof parseChartSpec>) => spec?.title,
    'Horizontal axis title': (spec: ReturnType<typeof parseChartSpec>) => spec?.categoryAxis?.title,
    'Vertical axis title': (spec: ReturnType<typeof parseChartSpec>) => spec?.valueAxis?.title,
};
for (const [placeholder, read] of Object.entries(fieldTitle)) {
    test(`⌘Z in the ${placeholder} field takes the typed text back as one step, and ⇧⌘Z puts it back`, async () => {
        const { spec } = await mount();
        const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
        const before = read(spec());
        for (const typed of ['G', 'Go', 'Goa', 'Goal']) await type(input, typed);
        expect(read(spec())).toBe('Goal');

        const undo = await press(input, { key: 'z', metaKey: true });
        expect(undo.defaultPrevented).toBe(true);
        expect(read(spec())).toBe(before);
        expect(input?.value).toBe(before ?? '');

        const redo = await press(input, { key: 'z', metaKey: true, shiftKey: true });
        expect(redo.defaultPrevented).toBe(true);
        expect(read(spec())).toBe('Goal');
        expect(input?.value).toBe('Goal');
    });
}

test("a Style toggle wraps the chart in one undo step and lights it, the spec's rows untouched", async () => {
    const { editor, undoManager, spec } = await mount();
    const before = spec();
    // The Style toggles, own line, wrap left and wrap right, are the panel's first.
    const wrapLeft = document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1];
    expect(wrapLeft.getAttribute('aria-pressed')).toBe('false');
    await click(wrapLeft);
    expect(editor.state.doc.nodeAt(1)?.attrs.layout).toBe('wrap-left');
    expect(wrapLeft.getAttribute('aria-pressed')).toBe('true');
    expect(spec()).toEqual(before);

    undoManager.undo();
    expect(editor.state.doc.nodeAt(1)?.attrs.layout).toBe('block');
});

test('Edit data saves the grid as one undo step', async () => {
    const { undoManager, spec } = await mount();
    await click(button(document.body, 'Edit data'));
    await type(dialog()?.querySelector<HTMLInputElement>('input[aria-label="Row 1, series 1"]'), '7');
    await click(button(dialog(), 'Save'));
    const saved = spec();
    expect(saved?.data.source === 'inline' && saved.data.series[0].values[0]).toBe(7);
    expect(dialog()).toBeUndefined();

    undoManager.undo();
    const undone = spec();
    expect(undone?.data.source === 'inline' && undone.data.series[0].values[0]).toBe(42);
});
