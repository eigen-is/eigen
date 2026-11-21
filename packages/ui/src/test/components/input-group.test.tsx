// A click on an addon's text focuses the group's input. A click inside something the addon portals out, such as the
// colour swatch's popover, reaches the addon through React's tree but not the DOM, and leaves the focus alone.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { createPortal } = await import('react-dom');
const { InputGroup, InputGroupAddon, InputGroupInput } = await import('../../components/input-group');

let unmount = async () => {};
afterEach(() => unmount());

async function renderGroup() {
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(
            InputGroup,
            null,
            createElement(InputGroupInput, { 'aria-label': 'Name' }),
            createElement(
                InputGroupAddon,
                null,
                createElement('span', null, '@eigen.is'),
                createPortal(createElement('div', { 'data-testid': 'portaled' }, 'Colours'), document.body),
            ),
        ),
    ));
    return container;
}

async function click(target: Element | null) {
    if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
    await act(async () => target.click());
}

test('a click on the addon text focuses the input', async () => {
    const container = await renderGroup();
    await click(container.querySelector('span'));
    expect(document.activeElement).toBe(container.querySelector('input'));
});

test('a click inside a portal the addon renders leaves the focus alone', async () => {
    const container = await renderGroup();
    await click(document.querySelector('[data-testid=portaled]'));
    expect(document.activeElement).not.toBe(container.querySelector('input'));
});
