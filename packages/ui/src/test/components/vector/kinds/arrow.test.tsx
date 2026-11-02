import { expect, test } from 'bun:test';
import type { VectorElement } from '@workspace/lib/vector';
import { DEFAULT_ELEMENT_PROPS } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { installHappyDom } from '../../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture, sealed } = await import('../../../../components/properties-panel/property-gesture');
const { PropertyGestureContext } = await import('../../../../components/properties-panel');
const { ArrowPanelSection } = await import('../../../../components/vector/kinds/arrow');

// React tracks an input's value on the instance, so assigning `input.value` looks like no change to it.
const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

const arrow: VectorElement = {
    ...DEFAULT_ELEMENT_PROPS,
    id: 'a1',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    angle: 0,
    index: 'a0',
    points: '0,0 100,0',
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding: '',
    fixedSegments: '',
    elbow: false,
    roundness: 'round',
    text: 'label',
    labelWidth: 40,
    fontSize: 20,
    fontFamily: 'sans',
};

// The Size field holds its own gesture while it is focused, so the digits typed are one undo step. The canvas measures
// the label's width in the new size, so the row writes the size alone.
test('a label size typed is one undo step that writes the size alone', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap<unknown>('element');
    const undoManager = new Y.UndoManager(element);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                PropertyGestureContext.Provider,
                { value: () => holdCapture(undoManager) },
                createElement(ArrowPanelSection, {
                    elements: [arrow],
                    scene: new Map<string, VectorElement>([[arrow.id, arrow]]),
                    onChange: () => {},
                    onReplace: () => {},
                    onChangeEach: (patch: (el: VectorElement) => Record<string, unknown>) =>
                        sealed(undoManager, () => {
                            for (const [field, v] of Object.entries(patch(arrow))) element.set(field, v);
                        }),
                }),
            ),
        );
    });

    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error('the arrow section did not render its Size field');
    for (const typed of ['1', '12']) {
        await act(async () => {
            input.focus();
            nativeValueSetter?.call(input, typed);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    await act(async () => input.dispatchEvent(new Event('focusout', { bubbles: true })));

    expect([...element.keys()]).toEqual(['fontSize']);
    expect(element.get('fontSize')).toBe(12);
    expect(undoManager.undoStack.length).toBe(1);

    await act(async () => root.unmount());
    container.remove();
});
