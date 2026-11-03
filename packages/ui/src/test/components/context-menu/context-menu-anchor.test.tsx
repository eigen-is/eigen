import { expect, test } from 'bun:test';
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
