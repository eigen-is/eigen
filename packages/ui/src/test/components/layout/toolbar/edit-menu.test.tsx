// The Edit menu hands focus back through the host's handler, an editor's keep-focus, unless a Find pick already gave it
// to the find bar. A host's selection entries sit in a group of their own between Undo and Find, for viewers too, and a
// host's classes reach the menu, such as Sheets' width.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { collapseSeparators } from '../../../menu-rows';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { DropdownMenuItem } = await import('../../../../components/dropdown-menu');
const { DocSearchProvider } = await import('../../../../components/search/doc-search-provider');
const { EditMenu } = await import('../../../../components/layout/toolbar/edit-menu');
const { Menubar } = await import('../../../../components/menubar');

let unmount = async () => {};
afterEach(() => unmount());

let onUndo = mock(() => {});
let onCloseAutoFocus = mock((_event: Event) => {});

async function render({
    canEdit = true,
    selectionItems,
    contentClassName,
}: {
    canEdit?: boolean;
    selectionItems?: string[];
    contentClassName?: string;
} = {}) {
    // Fresh handlers per render: a menu the last test left open calls its own one a tick after it unmounts.
    onUndo = mock(() => {});
    onCloseAutoFocus = mock((_event: Event) => {});
    const menu = createElement(EditMenu, {
        canEdit,
        canUndo: true,
        canRedo: false,
        onUndo,
        onRedo: () => {},
        onCloseAutoFocus,
        contentClassName,
        selectionItems: selectionItems?.map((label) => createElement(DropdownMenuItem, { key: label }, label)),
    });
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };
    ({ unmount } = await renderInDocument(
        createElement(DocSearchProvider, { controller, children: createElement(Menubar, null, menu) }),
    ));
}

async function open() {
    await act(async () => {
        document
            .querySelector('button[aria-haspopup="menu"]')
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

// The open menu's entries in order, a separator as '—', the shortcut hint dropped.
const entries = () =>
    collapseSeparators(
        [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="separator"]')].map(
            (entry) =>
                entry.getAttribute('role') === 'separator'
                    ? '—'
                    : [...entry.childNodes]
                          .filter((node) => node.nodeType === Node.TEXT_NODE)
                          .map((node) => node.textContent)
                          .join('')
                          .trim(),
        ),
    );

// Opens the menu, picks an item and waits out the timer on which the closing menu restores focus.
async function pick(label: string) {
    await open();
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

test("a host's selection entries sit between Undo and Find, each group set apart", async () => {
    await render({ selectionItems: ['Copy', 'Select all'] });
    await open();
    expect(entries()).toEqual(['Undo', 'Redo', '—', 'Copy', 'Select all', '—', 'Find']);
});

test("a viewer gets the host's selection entries and Find, with no Undo", async () => {
    await render({ canEdit: false, selectionItems: ['Copy', 'Select all'] });
    await open();
    expect(entries()).toEqual(['Copy', 'Select all', '—', 'Find']);
});

test('without selection entries the menu stays Undo, Redo, then Find', async () => {
    await render();
    await open();
    expect(entries()).toEqual(['Undo', 'Redo', '—', 'Find']);
});

test("a host's classes reach the menu", async () => {
    await render({ contentClassName: 'w-56 sheet-mousedown-cancel' });
    await open();
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.classList.contains('w-56')).toBe(true);
    expect(menu?.classList.contains('sheet-mousedown-cancel')).toBe(true);
});
