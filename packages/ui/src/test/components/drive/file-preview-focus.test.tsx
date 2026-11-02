// Where the focus goes when the preview closes. A row's menu or the command palette that opened it is gone by then,
// but each gives the focus back to the list it came from while the preview is open, and the preview returns it there.
// So the list's keys work at once, without a click.
import { afterAll, expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import type { CommandContext } from '@workspace/lib/types/command-palette';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// Signed out, so the palette's contacts query stays off.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement, Fragment, useRef } = await import('react');
const { Eye } = await import('lucide-react');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { CommandPalette } = await import('../../../components/layout/app/command-palette/command-palette');
const { ContextMenuAnchor, useContextMenu } = await import('../../../components/context-menu');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { PreviewProvider, usePreview } = await import('../../../components/preview-provider');
const { useKeyboardListNavigation } = await import('../../../hooks/use-keyboard-list-navigation');

// A part with no preview of its own: the overlay draws its file card, and no query runs.
const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'application/octet-stream',
    filename: 'ledger.bin',
    size: 2048,
});
const rows = ['ledger.bin', 'journal.bin'];
const item = drivePath({ id: 'ledger-1', name: 'ledger.bin', mimeType: 'application/octet-stream' });

// A listing with the list's own keys, a row menu with Quick preview, and the palette offering Quick preview for the
// selected row.
async function mountListing() {
    const controls = { openMenu: () => {}, openPalette: () => {} };
    function Listing() {
        const { openPreview } = usePreview();
        const { setOpen } = useCommandPalette();
        const containerRef = useRef<HTMLDivElement>(null);
        const menu = useContextMenu<string>();
        const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
            items: rows,
            getId: (row) => row,
            onSelect: () => {},
            containerRef,
        });
        controls.openMenu = () => menu.openAt(rows[0], 0, 0);
        controls.openPalette = () => setOpen(true);
        const ctx: CommandContext = {
            ownerId: 'owner-1',
            mailEnabled: false,
            selection: { items: [item] },
            selectionActions: [
                {
                    action: { id: 'quick-look', label: 'Quick preview', icon: Eye, group: 'open' },
                    run: () => openPreview(subject, [subject]),
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
        return createElement(
            Fragment,
            null,
            createElement(
                'div',
                { ref: containerRef, tabIndex: 0, onKeyDown: handleKeyDown, 'data-list': '' },
                rows.map((row, index) =>
                    createElement(
                        'div',
                        { key: row, className: 'eigen-list-item', 'data-cursor': index === selectedIndex || undefined },
                        row,
                    ),
                ),
            ),
            createElement(ContextMenuAnchor, {
                contextMenu: menu,
                children: createElement(
                    DropdownMenuItem,
                    { onClick: () => openPreview(subject, [subject]) },
                    'Quick preview',
                ),
            }),
            createElement(CommandPalette, { ctx }),
        );
    }
    const { unmount } = await renderInDocument(
        createElement(PreviewProvider, null, createElement(CommandPaletteProvider, null, createElement(Listing))),
    );
    // Radix starts listening for outside clicks a tick after a layer opens, and the list takes the focus on a timer.
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    const run = async (action: () => void) => {
        await act(async () => action());
        await settle();
    };
    const press = (key: string) =>
        act(async () => {
            (document.activeElement ?? document).dispatchEvent(
                new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }),
            );
        });
    const clickRow = (selector: string, label: string) => {
        const row = [...document.querySelectorAll<HTMLElement>(selector)].find((r) => r.textContent?.includes(label));
        if (!row) throw new Error(`no ${label} row`);
        return run(() => row.click());
    };
    const preview = () => document.querySelector('[data-slot="file-preview"]');
    const cursor = () => document.querySelector('[data-cursor]')?.textContent;
    const listHasFocus = () => document.activeElement?.hasAttribute('data-list') === true;
    await settle();
    return { controls, run, press, clickRow, preview, cursor, listHasFocus, settle, unmount };
}

test('a preview opened from a row’s menu gives the focus back to the list, whose arrow keys work at once', async () => {
    const { controls, run, press, clickRow, preview, cursor, listHasFocus, settle, unmount } = await mountListing();
    expect(listHasFocus()).toBe(true);
    await run(controls.openMenu);
    await clickRow('[role="menuitem"]', 'Quick preview');
    expect(preview()).not.toBeNull();

    await press('Escape');
    await settle();
    expect(preview()).toBeNull();
    expect(listHasFocus()).toBe(true);
    await press('ArrowDown');
    expect(cursor()).toBe('ledger.bin');
    await unmount();
});

test('a preview opened from the command palette gives the focus back to the list the palette opened from', async () => {
    const { controls, run, press, clickRow, preview, cursor, listHasFocus, settle, unmount } = await mountListing();
    await run(controls.openPalette);
    await clickRow('[cmdk-item]', 'Quick preview');
    expect(document.querySelector('[cmdk-input]')).toBeNull();
    expect(preview()).not.toBeNull();

    await press('Escape');
    await settle();
    expect(preview()).toBeNull();
    expect(listHasFocus()).toBe(true);
    await press('ArrowDown');
    expect(cursor()).toBe('ledger.bin');
    await unmount();
});
