// A message opens beside the list as a detail column. A row opens it on a new history entry, another row replaces it,
// and X or Esc closes it: back on the entry the row pushed, by replace on one a link opened, so back after a close
// never reopens the message. Closing keeps the search's ?q=. A message opened from the composer leaves the compose
// session's history state behind. Compose follows the same rule: from the list it pushes, over a message it replaces,
// and an archive or a delete of the open message closes it the same way.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { Email } from '@workspace/lib/types/mail';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, where the list and the detail sit side by side.
installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// happy-dom lays nothing out, and the virtualizer draws no row in a scroller 0 px tall. The prototype is held here, as
// the window's globals are gone by the time afterAll runs.
const elementPrototype = HTMLElement.prototype;
const clientHeight = Object.getOwnPropertyDescriptor(elementPrototype, 'clientHeight');
Object.defineProperty(elementPrototype, 'clientHeight', { configurable: true, get: () => 600 });

const email = (id: string, subject: string): Email => ({
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
    attachments: [],
    html: null,
    text: 'Hello',
});
const EMAILS = [email('m1', 'Plans'), email('m2', 'Budget')];
const mutation = { mutate: () => {}, mutateAsync: async () => {}, isPending: false };
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realMail = { ...(await import('@workspace/lib/mail')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
const realSpace = { ...(await import('@workspace/lib/space')) };
const realSearch = { ...(await import('@workspace/lib/search')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/mail', () => ({
    ...realMail,
    useEmails: () => ({
        emails: EMAILS,
        fetchNextPage: () => {},
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
        error: null,
    }),
    useEmail: (id: string | undefined) => ({ data: EMAILS.find((e) => e.id === id), isPending: false }),
    useEmailById: () => async (id: string) => EMAILS.find((e) => e.id === id) ?? null,
    useMailboxes: () => ({ data: [], isLoading: false, error: null }),
    useMoveEmail: () => mutation,
    useDeleteEmail: () => mutation,
}));
mock.module('@workspace/lib/public', () => ({ ...realPublic, useMailEnabled: () => true }));
mock.module('@workspace/lib/space', () => ({ ...realSpace, useSpaceSettings: () => ({ data: undefined }) }));
mock.module('@workspace/lib/search', () => ({
    ...realSearch,
    useSearchQuery: () => ({ data: undefined, isFetching: false }),
}));
afterAll(() => {
    if (clientHeight) Object.defineProperty(elementPrototype, 'clientHeight', clientHeight);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/mail', () => realMail);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/space', () => realSpace);
    mock.module('@workspace/lib/search', () => realSearch);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());

// More than one URL starts the history at the last, as a link opened after the others.
async function open(...urls: string[]) {
    const history = createMemoryHistory({ initialEntries: urls, initialIndex: urls.length - 1 });
    const router = createRouter({ routeTree, history, context: { auth } });
    await router.load();
    const rendered = await renderInDocument(
        createElement(PreviewProvider, null, createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    return {
        router,
        search: () => router.state.location.search,
        state: () => history.location.state,
        index: () => history.location.state.__TSR_index,
        back: () => settle(() => history.back()),
    };
}

// A back settles on the history's next tick, then the router loads the entry it lands on.
const settle = (action: () => void) =>
    act(async () => {
        action();
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

const row = (index: number) => document.querySelectorAll('.eigen-list-item')[index];
const clickRow = (index: number) => settle(() => row(index)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const closeButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');

test('a row opens its message on a new entry, another row replaces it, and X goes back keeping ?q=', async () => {
    const page = await open('/box/inbox?q=plans');
    await clickRow(0);
    expect(page.search()).toEqual({ q: 'plans', mailId: 'm1' });
    expect(page.index()).toBe(1);
    await clickRow(1);
    expect(page.search()).toEqual({ q: 'plans', mailId: 'm2' });
    expect(page.index()).toBe(1);
    await settle(() => closeButton()?.click());
    expect(page.search()).toEqual({ q: 'plans' });
    expect(page.index()).toBe(0);
});

test('X on a message a link opened replaces it, so back after it does not reopen the message', async () => {
    const page = await open('/box/inbox', '/box/inbox?mailId=m1&q=plans');
    await settle(() => closeButton()?.click());
    expect(page.search()).toEqual({ q: 'plans' });
    expect(page.index()).toBe(1);
    await page.back();
    expect(page.index()).toBe(0);
    expect(page.search()).toEqual({});
});

test('Esc closes the message a click opened, though its row is selected', async () => {
    const page = await open('/box/inbox');
    await clickRow(0);
    expect(page.search()).toEqual({ mailId: 'm1' });
    const list = document.querySelector('[tabindex="0"]');
    await settle(() =>
        list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
});

test('a message opened from the composer leaves the compose session behind', async () => {
    const page = await open('/box/inbox');
    await settle(() =>
        page.router.navigate({
            to: '/$filterType/$filterId',
            params: { filterType: 'box', filterId: 'inbox' },
            search: { mode: 'compose' },
            state: { composeSessionKey: 'k1', prefillDraft: { subject: 'RE: Plans' } },
        }),
    );
    await clickRow(0);
    expect(page.search()).toEqual({ mailId: 'm1' });
    expect(page.state().composeSessionKey).toBeUndefined();
    expect(page.state().prefillDraft).toBeUndefined();
    await settle(() => closeButton()?.click());
    expect(page.search()).toEqual({});
});

const button = (label: string) =>
    [...document.querySelectorAll('button')].find(
        (b) => b.textContent === label || b.getAttribute('aria-label') === label,
    );

test('Compose from the list opens on a new entry, and X goes back to the list keeping ?q=', async () => {
    const page = await open('/box/inbox?q=plans');
    await settle(() => button('Compose')?.click());
    expect(page.search()).toEqual({ q: 'plans', mode: 'compose' });
    expect(page.index()).toBe(1);
    expect(page.state().composeSessionKey).toBeDefined();
    await settle(() => closeButton()?.click());
    expect(page.search()).toEqual({ q: 'plans' });
    expect(page.index()).toBe(0);
});

test('Compose over an open message replaces it, so X goes back to the list and not to the message', async () => {
    const page = await open('/box/inbox');
    await clickRow(0);
    await settle(() => button('Compose')?.click());
    expect(page.search()).toEqual({ mode: 'compose' });
    expect(page.index()).toBe(1);
    await settle(() => closeButton()?.click());
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
});

test('archiving or deleting the open message closes it by going back', async () => {
    const page = await open('/box/inbox');
    // The last row, so there is no next message to move on to.
    await clickRow(1);
    expect(page.index()).toBe(1);
    await settle(() => button('Archive')?.click());
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
    await clickRow(1);
    await settle(() => button('Delete')?.click());
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
});
