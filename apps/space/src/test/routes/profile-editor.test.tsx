// Personal info against a server stub that judges etags as the API does, through the real route and hooks. A field the
// user changed stays, and the others follow the card. A Save answers to the card typing began on, and a refused one
// keeps the form, so the next Save sends the new etag.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Contact, UpdateContactInput } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

const me: Contact = {
    id: 'c1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['me@test.eigen.is'],
    phone: [],
    notes: '',
    company: '',
    etag: 'v1',
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };

// The one card on the server, and the etag every update reached it with.
const server = { contact: me, revision: 1, writes: [] as string[] };
const changeElsewhere = (fields: Partial<Contact>) => {
    server.revision += 1;
    server.contact = { ...server.contact, ...fields, etag: `v${server.revision}` };
};
const contactsApi = () => ({
    me: { get: async () => ({ data: { ...server.contact }, error: null, status: 200 }) },
    contacts: () => ({
        put: async ({ etag, ...fields }: UpdateContactInput) => {
            server.writes.push(etag);
            if (etag !== server.contact.etag) {
                return { data: null, error: { status: 412, value: 'Refused' }, status: 412 };
            }
            changeElsewhere(fields);
            return { data: server.contact, error: null, status: 200 };
        },
    }),
});

const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realApi = { ...(await import('@workspace/lib/api')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/api', () => ({ ...realApi, contactsApi }));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/api', () => realApi);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('sonner', () => realSonner);
});

const { useQueryClient } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { invalidateContactList } = await import('@workspace/lib/contacts');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

// Stands for the stream's refetch after a change elsewhere.
function SyncButton() {
    const queryClient = useQueryClient();
    return createElement('button', {
        type: 'button',
        'data-testid': 'sync',
        onClick: () => invalidateContactList(queryClient, session.user.id),
    });
}

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    server.contact = me;
    server.revision = 1;
    server.writes = [];
    toasts.length = 0;
});

const settle = () =>
    act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/user'] }),
        context: { auth },
    });
    await router.load();
    const rendered = await renderInDocument(
        createElement(UploadProvider, null, createElement(SyncButton), createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    await settle();
    return { pathname: () => router.state.location.pathname };
}

function field(label: string): HTMLInputElement {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = element && document.getElementById(element.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
}

const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
const sync = async () => {
    await act(async () => document.querySelector<HTMLElement>('[data-testid="sync"]')?.click());
    await settle();
};
const save = async () => {
    await act(async () => {
        document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
};

test('a refused Save keeps what was typed and follows the rest, and the next Save sends the new etag', async () => {
    const page = await open();
    await type(field('First name'), 'Augusta');
    changeElsewhere({ lastName: 'King' });

    await save();
    expect(toasts).toHaveLength(1);
    expect(page.pathname()).toBe('/user');
    expect(field('First name').value).toBe('Augusta');
    expect(field('Last name').value).toBe('King');

    await save();
    expect(server.writes).toEqual(['v1', 'v2']);
    expect(server.contact).toMatchObject({ firstName: 'Augusta', lastName: 'King' });
    expect(page.pathname()).toBe('/');
});

test('a sync moves only the field nobody touched, and a Save over it is refused', async () => {
    await open();
    await type(field('First name'), 'Augusta');
    changeElsewhere({ lastName: 'King' });
    await sync();
    expect(field('First name').value).toBe('Augusta');
    expect(field('Last name').value).toBe('King');

    await save();
    expect(server.writes).toEqual(['v1']);
    expect(toasts).toHaveLength(1);
    expect(field('First name').value).toBe('Augusta');
});

test('a clean form follows the card, and its Save answers to what it shows', async () => {
    const page = await open();
    changeElsewhere({ lastName: 'King', avatar: '/avatars/ada.png' });
    await sync();
    expect(field('Last name').value).toBe('King');

    await save();
    expect(server.writes).toEqual(['v2']);
    expect(toasts).toEqual([]);
    expect(server.contact.avatar).toBe('/avatars/ada.png');
    expect(page.pathname()).toBe('/');
});
