// Two clients on one contact, through the real route and hooks against a server stub that judges etags as the API does.
// Edit contact keeps what was typed and follows the rest. A sync moves only the fields nobody touched and can't let
// typed edits overwrite a change unseen. A refused Save keeps the form, and the next one sends the new etag.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Contact, UpdateContactInput } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

const ada: Contact = {
    id: 'c1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['ada@example.org'],
    phone: [],
    notes: '',
    company: '',
    etag: 'v1',
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const labels = { data: [] };

// The one card on the server, and the etag every update reached it with.
const server = { contact: ada, revision: 1, writes: [] as string[] };
const changeElsewhere = (fields: Partial<Contact>) => {
    server.revision += 1;
    server.contact = { ...server.contact, ...fields, etag: `v${server.revision}` };
};
const contactsApi = () => ({
    contacts: Object.assign(
        () => ({
            put: async ({ etag, ...fields }: UpdateContactInput) => {
                server.writes.push(etag);
                if (etag !== server.contact.etag) {
                    return { data: null, error: { status: 412, value: 'Refused' }, status: 412 };
                }
                changeElsewhere(fields);
                return { data: server.contact, error: null, status: 200 };
            },
        }),
        { get: async () => ({ data: [{ ...server.contact }], error: null, status: 200 }) },
    ),
});

const toasts: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realApi = { ...(await import('@workspace/lib/api')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realSonner = { ...(await import('sonner')) };
mock.module('@workspace/lib/api', () => ({ ...realApi, contactsApi }));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useLabels: () => labels }));
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));
afterAll(() => {
    mock.module('@workspace/lib/api', () => realApi);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
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
    server.contact = ada;
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
        history: createMemoryHistory({ initialEntries: ['/edit/book/all?contactId=c1'] }),
        context: { auth },
    });
    await router.load();
    const rendered = await renderInDocument(
        createElement(UploadProvider, null, createElement(SyncButton), createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    await settle();
    return { text: () => rendered.container.textContent ?? '', pathname: () => router.state.location.pathname };
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
    const element = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = element && document.getElementById(element.htmlFor);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
        throw new Error(`no field labelled ${label}`);
    }
    return input;
}
const rows = (placeholder: string) => [
    ...document.querySelectorAll<HTMLInputElement>(`input[placeholder="${placeholder}"]`),
];

const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
        const prototype =
            input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
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

const STALE_TOAST = 'This contact changed elsewhere. Check it and try again.';

test('a refused Save keeps what was typed and follows the rest, and the next Save sends the new etag', async () => {
    const page = await open();
    await type(field('Notes'), 'Met at the conference');
    changeElsewhere({ company: 'Analytical Engines' });

    await save();
    expect(toasts).toEqual([STALE_TOAST]);
    expect(page.pathname()).toBe('/edit/book/all');
    expect(field('Notes').value).toBe('Met at the conference');
    expect(field('Company').value).toBe('Analytical Engines');

    await save();
    expect(server.writes).toEqual(['v1', 'v2']);
    expect(server.contact).toMatchObject({ notes: 'Met at the conference', company: 'Analytical Engines' });
    expect(page.pathname()).toBe('/book/all');
});

test('a sync moves only the fields nobody touched, offers no way to lose the edits, and a Save over it is refused', async () => {
    const page = await open();
    await type(field('Notes'), 'Met at the conference');
    changeElsewhere({ company: 'Analytical Engines' });
    await sync();
    expect(field('Notes').value).toBe('Met at the conference');
    expect(field('Company').value).toBe('Analytical Engines');
    expect(page.text()).not.toContain('Reload');

    await save();
    expect(server.writes).toEqual(['v1']);
    expect(toasts).toEqual([STALE_TOAST]);
    expect(field('Notes').value).toBe('Met at the conference');
});

