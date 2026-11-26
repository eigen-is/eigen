// The one back of a column's bar: a lone chevron whose name is its tooltip, Back, or a chevron beside the name of
// the list it returns to, which is then the button's own name.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { BackButton } = await import('../../../../components/layout/toolbar/back-button');

async function render(label?: string) {
    const onClick = mock(() => {});
    const { container, unmount } = await renderInDocument(createElement(BackButton, { onClick, label }));
    const button = container.querySelector('button');
    if (!button) throw new Error('no button');
    const shown = {
        name: button.getAttribute('aria-label') ?? button.textContent,
        text: button.textContent,
        chevron: button.querySelector('svg.lucide-chevron-left') !== null,
    };
    await act(async () => button.click());
    await unmount();
    return { ...shown, clicks: onClick.mock.calls.length };
}

test('alone it is a chevron named Back', async () => {
    const back = await render();
    expect(back.name).toBe('Back');
    expect(back.text).toBe('');
    expect(back.chevron).toBe(true);
    expect(back.clicks).toBe(1);
});

test('with a label it is a chevron and the name of where it goes', async () => {
    const back = await render('Files');
    expect(back.name).toBe('Files');
    expect(back.text).toBe('Files');
    expect(back.chevron).toBe(true);
    expect(back.clicks).toBe(1);
});
