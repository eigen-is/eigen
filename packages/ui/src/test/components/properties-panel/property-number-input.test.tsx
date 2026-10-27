import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PropertyNumberInput } = await import('../../../components/properties-panel/property-number-input');

const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function render(value: number, step?: number) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const writes: number[] = [];
    await act(async () => {
        root.render(createElement(PropertyNumberInput, { value, step, onChange: (v: number) => writes.push(v) }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector('input');
    if (!input) throw new Error('the field rendered no input');
    return { input, writes };
}

test('a field shows the decimals its step implies: two for 0.01, one for 0.5, none for 1', async () => {
    expect((await render(16, 0.01)).input.value).toBe('16.00');
    await cleanup?.();
    expect((await render(1.25, 0.5)).input.value).toBe('1.3');
    await cleanup?.();
    expect((await render(120.37, 1)).input.value).toBe('120');
});

test('a field without a step shows its value as it is', async () => {
    expect((await render(120.37)).input.value).toBe('120.37');
});

test('while focused the field shows what was typed, and leaving it shows the step again', async () => {
    const { input, writes } = await render(16, 0.01);
    await act(async () => {
        input.focus();
    });
    await act(async () => {
        nativeValueSetter?.call(input, '16.5');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('16.5');
    expect(writes).toEqual([16.5]);
    await act(async () => {
        input.blur();
    });
    // The parent never stored the write, so the field shows the value it still holds.
    expect(input.value).toBe('16.00');
});
