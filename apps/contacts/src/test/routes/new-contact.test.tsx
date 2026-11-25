// A new contact needs a first or a last name. Save sends the card with its blank email and phone rows
// dropped, then opens the new card in the book, and the form takes no second Save until it has left.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// The book and the create, stubbed: one object each, so the effects that depend on them settle.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const contacts = { data: [], isLoading: false, error: null };
const labels = { data: [] };
const addContact = { mutateAsync: mock(async (_input: CreateContactInput) => 'c-new'), isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContacts: () => contacts,
    useLabels: () => labels,
    useAddContact: () => addContact,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
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
    addContact.mutateAsync.mockClear();
});

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/new'] }),
        context: { auth },
    });
    await router.load();
    // The avatar uploads through the provider every app mounts around its routes.
    const rendered = await renderInDocument(
        createElement(UploadProvider, null, createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    return {
        router,
        text: () => rendered.container.textContent ?? '',
        location: () => [router.state.location.pathname, router.state.location.search],
    };
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

const save = () =>
    act(async () => {
        document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

test('a contact with neither a first nor a last name is refused', async () => {
    const page = await open();
    await type(field('First name'), '   ');
    await save();
    expect(page.text()).toContain('Either first name or last name is required');
    expect(addContact.mutateAsync).not.toHaveBeenCalled();
});

test('an email that is not one is refused', async () => {
    const page = await open();
    await type(field('First name'), 'Ada');
    const email = document.querySelector<HTMLInputElement>('input[placeholder="Email address"]');
    if (!email) throw new Error('the form has no email row');
    await type(email, 'ada at example');
    await save();
    expect(page.text()).toContain('Enter a valid email address');
    expect(addContact.mutateAsync).not.toHaveBeenCalled();
});

test('Save creates the card without its blank rows and opens it in the book', async () => {
    const page = await open();
    await type(field('Last name'), 'Lovelace');
    await save();

    const [input] = addContact.mutateAsync.mock.calls[0] ?? [];
    expect(input).toMatchObject({ firstName: '', lastName: 'Lovelace', email: [], phone: [], labels: [] });
    expect(page.location()).toEqual(['/book/all', { contactId: 'c-new' }]);
});

test('a second Enter while the saved contact opens creates no second contact', async () => {
    const page = await open();
    const leaving = Promise.withResolvers<void>();
    const navigate = page.router.navigate;
    const held = spyOn(page.router, 'navigate').mockImplementation(async (options) => {
        await leaving.promise;
        return navigate(options);
    });
    await type(field('First name'), 'Fenna');

    await act(async () => pressEnter(field('First name')));
    await act(async () => pressEnter(field('First name')));
    expect(addContact.mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => leaving.resolve());
    expect(page.location()).toEqual(['/book/all', { contactId: 'c-new' }]);
    held.mockRestore();
});
