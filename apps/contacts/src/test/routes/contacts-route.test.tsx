// A contact URL opens that contact beside the list; one whose contact is gone, deleted or never there,
// says so in the detail, as Admin's users and teams do.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// The route's data, stubbed: one contact in the book, and one team with one member.
const ada: Contact = { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: [], phone: [], etag: 'e1' };
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const contacts = { data: [ada], isLoading: false };
const teams = {
    data: [
        { id: 't1', name: 'Design', members: [{ userId: 'u2', name: 'Grace Hopper', email: 'grace@test.eigen.is' }] },
    ],
    isLoading: false,
};
const realAuth = await import('@workspace/lib/auth');
const realContacts = await import('@workspace/lib/contacts');
const realHome = await import('@workspace/lib/home');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useContacts: () => contacts }));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => teams }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/home', () => realHome);
});

const { createElement } = await import('react');
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
