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

async function shown(value: number, step: number): Promise<string> {
    const { input } = await render(value, step);
    await cleanup?.();
    cleanup = undefined;
    return input.value;
}

test("a field shows its step's decimals at least: 16 at a step of 0.01 is 16.00, 3 at a step of 1 is 3", async () => {
    expect(await shown(16, 0.01)).toBe('16.00');
    expect(await shown(3, 1)).toBe('3');
    expect(await shown(1.5, 0.5)).toBe('1.5');
});

test("a field shows the value's own decimals up to two, past a coarser step", async () => {
    expect(await shown(2.67, 1)).toBe('2.67');
    expect(await shown(2.6666666666666665, 1)).toBe('2.67');
    expect(await shown(120.37, 1)).toBe('120.37');
});

test('a field rounds the decimal the value was written as, not its binary neighbour', async () => {
    // 1.15 is stored as 1.1499…, which toFixed(1) shows as 1.1; 2.675 as 2.6749…, which toFixed(2) shows as 2.67.
    expect(await shown(1.15, 0.1)).toBe('1.15');
    expect(await shown(2.675, 1)).toBe('2.68');
    // 1.005 * 100 is 100.4999…, so rounding by multiplying shows 1.
    expect(await shown(1.005, 1)).toBe('1.01');
    expect(await shown(0.1 + 0.2, 0.1)).toBe('0.3');
    expect(await shown(-2.675, 1)).toBe('-2.68');
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
