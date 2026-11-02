// A sidebar's primary button, such as Calendar's Create event, shows its label beside the icon. Condensed, it shows the
// icon alone and still carries the label as its name, for a screen reader.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { CalendarPlus } = await import('lucide-react');
const { SidebarPrimaryButton } = await import('../../../../components/layout/sidebar/sidebar-primary-button');

let unmount = async () => {};
afterEach(() => unmount());

async function render(condensed: boolean) {
    ({ unmount } = await renderInDocument(
        createElement(SidebarPrimaryButton, { icon: CalendarPlus, label: 'Create event', condensed }),
    ));
    const button = document.querySelector('button');
    if (!button) throw new Error('nothing drew a button');
    return button;
}

test('the full button shows its label', async () => {
    const button = await render(false);
    expect(button.textContent).toBe('Create event');
});

test('the condensed button shows only the icon and is named by its label', async () => {
    const button = await render(true);
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Create event');
});
