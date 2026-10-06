// Page setup shows the one page every doc is laid out on, read-only until a document can carry its own.
import { afterEach, expect, test } from 'bun:test';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { DEFAULT_PAGE_SETUP } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { PageSetupDialog } = await import('../../../components/docs/page-setup-dialog');

function control(label: string): HTMLElement | null {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    return element ? document.getElementById(element.htmlFor) : null;
}

// Unmounted after each test, failed or not: a dialog left open would answer the next test's queries.
let unmount = async () => {};
afterEach(() => unmount());

async function render(setup: PageSetup, onOpenChange: (open: boolean) => void = () => {}) {
    ({ unmount } = await renderInDocument(createElement(PageSetupDialog, { open: true, onOpenChange, setup })));
}

test('the default page is portrait A4 with 2 cm margins, and nothing can be changed', async () => {
    await render(DEFAULT_PAGE_SETUP);

    expect(control('Portrait')?.getAttribute('aria-checked')).toBe('true');
    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('false');
    expect(control('Paper size')?.textContent).toBe('A4 (21.0 cm × 29.7 cm)');
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
        const input = control(side);
        expect(input instanceof HTMLInputElement ? input.value : null).toBe('2');
    }

    const controls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        '[role="dialog"] [role="radio"], [role="dialog"] [role="combobox"], [role="dialog"] input',
    );
    expect(controls.length).toBe(7);
    for (const element of controls) expect(element.disabled).toBe(true);

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Every document uses this page for now.');
});

test('a landscape page is still A4', async () => {
    await render({ ...DEFAULT_PAGE_SETUP, width: 297, height: 210 });

    expect(control('Portrait')?.getAttribute('aria-checked')).toBe('false');
    expect(control('Landscape')?.getAttribute('aria-checked')).toBe('true');
    expect(control('Paper size')?.textContent).toBe('A4 (21.0 cm × 29.7 cm)');
});

test('Close closes the dialog', async () => {
    const calls: boolean[] = [];
    await render(DEFAULT_PAGE_SETUP, (open) => calls.push(open));

    const close = document.querySelector<HTMLButtonElement>('[data-slot="dialog-footer"] button');
    expect(close?.textContent).toBe('Close');
    await act(async () => close?.click());
    expect(calls).toEqual([false]);
});
