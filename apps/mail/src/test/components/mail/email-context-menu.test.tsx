// A message's menu in the one menu order: the replies first, Delete last, alone and red.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { ContextMenuAnchor } = await import('@workspace/ui/components/context-menu');
const { EmailContextMenu } = await import('../../../components/mail/email-context-menu');

let unmount = async () => {};
afterEach(() => unmount());

const noop = () => {};

async function openMenu(messageIds: string[]) {
    ({ unmount } = await renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(ContextMenuAnchor, {
                contextMenu: { isOpen: true, position: { x: 0, y: 0 }, close: noop, restoreFocus: noop },
                children: createElement(EmailContextMenu, {
                    messageIds,
                    isSingleSelect: messageIds.length === 1,
                    mailboxes: [],
                    currentMailboxId: 'INBOX',
                    onClose: noop,
                    onPrint: noop,
                }),
            }),
        ),
    ));
    return menuRows();
}

test('a message reads Reply | Archive, Report spam, Move to folder | Download, Print | Delete', async () => {
    expect(await openMenu(['m1'])).toEqual([
        'Reply',
        'Reply all',
        'Forward',
        '—',
        'Archive',
        'Report spam',
        'Move to folder',
        '—',
        'Download',
        'Print',
        '—',
        'Delete',
    ]);
    expect(document.querySelector('[data-variant="destructive"]')?.textContent).toBe('Delete');
});

test('a selection drops the single-message rows', async () => {
    expect(await openMenu(['m1', 'm2'])).toEqual([
        'Archive 2 emails',
        'Report spam',
        'Move to folder',
        '—',
        'Delete 2 emails',
    ]);
});
