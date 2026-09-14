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
