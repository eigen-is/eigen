// A row's ⋮ button opens the menu from itself, so the menu lands below it, and its click stays off the row under it,
// which would select or open the row.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { ContextMenuButton } = await import('../../../components/context-menu/context-menu-button');

test('a click opens the menu from the button and never reaches the row', async () => {
    const onOpen = mock((_button: HTMLElement) => {});
    const onRowClick = mock(() => {});
    await renderInDocument(
        createElement(
            'div',
            { onClick: onRowClick },
            createElement(ContextMenuButton, { onOpen, className: 'h-7 w-7' }),
        ),
    );
    const button = document.querySelector('button[aria-label="More actions"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no ⋮ button');
    await act(async () => button.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toBe(button);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(button.type).toBe('button');
});
