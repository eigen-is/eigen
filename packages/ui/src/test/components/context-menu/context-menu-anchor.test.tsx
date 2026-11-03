import { expect, test } from 'bun:test';
import { contextMenuEvent, KEY_SOURCES, POINTER_SOURCES } from '../../context-menu-event';
import { recordFocus } from '../../focus-calls';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { ContextMenuAnchor } = await import('../../../components/context-menu/context-menu-anchor');

// A dialog's centering transform: the containing block a fixed trigger would inherit if it stayed here.
async function mountInTransformedHost() {
    const container = document.createElement('div');
    container.style.transform = 'translate(-50%, -50%)';
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(ContextMenuAnchor, {
                contextMenu: { isOpen: true, position: { x: 120, y: 80 }, close: () => {}, restoreFocus: () => {} },
                children: createElement(DropdownMenuItem, { children: 'Quick preview' }),
            }),
        );
    });
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { container, cleanup };
}

test('the trigger sits in document.body, at the viewport coordinates it was given', async () => {
    const { container, cleanup } = await mountInTransformedHost();
    const trigger = document.querySelector('[aria-haspopup="menu"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.parentElement).toBe(document.body);
    expect(container.contains(trigger)).toBe(false);
    expect(trigger?.getAttribute('style')).toContain('left: 120px');
    expect(trigger?.getAttribute('style')).toContain('top: 80px');
    await cleanup();
});

test('the menu draws the rows the host passed', async () => {
    const { cleanup } = await mountInTransformedHost();
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent?.trim());
    expect(labels).toEqual(['Quick preview']);
    await cleanup();
});

// On Windows the menu key's contextmenu comes as the key comes up, when the menu it opened holds the focus. A
// right-click inside the menu keeps the browser's own menu, as before.
test('a key’s contextmenu inside the menu opens no browser menu over it, and a pointer’s stays the browser’s', async () => {
    const { cleanup } = await mountInTransformedHost();
    const row = document.querySelector('[role="menuitem"]');
    if (!row) throw new Error('no menu row');
    const sent = [...KEY_SOURCES, ...POINTER_SOURCES].map((source) => {
        const event = contextMenuEvent(source);
        row.dispatchEvent(event);
        return [source, event.defaultPrevented];
    });
    await cleanup();
    expect(sent).toEqual([
        ['chrome-key', true],
        ['firefox-key', true],
        ['old-firefox-key', true],
        ['right-click', false],
        ['ctrl-click', false],
        ['long-press', false],
    ]);
});

test('Escape from the menu gives the focus back to the list it opened from', async () => {
    const { useContextMenu } = await import('../../../components/context-menu/use-context-menu');
    let openMenu = () => {};
    function Listing() {
        const menu = useContextMenu<string>();
        openMenu = () => menu.openAt('notes.txt', 0, 0);
        return createElement(
            'div',
            null,
            createElement('div', { tabIndex: 0, 'data-list': '' }, 'notes.txt'),
            createElement(ContextMenuAnchor, {
                contextMenu: menu,
                children: createElement(DropdownMenuItem, { children: 'Rename' }),
            }),
        );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Listing)));
    document.querySelector<HTMLElement>('[data-list]')?.focus();
    await act(async () => openMenu());
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await settle();
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    await act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-list')).toBe(true);
    await act(async () => root.unmount());
    container.remove();
});

// A row's ⋮ that a mouse clicked has the focus without a ring. Its menu gives the focus back the same way, so the ⋮,
// which shows while it has a ring, doesn't stay shown after the pointer left. A ⋮ the keyboard reached gets its ring
// back.
test('a menu gives the focus back to its opener with a ring only if the opener had one', async () => {
    const { useContextMenu } = await import('../../../components/context-menu/use-context-menu');
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const restored = [];
    for (const withoutRing of [true, false]) {
        let openMenu = () => {};
        function Row() {
            const menu = useContextMenu<string>();
            openMenu = () => menu.openAt('notes.txt', 0, 0);
            return createElement(
                'div',
                null,
                createElement('button', { type: 'button', 'data-more': '' }, '⋮'),
                createElement(ContextMenuAnchor, {
                    contextMenu: menu,
                    children: createElement(DropdownMenuItem, { children: 'Rename' }),
                }),
            );
        }
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(createElement(Row)));
        const more = document.querySelector<HTMLElement>('[data-more]');
        if (!more) throw new Error('no ⋮');
        const calls = recordFocus(more, { withoutRing });
        more.focus();
        await act(async () => openMenu());
        await settle();
        await act(async () => {
            document.activeElement?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        await settle();
        restored.push([document.activeElement === more, calls.at(-1)?.focusVisible]);
        await act(async () => root.unmount());
        container.remove();
    }
    expect(restored).toEqual([
        [true, false],
        [true, undefined],
    ]);
});
