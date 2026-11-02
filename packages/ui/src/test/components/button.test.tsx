// A Button is a plain button unless it says otherwise: inside a form it submits only with type="submit". A Button with
// asChild renders its child, such as a link, and puts no button type on it.
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
