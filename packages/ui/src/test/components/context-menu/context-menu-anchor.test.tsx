import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// The anchor opens a real Radix menu (portal + focus scope + floating-ui), so this file borrows the
// whole happy-dom window and puts it back in afterAll, exactly like the file-action-menu-items test.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const borrowed: string[] = [];
for (const key of Object.getOwnPropertyNames(window)) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    const value = (window as any)[key];
    if (g[key] === undefined && value !== undefined) {
        g[key] = value;
        borrowed.push(key);
    }
}
for (const key of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element', 'HTMLElement']) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    g[key] = (window as any)[key];
    borrowed.push(key);
}
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.getComputedStyle = window.getComputedStyle.bind(window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}
g.ResizeObserver = FakeResizeObserver;
g.requestAnimationFrame = (callback: () => void) => {
    callback();
    return 0;
};
g.cancelAnimationFrame = () => {};

afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.getComputedStyle = undefined;
    g.ResizeObserver = undefined;
    g.requestAnimationFrame = undefined;
    g.cancelAnimationFrame = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { ContextMenuAnchor } = await import('../../../components/context-menu/context-menu-anchor');

// A dialog's centring transform: the containing block a fixed trigger would inherit if it stayed here.
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
