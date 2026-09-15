import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useDialogOpen } = await import('../../hooks/use-dialog-open');

// happy-dom delivers mutation records on a later task, like the browser.
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function mount() {
    let latest: boolean | null = null;
    function Harness() {
        latest = useDialogOpen();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness)));
    return {
        get open() {
            if (latest === null) throw new Error('hook has not rendered');
            return latest;
        },
        unmount: () => act(() => root.unmount()),
    };
}

describe('useDialogOpen', () => {
    test('follows a dialog through open, exit animation and removal', async () => {
        const h = mount();
        expect(h.open).toBe(false);

        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('data-state', 'open');
        document.body.appendChild(dialog);
        await settle();
        expect(h.open).toBe(true);

        dialog.setAttribute('data-state', 'closed');
        await settle();
        expect(h.open).toBe(false);

        dialog.remove();
        await settle();
        expect(h.open).toBe(false);
        h.unmount();
    });

    test('an alert dialog nested deep in the tree counts, and reads true on first render', async () => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<section><div role="alertdialog"></div></section>';
        document.body.appendChild(wrapper);
        const h = mount();
        expect(h.open).toBe(true);

        wrapper.remove();
        await settle();
        expect(h.open).toBe(false);
        h.unmount();
    });
});
