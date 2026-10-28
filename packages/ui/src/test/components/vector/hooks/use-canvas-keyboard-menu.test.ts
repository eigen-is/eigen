// An open menu stands the canvas keys down, since its arrows, Delete and letters belong to the menu, but not undo and
// redo: the Edit menu lists ⌘Z and ⇧⌘Z beside its rows, so they must still work while it is open.
import { afterEach, expect, mock, test } from 'bun:test';
import type { VectorElement, VectorElementPatch } from '@workspace/lib/vector';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { useCanvasKeyboard } = await import('../../../../components/vector/hooks/use-canvas-keyboard');

const ELEMENT: VectorElement = {
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    index: 'a0',
    seed: 3,
    id: 'e1',
    type: 'rectangle',
};
const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

let unmount = async () => {};
afterEach(() => unmount());

async function canvasWithMenuOpen() {
    const doc = new Y.Doc();
    const elements = doc.getMap<number>('elements');
    const undoManager = new Y.UndoManager(elements);
    elements.set('x', 100);
    const setTool = mock((_tool: string) => {});
    const deleteElements = mock((_ids: string[]) => {});
    const updateElements = mock((_patches: { id: string; fields: VectorElementPatch }[]) => {});
    function Canvas() {
        useCanvasKeyboard({
            enabled: true,
            menuOpen: true,
            elements: [ELEMENT],
            selectedIds: ['e1'],
            setTool,
            toolLocked: false,
            setToolLocked: () => {},
            setSelection: () => {},
            undoManager,
            deleteElements,
            updateElements,
            reorderElements: () => {},
            duplicateElements: () => [],
            containerRef: { current: null },
            onEdit: () => {},
        });
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(Canvas)));
    const press = async (init: KeyboardEventInit) => {
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        });
    };
    return { press, x: () => elements.get('x'), setTool, deleteElements, updateElements };
}

test('undo and redo still work with a menu open', async () => {
    const { press, x } = await canvasWithMenuOpen();
    await press({ key: 'z', code: 'KeyZ', ...MOD });
    expect(x()).toBeUndefined();
    await press({ key: 'z', code: 'KeyZ', shiftKey: true, ...MOD });
    expect(x()).toBe(100);
});

test('the canvas keys stay with the open menu', async () => {
    const { press, setTool, deleteElements, updateElements } = await canvasWithMenuOpen();
    await press({ key: 'ArrowRight', code: 'ArrowRight' });
    await press({ key: 'Delete', code: 'Delete' });
    await press({ key: 'r', code: 'KeyR' });
    expect({
        tools: setTool.mock.calls,
        deletes: deleteElements.mock.calls,
        updates: updateElements.mock.calls,
    }).toEqual({ tools: [], deletes: [], updates: [] });
});
