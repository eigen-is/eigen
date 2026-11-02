// The palette has no Radix trigger, since Mod+K or the search pill opens it. So it gives the focus back itself when
// it closes, to whatever had it when it opened, such as a Drive listing, whose keys then work without a click.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CommandContext } from '@workspace/lib/types/command-palette';
import { drivePath } from '../../../../drive-path';
import { installHappyDom } from '../../../../happy-dom';
import { renderInDocument } from '../../../../render-in-document';

installHappyDom();

// Signed out, so the contacts query stays off.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement, Fragment } = await import('react');
const { Pencil } = await import('lucide-react');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { CommandPaletteProvider } = await import(
    '../../../../../components/layout/app/command-palette/command-palette-provider'
);
const { CommandPalette } = await import('../../../../../components/layout/app/command-palette/command-palette');

const item = drivePath({ id: 'notes-1', name: 'notes.txt', mimeType: 'text/plain', parentId: 'root' });

// A listing with its selection published, so the empty palette lists the row the listing offers.
async function mountPalette() {
    const ran = { count: 0 };
    const controls = { setOpen: (_open: boolean) => {} };
    const ctx: CommandContext = {
        ownerId: 'owner-1',
        mailEnabled: false,
        selection: { items: [item] },
        selectionActions: [
            {
                action: { id: 'rename', label: 'Rename', icon: Pencil, group: 'organize' },
                run: () => {
                    ran.count += 1;
                },
            },
        ],
        docSearch: null,
        docSearchSession: null,
        docCommentSearch: null,
        navigate: () => {},
        openDriveCreate: () => {},
        openMailComposeWith: () => {},
        openPreview: () => {},
        toggleTheme: () => {},
    };
    function Host() {
        controls.setOpen = useCommandPalette().setOpen;
        return createElement(
            Fragment,
            null,
            createElement('div', { tabIndex: 0, 'data-list': '' }, 'notes.txt'),
            createElement(CommandPalette, { ctx }),
        );
    }
    const { unmount } = await renderInDocument(createElement(CommandPaletteProvider, null, createElement(Host)));
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const list = document.querySelector<HTMLElement>('[data-list]');
    if (!list) throw new Error('the list did not render');
    list.focus();
    await act(async () => controls.setOpen(true));
    await settle();
    return { list, ran, settle, unmount };
}

test('Escape closes the palette and gives the focus back to the list it opened from', async () => {
    const { settle, unmount } = await mountPalette();
    expect(document.querySelector('[cmdk-input]')).toBe(document.activeElement);
    await act(async () => {
        (document.activeElement ?? document).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    await settle();
    expect(document.querySelector('[cmdk-input]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-list')).toBe(true);
    await unmount();
});

test('running a row closes the palette and gives the focus back to the list it opened from', async () => {
    const { ran, settle, unmount } = await mountPalette();
    const row = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((r) =>
        r.textContent?.includes('Rename'),
    );
    if (!row) throw new Error('the row did not render');
    await act(async () => row.click());
    await settle();
    expect(ran.count).toBe(1);
    expect(document.querySelector('[cmdk-input]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-list')).toBe(true);
    await unmount();
});