test('a clean form follows the card, and its Save answers to what it shows', async () => {
    const page = await open();
    changeElsewhere({ company: 'Analytical Engines' });
    await sync();
    expect(field('Company').value).toBe('Analytical Engines');

    await save();
    expect(server.writes).toEqual(['v2']);
    expect(toasts).toEqual([]);
    expect(page.pathname()).toBe('/book/all');
});

test('typing after a sync answers to that sync, and typing after a refusal to what it reloaded', async () => {
    await open();
    changeElsewhere({ company: 'Analytical Engines' });
    await sync();
    await type(field('Notes'), 'Met at the conference');
    changeElsewhere({ jobTitle: 'Countess' });
    await sync();
    await save();
    expect(server.writes).toEqual(['v2']);
    expect(field('Job title').value).toBe('Countess');

    await type(field('Notes'), 'Met at the conference in Turin');
    changeElsewhere({ jobTitle: 'Mathematician' });
    await sync();
    await save();
    expect(server.writes).toEqual(['v2', 'v3']);
    expect(toasts).toEqual([STALE_TOAST, STALE_TOAST]);
    expect(server.contact.notes).toBe('');
});

test('an email list the user edited stays as typed against a change to that list elsewhere', async () => {
    server.contact = { ...ada, email: ['ada@example.org', 'countess@example.org'] };
    await open();
    await type(rows('Email address')[1] ?? field('Notes'), 'lovelace@example.org');
    changeElsewhere({ email: ['new@example.org', 'ada@example.org', 'countess@example.org'] });
    await sync();
    expect(rows('Email address').map((row) => row.value)).toEqual(['ada@example.org', 'lovelace@example.org']);

    await save();
    await save();
    expect(server.contact.email).toEqual(['ada@example.org', 'lovelace@example.org']);
});

test('a phone list added to stays as typed, while an untouched email list follows', async () => {
    await open();
    await type(rows('Phone number')[0] ?? field('Notes'), '+31 6 1234');
    changeElsewhere({ email: ['new@example.org'] });
    await sync();
    expect(rows('Phone number').map((row) => row.value)).toEqual(['+31 6 1234']);
    expect(rows('Email address').map((row) => row.value)).toEqual(['new@example.org']);
});

test('a photo that arrives with a sync is saved with the rest of a clean form', async () => {
    await open();
    changeElsewhere({ avatar: '/avatars/ada.png' });
    await sync();
    await save();
    expect(server.writes).toEqual(['v2']);
    expect(server.contact.avatar).toBe('/avatars/ada.png');
});

test('a field typed back to what it held follows the card, so its Save overwrites nothing', async () => {
    server.contact = { ...ada, notes: 'a' };
    await open();
    await type(field('Notes'), 'ax');
    changeElsewhere({ notes: 'b' });
    await sync();
    expect(field('Notes').value).toBe('ax');

    await type(field('Notes'), 'a');
    await settle();
    expect(field('Notes').value).toBe('b');

    await save();
    expect(server.writes).toEqual(['v2']);
    expect(server.contact.notes).toBe('b');
});

test('a field typed back follows the card while another stays typed', async () => {
    server.contact = { ...ada, notes: 'a' };
    await open();
    await type(field('Company'), 'Analytical Engines');
    await type(field('Notes'), 'ax');
    changeElsewhere({ notes: 'b' });
    await sync();

    await type(field('Notes'), 'a');
    await settle();
    expect(field('Notes').value).toBe('b');
    expect(field('Company').value).toBe('Analytical Engines');

    await save();
    expect(server.writes).toEqual(['v1']);
    expect(toasts).toEqual([STALE_TOAST]);
});

test('a list typed back to what it held keeps its row, with the cursor in it', async () => {
    await open();
    const row = rows('Email address')[0];
    if (!row) throw new Error('no email row');
    await type(row, 'ada@example.orgx');
    await type(row, 'ada@example.org');
    await settle();
    expect(rows('Email address')[0]).toBe(row);
});
