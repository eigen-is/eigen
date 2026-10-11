// The Edit menu hands focus back through the host's handler, an editor's keep-focus, unless a Find pick already gave it
// to the find bar.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { DocSearchProvider } = await import('../../../../components/search/doc-search-provider');
const { EditMenu } = await import('../../../../components/layout/toolbar/edit-menu');

let unmount = async () => {};
afterEach(() => unmount());

const onUndo = mock(() => {});
const onCloseAutoFocus = mock((_event: Event) => {});

async function render() {
    onUndo.mockClear();
    onCloseAutoFocus.mockClear();
    const menu = createElement(EditMenu, {
        canEdit: true,
        canUndo: true,
        canRedo: false,
        onUndo,
        onRedo: () => {},
        onCloseAutoFocus,
    });
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };
    ({ unmount } = await renderInDocument(createElement(DocSearchProvider, { controller, children: menu })));
}

// Opens the menu, picks an item and waits out the timer on which the closing menu restores focus.
async function pick(label: string) {
    await act(async () => {
        document
            .querySelector('button[aria-haspopup="menu"]')
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
        entry.textContent?.trim().startsWith(label),
    );
    if (!item) throw new Error(`no ${label} item`);
    await act(async () => item.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

test("after Undo the host's handler restores focus", async () => {
    await render();
    await pick('Undo');
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
});

test("after Find the find bar keeps focus and the host's handler is skipped", async () => {
    await render();
    await pick('Find');
    expect(onCloseAutoFocus).not.toHaveBeenCalled();
    expect(document.activeElement?.tagName).toBe('INPUT');
});
