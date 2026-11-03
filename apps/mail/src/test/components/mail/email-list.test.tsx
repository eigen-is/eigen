// The message list has no ⋮ button, so Shift+F10 and the ContextMenu key are the keyboard's way to a message's menu.
// The key opens the menu of the message under the cursor, at its row, and the contextmenu event the browser may send
// after it opens nothing more.
import { afterAll, afterEach, expect, test } from 'bun:test';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { contextMenuEvent } from '@workspace/ui/test/context-menu-event';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// happy-dom lays nothing out, and the virtualizer draws no row in a scroller 0 px tall.
// The prototype is held here, as the window's globals are gone by the time afterAll runs.
const elementPrototype = HTMLElement.prototype;
Object.defineProperty(elementPrototype, 'clientHeight', { configurable: true, get: () => 600 });
afterAll(() => {
    Reflect.deleteProperty(elementPrototype, 'clientHeight');
});

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { useListSelection } = await import('@workspace/ui/hooks/use-list-selection');
const { EmailList } = await import('../../../components/mail/email-list');

let unmount = async () => {};
afterEach(() => unmount());

const email = (id: string, subject: string): EmailSummary => ({
    id,
    filename: `${id}.eml`,
    subject,
    fromShort: 'Ada',
    fromAddress: 'ada@example.com',
    toShort: 'Grace',
    toAddress: 'grace@example.com',
    recipientsAll: 'grace@example.com',
    textShort: '',
    date: new Date('2026-01-05T14:30:00Z'),
    isRead: true,
    isFlagged: false,
    isDraft: false,
    isReplied: false,
    hasAttachments: false,
    mailbox: 'INBOX',
    size: 1,
});
const EMAILS = [email('m1', 'Plans'), email('m2', 'Budget')];

function List({ cursorIndex }: { cursorIndex: number }) {
    const selection = useListSelection({ items: EMAILS, getId: (e) => e.id });
    return createElement(EmailList, {
        orderedEmails: EMAILS,
        selection,
        cursorIndex,
        setCursorIndex: () => {},
        onRowClick: () => {},
        onReply: () => {},
    });
}

async function renderList(cursorIndex: number) {
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(List, { cursorIndex }))));
    const list = document.querySelector('[tabindex="0"]');
    if (!(list instanceof HTMLElement)) throw new Error('no message list');
    return list;
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    await act(async () => {
        target.dispatchEvent(event);
    });
    return event;
}

test('Shift+F10 and the ContextMenu key open the menu of the message under the cursor', async () => {
    for (const [key, init] of [
        ['ContextMenu', {}],
        ['F10', { shiftKey: true }],
    ] as const) {
        const list = await renderList(1);
        expect((await press(list, key, init)).defaultPrevented).toBe(true);
        expect(menuRows()).toContain('Reply');
        await unmount();
    }
});

test('the menu opens at the message’s row', async () => {
    const list = await renderList(1);
    const row = list.querySelector('[data-index="1"]');
    if (!(row instanceof HTMLElement)) throw new Error('the list drew no second row');
    row.getBoundingClientRect = () => new DOMRect(10, 100, 300, 80);
    await press(list, 'ContextMenu');
    // The menu's trigger, a zero-size point the menu opens below.
    const anchor = document.querySelector('[data-slot="dropdown-menu-trigger"]');
    expect(anchor instanceof HTMLElement && [anchor.style.left, anchor.style.top]).toEqual(['310px', '180px']);
});

test('the browser’s contextmenu after the key opens no second menu', async () => {
    const list = await renderList(0);
    await press(list, 'ContextMenu');
    const follow = contextMenuEvent('chrome-key');
    await act(async () => {
        (document.activeElement ?? list).dispatchEvent(follow);
    });
    expect(follow.defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
});
