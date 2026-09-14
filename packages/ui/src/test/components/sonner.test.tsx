import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// Mounts a real Toaster and reads the toast back out of the DOM, exactly like the attachment
// chip-menu test next door.
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
for (const key of ['Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'Node', 'Element', 'HTMLElement']) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    g[key] = (window as any)[key];
    borrowed.push(key);
}
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { toast } = await import('sonner');
const { Toaster } = await import('../../components/sonner');

// A save that ends in a toast runs from inside a modal dialog — the save-to-drive picker is still
// open while its mutation resolves, and a convert opens the progress dialog on top of it. Radix
// parks `pointer-events: none` on <body> for as long as one is mounted, and the toaster lives
// under <body>, so without its own opt-out the toast's action is visible but dead.
test('a toast action stays clickable while a modal dialog holds the body pointer-events lock', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(createElement(Toaster));
    });

    document.body.style.pointerEvents = 'none';

    await act(async () => {
        toast.success('Attachment saved to Drive', { action: { label: 'Open folder', onClick: () => {} } });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toastElement = document.querySelector('[data-sonner-toast]') as HTMLElement | null;
    expect(toastElement?.querySelector('[data-action]')?.textContent).toBe('Open folder');
    // The opt-out has to sit on the toast itself: `pointer-events` inherits, and only an element
    // that sets its own stays a hit target under a `none` ancestor.
    expect(toastElement?.style.pointerEvents).toBe('auto');

    await act(async () => {
        root.unmount();
    });
});
