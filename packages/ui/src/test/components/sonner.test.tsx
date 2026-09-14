import { expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

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
