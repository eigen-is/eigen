// Google's "− [11] +": the buttons step, the box takes a typed size on Enter or blur and drops it on Escape.
import { afterEach, expect, mock, test } from 'bun:test';
import { type } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { FontSizeStepper } = await import('../../../components/media/font-size-stepper');

let unmount = async () => {};
afterEach(() => unmount());

const onChange = mock((_size: number) => {});
const onStep = mock((_by: 1 | -1) => {});

async function render(value: number | undefined) {
    onChange.mockClear();
    onStep.mockClear();
    ({ unmount } = await renderInDocument(createElement(FontSizeStepper, { value, onChange, onStep })));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
    if (!input) throw new Error('the stepper drew no input');
    return input;
}

// Types a size, then presses `key` or, with none, leaves the box.
async function typeSize(input: HTMLInputElement, text: string, key?: string) {
    await act(async () => input.focus());
    await type(input, text);
    await act(async () => {
        if (key) input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        else input.blur();
    });
}

const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

test('the box shows the size, and nothing for a mix', async () => {
    expect((await render(10.5)).value).toBe('10.5');
    await unmount();
    expect((await render(undefined)).value).toBe('');
});

test('the buttons step', async () => {
    await render(11);
    await act(async () => button('Increase font size')?.click());
    await act(async () => button('Decrease font size')?.click());
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
});

test("a typed size lands in Google's range, in half points", async () => {
    const input = await render(11);
    await typeSize(input, '13', 'Enter');
    await typeSize(input, '10.3', 'Enter');
    await typeSize(input, '999');
    expect(onChange.mock.calls).toEqual([[13], [10.5], [400]]);
});

test('Escape, a word, a cleared box or no change applies nothing and shows the size again', async () => {
    const input = await render(11);
    await typeSize(input, '14', 'Escape');
    expect(input.value).toBe('11');
    await typeSize(input, 'big', 'Enter');
    expect(input.value).toBe('11');
    await typeSize(input, '', 'Enter');
    expect(input.value).toBe('11');
    await typeSize(input, '11');
    expect(onChange).not.toHaveBeenCalled();
});

test('a size with a stray letter in it is refused, not read up to the letter', async () => {
    const input = await render(11);
    await typeSize(input, '1x1', 'Enter');
    expect(input.value).toBe('11');
    expect(onChange).not.toHaveBeenCalled();
});

// The focus may move on as the size applies, such as back to a cell editor with a word selected, and the
// browser types a key's default action into whatever has the focus then.
test('the Enter that applies a size does nothing else', async () => {
    const input = await render(11);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => input.focus());
    await type(input, '18');
    await act(async () => {
        input.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(onChange.mock.calls).toEqual([[18]]);
});
