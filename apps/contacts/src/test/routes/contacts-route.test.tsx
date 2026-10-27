// The contacts page lists the book, or a label's cards alone, sorted by first or last name. A contact URL
// opens that contact beside the list; one whose contact is gone, deleted or never there, says so in the
// detail, as Admin's users and teams do. The detail's Delete confirms first and sends the card's etag,
// and your own card offers no Delete at all.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, where the list and the detail sit side by side.
installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// The route's data, stubbed: three contacts in the book, one of them me, and one team with one member.
const ada: Contact = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: [], phone: [], etag: 'e1' };
const grace: Contact = {
    id: 'c2',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: [],
    phone: [],
    labels: ['l1'],
    etag: 'e2',
};
// No email on any card: a row with one resolves its account, which a test without a server leaves loading.
const me: Contact = { id: 'c3', firstName: 'Me', lastName: 'Myself', email: [], phone: [], eigenId: 'u1', etag: 'e3' };
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const contacts: { data: Contact[]; isLoading: boolean; error: Error | null } = {
    data: [],
    isLoading: false,
    error: null,
};
const labels = { data: [{ id: 'l1', name: 'Navy', color: '#1e3a8a' }] };
const teams = {
    data: [
        { id: 't1', name: 'Design', members: [{ userId: 'u2', name: 'Grace Hopper', email: 'grace@test.eigen.is' }] },
    ],
    isLoading: false,
};
const deleteContact = { mutateAsync: mock(async (_input: { id: string; etag: string }) => {}), isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realHome = { ...(await import('@workspace/lib/home')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContacts: () => contacts,
    useLabels: () => labels,
    useDeleteContact: () => deleteContact,
}));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => teams }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/home', () => realHome);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
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
beforeEach(() => {
    contacts.data = [grace, ada, me];
    contacts.isLoading = false;
    contacts.error = null;
    deleteContact.mutateAsync.mockClear();
});

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth },
    });
    await router.load();
    const rendered = await renderInDocument(createElement(RouterProvider, { router }));
    unmount = rendered.unmount;
    return { text: () => rendered.container.textContent ?? '', search: () => router.state.location.search };
}

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

// The list's rows as a user reads them.
const rows = () => [...document.querySelectorAll('.eigen-list-item')].map((row) => row.textContent);

test('the book lists every contact by first name', async () => {
    await open('/book/all');
    expect(rows()).toEqual(['Ada Lovelace', 'Grace Hopper', 'Me Myself']);
});

test('a label lists only its own cards', async () => {
    await open('/label/l1');
    expect(rows()).toEqual(['Grace Hopper']);
});

test('sorting by last name reorders the list and names each card last name first', async () => {
    await open('/book/all');
    await click(document.querySelector('.lucide-arrow-up-down')?.closest('button'));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Last name'));
    expect(rows()).toEqual(['Hopper, Grace', 'Lovelace, Ada', 'Myself, Me']);
});

test('an empty book says so', async () => {
    contacts.data = [];
    const page = await open('/book/all');
    expect(page.text()).toContain('No contacts found');
});

test('a book that fails to load says so with the reason', async () => {
    contacts.error = new Error('Service unavailable');
    const page = await open('/book/all');
    expect(page.text()).toContain('An error occurred while loading contacts.');
    expect(page.text()).toContain('Service unavailable');
});

test('a contact the URL names opens beside the list', async () => {
    const page = await open('/all/all?contactId=c1');
    expect(page.text()).not.toContain('Contact not found');
    expect(page.search()).toEqual({ contactId: 'c1' });
});

test('a contact that is gone says so and keeps its id in the URL', async () => {
    const page = await open('/all/all?contactId=gone');
    expect(page.text()).toContain('Contact not found');
    expect(page.search()).toEqual({ contactId: 'gone' });
});

test('a team member who is gone says so too', async () => {
    const page = await open('/team/t1?contactId=left@test.eigen.is');
    expect(page.text()).toContain('Member not found');
});

test('Delete asks first, then deletes the card with the etag it was read with and closes the detail', async () => {
    const page = await open('/book/all?contactId=c1');
    await click(document.querySelector('button[aria-label="Delete"]'));
    expect(deleteContact.mutateAsync).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain('Ada Lovelace');
    await click([...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Delete'));
    expect(deleteContact.mutateAsync.mock.calls).toEqual([[{ id: 'c1', etag: 'e1' }]]);
    expect(page.search()).toEqual({});
});

test('your own card offers no Delete', async () => {
    await open('/book/all?contactId=c3');
    const buttons = [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    expect(buttons).toContain('Edit');
    expect(buttons).not.toContain('Delete');
});
