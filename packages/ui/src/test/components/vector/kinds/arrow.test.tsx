import { expect, test } from 'bun:test';
import { DEFAULT_ELEMENT_PROPS, type VectorElement } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { installHappyDom } from '../../../happy-dom';

const window = installHappyDom();

// happy-dom has no font set and no 2d context, and the label measurement needs both. The load is a
// deferred the test resolves itself — that IS the cold face this covers.
let resolveFont = () => {};
const fontLoaded = new Promise<void>((resolve) => {
    resolveFont = resolve;
});
// biome-ignore lint/suspicious/noExplicitAny: test-only DOM stubs happy-dom does not implement
const g = globalThis as any;
g.document.fonts = { load: () => fontLoaded, check: () => false };
// biome-ignore lint/suspicious/noExplicitAny: test-only DOM stubs happy-dom does not implement
(window.HTMLCanvasElement.prototype as any).getContext = () => ({ font: '', measureText: () => ({ width: 40 }) });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture, sealed } = await import('../../../../components/vector/hooks/use-canvas-doc');
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

// The Size field holds its own gesture while it is focused; on a cold font face the write lands after
// the blur that released it, so without a hold of its own every digit is an undo step of its own.
test('a label size typed against a cold font face is one undo step', async () => {
    const doc = new Y.Doc();
    const element = doc.getMap<number>('element');
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
                    onChangeEach: (patch: (el: VectorElement) => Record<string, unknown>) =>
                        sealed(undoManager, () => {
                            for (const [field, v] of Object.entries(patch(arrow))) {
                                if (typeof v === 'number') element.set(field, v);
                            }
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
    // Leaving the field releases the field's own hold, before the face has loaded.
    await act(async () => input.dispatchEvent(new Event('focusout', { bubbles: true })));

    await act(async () => {
        resolveFont();
        await fontLoaded;
        await Promise.resolve();
    });

    expect(element.get('fontSize')).toBe(12);
    expect(undoManager.undoStack.length).toBe(1);

    await act(async () => root.unmount());
    container.remove();
});
