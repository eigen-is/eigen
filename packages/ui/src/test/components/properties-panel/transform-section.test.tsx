import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture, sealed } = await import('../../../components/vector/hooks/use-canvas-doc');
const { PropertiesPanel } = await import('../../../components/properties-panel/properties-panel');
const { TransformSection } = await import('../../../components/properties-panel/transform-section');

// React tracks an input's value on the instance, so assigning `input.value` looks like no change to it.
// Writing through the prototype setter leaves React's tracker stale, which is what a real keystroke does.
const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

// Types `typed` into one of the section's inputs and returns every field write it produced.
async function typeInto(label: 'W' | 'Angle', typed: string) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const writes: Record<string, number>[] = [];
    await act(async () => {
        root.render(
            createElement(TransformSection, {
                x: 0,
                y: 0,
                width: 100,
                height: 50,
                angle: 0,
                onChange: (fields: Record<string, number>) => writes.push(fields),
            }),
        );
    });

    const inputs = [...container.querySelectorAll('input')];
    const input = label === 'Angle' ? inputs[inputs.length - 1] : inputs[2];
    if (!input) throw new Error('the transform section did not render its inputs');
    await act(async () => {
        input.focus();
        nativeValueSetter?.call(input, typed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => root.unmount());
    container.remove();
    return writes;
}

// The Angle row is built to accept an out-of-range entry and wrap it (normalizeAngle) — its min/max
// would clamp -90 to 0 before the wrap ever ran, which made a negative rotation un-typable.
test('a negative angle wraps instead of clamping to zero', async () => {
    expect(await typeInto('Angle', '-90')).toEqual([{ angle: 270 }]);
});

test('an angle past a full turn wraps too', async () => {
    expect(await typeInto('Angle', '450')).toEqual([{ angle: 90 }]);
});

// The bounded rows still clamp on the way in: the input's own min only drives the spinner, so a typed
// 0 would otherwise reach the document as a zero-size box.
test('a width below its minimum is still clamped before it is written', async () => {
    expect(await typeInto('W', '0')).toEqual([{ width: 1 }]);
});

// Typing a number is ONE edit, not one per digit: the panel's writes are sealed on both sides, so
// without the panel gesture around them "250" leaves three undo steps and ⌘Z walks back through the
// digits.
test('typing three digits into a transform field is one undo step', async () => {
    const doc = new Y.Doc();
    const box = doc.getMap<number>('box');
    const undoManager = new Y.UndoManager(box);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(PropertiesPanel, {
                beginGesture: () => holdCapture(undoManager),
                children: createElement(TransformSection, {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 50,
                    angle: 0,
                    onChange: (fields: Record<string, number>) =>
                        sealed(undoManager, () => {
                            for (const [field, v] of Object.entries(fields)) box.set(field, v);
                        }),
                }),
            }),
        );
    });

    const input = [...container.querySelectorAll('input')][2];
    if (!input) throw new Error('the transform section did not render its inputs');
    for (const typed of ['2', '25', '250']) {
        await act(async () => {
            input.focus();
            nativeValueSetter?.call(input, typed);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    expect(box.get('width')).toBe(250);
    expect(undoManager.undoStack.length).toBe(1);

    // Leaving the field closes the gesture, so the NEXT edit is a step of its own.
    await act(async () => input.dispatchEvent(new Event('focusout', { bubbles: true })));
    expect(undoManager.undoStack.length).toBe(1);

    await act(async () => root.unmount());
    container.remove();
});
