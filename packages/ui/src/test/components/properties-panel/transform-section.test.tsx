import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
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
