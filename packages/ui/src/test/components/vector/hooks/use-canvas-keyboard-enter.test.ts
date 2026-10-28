// Enter edits the sole selected element, but only when focus rests on the canvas or the page: a focused
// button, link, input or rail thumbnail keeps its own Enter and no session opens behind it.
import { afterEach, expect, mock, test } from 'bun:test';
import type { VectorElement } from '@workspace/lib/vector';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { useCanvasKeyboard } = await import('../../../../components/vector/hooks/use-canvas-keyboard');

const rectangle = (id: string): VectorElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    index: 'a0',
    seed: 3,
    id,
    type: 'rectangle',
});

let unmount = async () => {};
afterEach(() => unmount());

async function canvas(selectedIds: string[], enabled = true, acts = true) {
    const container = document.createElement('div');
    document.body.append(container);
    const onEdit = mock((_el: VectorElement) => acts);
    function Canvas() {
        useCanvasKeyboard({
            enabled,
            menuOpen: false,
            elements: [rectangle('e1'), rectangle('e2')],
            selectedIds,
            setTool: () => {},
            toolLocked: false,
            setToolLocked: () => {},
            setSelection: () => {},
            undoManager: null,
            deleteElements: () => {},
            updateElements: () => {},
            reorderElements: () => {},
            duplicateElements: () => [],
            containerRef: { current: container },
            onEdit,
        });
        return null;
    }
    const mounted = await renderInDocument(createElement(Canvas));
    unmount = async () => {
        await mounted.unmount();
        container.remove();
    };
    // Dispatches Enter at `target` and reports whether the hook took the key.
    const enter = async (target: Element) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        await act(async () => {
            target.dispatchEvent(event);
        });
        return event.defaultPrevented;
    };
    return { enter, onEdit, container };
}

test('Enter edits the sole selected element, from the page and from the canvas', async () => {
    const { enter, onEdit, container } = await canvas(['e2']);
    expect(await enter(document.body)).toBe(true);
    expect(await enter(container)).toBe(true);
    expect(onEdit.mock.calls.map(([el]) => el.id)).toEqual(['e2', 'e2']);
});

test('Enter on an element that has nothing to open is not taken, so the key keeps its default', async () => {
    const { enter, onEdit } = await canvas(['e1'], true, false);
    expect(await enter(document.body)).toBe(false);
    expect(onEdit).toHaveBeenCalledTimes(1);
});

test('Enter does nothing with no selection, with two, or while the keymap is off', async () => {
    for (const [ids, enabled] of [
        [[], true],
        [['e1', 'e2'], true],
        [['e1'], false],
    ] as const) {
        const { enter, onEdit } = await canvas([...ids], enabled);
        expect(await enter(document.body)).toBe(false);
        expect(onEdit).not.toHaveBeenCalled();
        await unmount();
    }
});

test('Enter on a focused button, a link, an input or a rail thumbnail neither edits nor is taken', async () => {
    const { enter, onEdit } = await canvas(['e1']);
    const button = document.createElement('button');
    const link = document.createElement('a');
    link.href = '#slide';
    const input = document.createElement('input');
    const thumbnail = document.createElement('div');
    thumbnail.setAttribute('role', 'button');
    thumbnail.tabIndex = 0;
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(button, link, input, thumbnail, editable);
    for (const target of [button, link, input, thumbnail, editable]) {
        expect(await enter(target)).toBe(false);
    }
    expect(onEdit).not.toHaveBeenCalled();
    for (const target of [button, link, input, thumbnail, editable]) target.remove();
});
