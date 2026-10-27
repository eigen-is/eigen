// The outline lists the body's headings, indented by level, and follows every edit as it happens. A click on an entry
// hands the heading's position as it stands now to the jump.
import { afterEach, expect, mock, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { OutlineColumn } = await import('../../../components/docs/outline-sidebar');

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const heading = (level: number, value: string): JSONContent => ({
    type: 'heading',
    attrs: { level },
    content: [text(value)],
});
const paragraph = (value: string): JSONContent => ({ type: 'paragraph', content: [text(value)] });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(...content: JSONContent[]) {
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: getDocExtensions(),
        content: { type: 'doc', content },
    });
    cleanups.push(() => editor.destroy());
    const onJump = mock((_pos: number) => {});
    const onClose = mock(() => {});
    const rendered = await renderInDocument(createElement(OutlineColumn, { editor, onJump, onClose }));
    cleanups.push(rendered.unmount);
    const entries = () => [...rendered.container.querySelectorAll<HTMLElement>('nav[aria-label="Outline"] button')];
    return { editor, onJump, onClose, entries, container: rendered.container };
}

test('lists the headings in document order, each indented by its level', async () => {
    const { entries } = await setup(heading(1, 'Intro'), paragraph('Body'), heading(2, 'Method'), heading(3, 'Setup'));
    expect(entries().map((entry) => entry.textContent)).toEqual(['Intro', 'Method', 'Setup']);
    expect(entries().map((entry) => entry.className.match(/\bpl-[\d.]+/)?.[0])).toEqual(['pl-2.5', 'pl-5', 'pl-7.5']);
});

test('a heading typed, retitled or turned to text changes the list as it happens', async () => {
    const { editor, entries } = await setup(heading(1, 'Intro'), paragraph('Body'));
    await act(async () => {
        editor.chain().setTextSelection(13).insertContent(' text').run();
    });
    expect(entries().map((entry) => entry.textContent)).toEqual(['Intro']);

    await act(async () => {
        editor.chain().setTextSelection(6).insertContent('duction').run();
    });
    expect(entries().map((entry) => entry.textContent)).toEqual(['Introduction']);

    await act(async () => {
        editor.chain().setTextSelection(16).setHeading({ level: 2 }).run();
    });
    expect(entries().map((entry) => entry.textContent)).toEqual(['Introduction', 'Body text']);

    await act(async () => {
        editor.chain().setTextSelection(1).setParagraph().run();
    });
    expect(entries().map((entry) => entry.textContent)).toEqual(['Body text']);
});

test('a click hands the heading’s position as it stands after an edit above it', async () => {
    const { editor, onJump, entries } = await setup(paragraph('Body'), heading(2, 'Method'));
    await act(async () => {
        editor.chain().setTextSelection(1).insertContent('More ').run();
    });
    await act(async () => entries()[0]?.click());
    expect(onJump.mock.calls).toEqual([[11]]);
    expect(editor.state.doc.nodeAt(11)?.textContent).toBe('Method');
});

test('with no headings it says where they will appear', async () => {
    const { entries, container } = await setup(paragraph('Only body text'));
    expect(entries()).toEqual([]);
    expect(container.textContent).toContain('Headings you add appear here');
});

test('Close closes it', async () => {
    const { onClose, container } = await setup(heading(1, 'Intro'));
    const close = container.querySelector<HTMLElement>('button[aria-label="Close"]');
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
});
