import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// react-dom needs a DOM to render into; the section is plain inputs, so this file borrows the handful
// of globals React itself needs and puts them back afterwards (the color-row test's recipe).
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const borrowed: string[] = [];
for (const key of Object.getOwnPropertyNames(window)) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    const value = (window as any)[key];
    if (g[key] === undefined && value !== undefined) {
        g[key] = value;
        borrowed.push(key);
    }
}
for (const key of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element', 'HTMLElement']) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    g[key] = (window as any)[key];
    borrowed.push(key);
}
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

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
