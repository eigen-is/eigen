// A list stores the type it was set to, decimal as '1', so it keeps it nested; one with no type numbers by its depth,
// as eigen-prose.css draws it, and Numbered list ticks what the list draws.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { numberedListType, orderedListDepth, setNumberedListType } = await import(
    '../../../components/docs/list-numbering'
);

const item = (text: string, ...lists: object[]) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...lists],
});
const list = (type: string | null, ...items: object[]) => ({
    type: 'orderedList',
    attrs: { start: 1, type },
    content: items,
});

let editor: InstanceType<typeof Editor>;
afterEach(() => {
    editor.destroy();
    document.head.innerHTML = '';
});

// "outer" at 3, "inner" at 12.
function mount(outerType: string | null, innerType: string | null) {
    const style = document.createElement('style');
    style.textContent = 'ol ol { list-style-type: lower-alpha; }';
    document.head.append(style);
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
        element,
        extensions: getDocExtensions(),
        content: { type: 'doc', content: [list(outerType, item('outer', list(innerType, item('inner'))))] },
    });
}

const typeAt = (pos: number) => {
    const $pos = editor.state.doc.resolve(pos);
    const depth = orderedListDepth($pos);
    if (depth === undefined) throw new Error(`no numbered list at ${pos}`);
    return numberedListType($pos.node(depth), editor.view.nodeDOM($pos.before(depth)));
};

test.each(['1', 'a'])('Numbered list %s stores its type on the list around the caret', (type) => {
    mount(null, null);
    editor.commands.setTextSelection(12);
    setNumberedListType(editor, type);
    expect(editor.state.doc.child(0).child(0).child(1).attrs['type']).toBe(type);
});

test('a list reads the type it stores, and an untyped one the type it draws at its depth', () => {
    mount(null, null);
    expect([typeAt(3), typeAt(12)]).toEqual(['1', 'a']);
    editor.destroy();
    mount('i', '1');
    expect([typeAt(3), typeAt(12)]).toEqual(['i', '1']);
});
