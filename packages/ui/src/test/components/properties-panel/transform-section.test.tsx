import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture, sealed } = await import('../../../components/vector/hooks/use-canvas-doc');
const { PropertiesPanel } = await import('../../../components/properties-panel/properties-panel');
const { TransformSection } = await import('../../../components/properties-panel/transform-section');
const { useAspectLock } = await import('../../../components/properties-panel/use-aspect-lock');

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

// A coupled edit divides by the ratio the gesture STARTED from. Re-deriving it per keystroke reads
// it back off the rounded box the previous one wrote: 100x50 typed up to 250 walks 2x1, 25x13 and
// lands on 250x130 instead of 250x125.
test('an aspect-locked width keeps the ratio it started the edit with', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let box = { width: 100, height: 50 };
    const render = async () => {
        await act(async () => {
            root.render(
                createElement(TransformSection, {
                    x: 0,
                    y: 0,
                    width: box.width,
                    height: box.height,
                    angle: 0,
                    aspectLocked: true,
                    onAspectLockChange: () => {},
                    onChange: (fields: Record<string, number>) => {
                        box = { ...box, ...fields };
                    },
                }),
            );
        });
    };
    await render();

    const input = [...container.querySelectorAll('input')][2];
    if (!input) throw new Error('the transform section did not render its inputs');
    for (const typed of ['2', '25', '250']) {
        await act(async () => {
            input.focus();
            nativeValueSetter?.call(input, typed);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await render();
    }
    expect(box).toEqual({ width: 250, height: 125 });

    await act(async () => root.unmount());
    container.remove();
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

// Mounts the checkbox the way every canvas host does — through `useAspectLock` — and drives it by
// selection: `select` re-renders with a new one, `toggle` clicks the checkbox, `locked` reads it back.
function mountAspectLock() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const Host = ({ ids, allImages }: { ids: string[]; allImages: boolean }) => {
        const [aspectLocked, onAspectLockChange] = useAspectLock(ids, allImages);
        return createElement(TransformSection, {
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            angle: 0,
            onChange: () => {},
            aspectLocked,
            onAspectLockChange,
        });
    };
    const checkbox = () => {
        const el = container.querySelector('[role="checkbox"]');
        if (!el) throw new Error('the transform section did not render its aspect checkbox');
        return el;
    };
    return {
        select: async (ids: string[], allImages = true) => {
            await act(async () => root.render(createElement(Host, { ids, allImages })));
        },
        toggle: async () => {
            await act(async () => checkbox().dispatchEvent(new MouseEvent('click', { bubbles: true })));
        },
        locked: () => checkbox().getAttribute('aria-checked') === 'true',
        cleanup: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

// Unchecking an image, clicking away and clicking it again used to re-lock it silently: the state
// reset to the selection's default on every selection change, and images default to locked.
test('unchecking the aspect lock sticks to that element across a reselect', async () => {
    const panel = mountAspectLock();
    await panel.select(['image-1']);
    expect(panel.locked()).toBe(true);

    await panel.toggle();
    expect(panel.locked()).toBe(false);

    // Another image is untouched by that choice, and coming back finds the element's own.
    await panel.select(['image-2']);
    expect(panel.locked()).toBe(true);
    await panel.select(['image-1']);
    expect(panel.locked()).toBe(false);

    await panel.cleanup();
});

// The stickiness runs both ways: a kind that defaults to unlocked keeps a manual check too.
test('checking the aspect lock on a shape sticks across a reselect', async () => {
    const panel = mountAspectLock();
    await panel.select(['shape-1'], false);
    expect(panel.locked()).toBe(false);

    await panel.toggle();
    await panel.select(['image-1']);
    await panel.select(['shape-1'], false);
    expect(panel.locked()).toBe(true);

    await panel.cleanup();
});

// A multi-selection has no single remembered choice unless every element agrees, so it shows the
// default until it does.
test('a mixed multi-selection falls back to the default', async () => {
    const panel = mountAspectLock();
    await panel.select(['image-1']);
    await panel.toggle();

    await panel.select(['image-1', 'image-2']);
    expect(panel.locked()).toBe(true);

    // Unchecking the pair records both, so the pair (and each of them) stays unchecked.
    await panel.toggle();
    await panel.select(['image-2']);
    expect(panel.locked()).toBe(false);
    await panel.select(['image-1', 'image-2']);
    expect(panel.locked()).toBe(false);

    await panel.cleanup();
});
