// The table of contents panel shows how deep the selected one lists and sets it. The write keeps the node selected, so
// the panel stays, and the editor's list redraws to the new depth.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { NodeSelection } = await import('@tiptap/pm/state');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { TableOfContents } = await import('../../../components/docs/extensions/table-of-contents');
const { TableOfContentsPropertiesPanel } = await import('../../../components/docs/table-of-contents-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const heading = (level: number): JSONContent => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text: `Heading ${level}` }],
});

// A table of contents at 0, selected, above a heading of each of the first four levels.
async function mount(levels: number) {
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...getDocExtensions({ exclude: ['tableOfContents'] }), TableOfContents],
        content: {
            type: 'doc',
            content: [{ type: 'tableOfContents', attrs: { levels } }, heading(1), heading(2), heading(3), heading(4)],
        },
    });
    editor.commands.setNodeSelection(0);
    const rendered = await renderInDocument(createElement(TableOfContentsPropertiesPanel, { editor }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

// A row's control sits beside its label span.
const row = (label: string) => {
    const span = [...document.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === label);
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no "${label}" row`);
    return control;
};
const choose = async (label: string, option: string) => {
    const trigger = row(label).querySelector('[data-slot="select-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
    const item = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
        (el) => el.textContent?.trim() === option,
    );
    if (!item) throw new Error(`no "${option}" option under "${label}"`);
    await act(async () => {
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};

// The level of each entry the editor draws.
const entryLevels = (editor: InstanceType<typeof Editor>) =>
    [...editor.view.dom.querySelectorAll('nav[data-type="table-of-contents"] [data-level]')].map((line) =>
        line.getAttribute('data-level'),
    );

test('shows the levels of the selected table of contents', async () => {
    await mount(2);
    expect(row('Show levels').textContent).toBe('2');
});

test('Show levels writes the depth, keeps the node selected, and the editor lists to it', async () => {
    const editor = await mount(2);
    expect(entryLevels(editor)).toEqual(['1', '2']);

    await choose('Show levels', '4');
    expect(editor.state.doc.child(0).attrs['levels']).toBe(4);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(0);
    expect(row('Show levels').textContent).toBe('4');
    expect(entryLevels(editor)).toEqual(['1', '2', '3', '4']);
});
