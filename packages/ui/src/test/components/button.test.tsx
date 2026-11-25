// A Button is a plain button unless it says otherwise: inside a form it submits only with type="submit". A Button with
// asChild renders its child, such as a link, and puts no button type on it, nor a pending spinner.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Button } = await import('../../components/button');

let unmount = async () => {};
afterEach(() => unmount());

async function render(element: ReactElement) {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(element));
    return container;
}

async function click(target: Element | null) {
    if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
    await act(async () => target.click());
}

test('a plain Button is type="button"', async () => {
    const container = await render(createElement(Button, null, 'Close'));
    expect(container.querySelector('button')?.getAttribute('type')).toBe('button');
});

test('an explicit type wins', async () => {
    const container = await render(
        createElement('div', null, [
            createElement(Button, { key: 'submit', type: 'submit' }, 'Save'),
            createElement(Button, { key: 'reset', type: 'reset' }, 'Reset'),
        ]),
    );
    const types = [...container.querySelectorAll('button')].map((button) => button.getAttribute('type'));
    expect(types).toEqual(['submit', 'reset']);
});

test('a Button with asChild puts no type on its child', async () => {
    const container = await render(
        createElement(Button, { asChild: true }, createElement('a', { href: '/help' }, 'Help')),
    );
    const link = container.querySelector('a');
    expect(link?.dataset.slot).toBe('button');
    expect(link?.hasAttribute('type')).toBe(false);
});

test('inside a form, only a Button with type="submit" submits it', async () => {
    const onSubmit = mock((event: { preventDefault: () => void }) => event.preventDefault());
    const container = await render(
        createElement('form', { onSubmit }, [
            createElement(Button, { key: 'options' }, 'Options'),
            createElement(Button, { key: 'save', type: 'submit' }, 'Save'),
        ]),
    );
    const [options, save] = container.querySelectorAll('button');
    await click(options);
    expect(onSubmit).not.toHaveBeenCalled();
    await click(save);
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('a pending Button shows a spinner before its label, says it is busy and ignores a click', async () => {
    const onClick = mock(() => {});
    const container = await render(createElement(Button, { pending: true, onClick }, 'Save'));
    const button = container.querySelector('button');
    expect(button?.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(button?.lastChild?.textContent).toBe('Save');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    // Not disabled, so the focus stays on it instead of falling to the page.
    expect(button?.disabled).toBe(false);
    await click(button);
    expect(onClick).not.toHaveBeenCalled();
});

test('a pending submit Button submits nothing, and once done it submits again', async () => {
    const onSubmit = mock((event: { preventDefault: () => void }) => event.preventDefault());
    const form = (pending: boolean) =>
        createElement('form', { onSubmit }, createElement(Button, { type: 'submit', pending }, 'Save'));
    const container = await render(form(true));
    await click(container.querySelector('button'));
    expect(onSubmit).not.toHaveBeenCalled();
    await unmount();
    const done = await render(form(false));
    expect(done.querySelector('button')?.hasAttribute('aria-busy')).toBe(false);
    await click(done.querySelector('button'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('a Button with asChild that is not pending renders its child alone', async () => {
    const container = await render(
        createElement(Button, { asChild: true, pending: false }, createElement('a', { href: '/help' }, 'Help')),
    );
    expect(container.querySelector('a')?.textContent).toBe('Help');
});

test('a Button with asChild ignores pending, so its child keeps the classes and the click', async () => {
    const onClick = mock(() => {});
    const container = await render(
        createElement(Button, { asChild: true, pending: true, onClick }, createElement('a', { href: '#help' }, 'Help')),
    );
    const link = container.querySelector('a');
    expect(link?.className).toContain('inline-flex');
    expect(link?.textContent).toBe('Help');
    expect(link?.hasAttribute('aria-busy')).toBe(false);
    await click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
});
