// A guest's Remove button shows to a mouse user on the row's hover only, and Tab reaches it and shows it. A guest added
// by address takes their name from the user's contacts, and an address nobody knows is stored with no name at all.
import { afterAll, expect, mock, test } from 'bun:test';
import type { Attendee } from '@workspace/lib/types/calendar';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { expectKeyboardReveal } from '@workspace/ui/test/hover-reveal';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
const grace: Contact = {
    id: 'grace',
    etag: '',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: ['Grace@example.com'],
    phone: [],
};
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContacts: () => ({ data: [grace] }),
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
// A guest row names the guest by address, without looking up who it is.
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email }: { email?: string }) => ({
        displayName: email ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
afterAll(() => {
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const { AttendeeEditor } = await import('../../components/attendee-editor');

test("a guest's Remove button shows on the row's hover only, and Tab reaches and shows it", async () => {
    const attendees = [{ email: 'ada@example.org', status: 'pending' as const, role: 'required' as const }];
    await renderInDocument(createElement(AttendeeEditor, { attendees, onChange: () => {} }));
    const remove = document.querySelector('button[aria-label="Remove ada@example.org"]');
    if (!remove) throw new Error('the guest has no Remove button');
    expectKeyboardReveal(remove);
});

// Types an address into the guest field and presses its + button, and answers the guest list the editor hands back.
async function addGuest(typed: string): Promise<Attendee[]> {
    let added: Attendee[] = [];
    await renderInDocument(
        createElement(AttendeeEditor, {
            attendees: [],
            onChange: (attendees) => {
                added = attendees;
            },
        }),
    );
    const input = document.querySelector<HTMLInputElement>('#attendee-input');
    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
    if (!input || !add) throw new Error('the editor drew no guest field');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => add.click());
    return added;
}

test('a typed address nobody knows is stored with no name, so the guest reads as the address', async () => {
    expect(await addGuest('erin.west@example.com')).toEqual([
        { email: 'erin.west@example.com', name: undefined, status: 'pending', role: 'required' },
    ]);
});

test("a typed address of one of the user's contacts is stored with the contact's name", async () => {
    expect(await addGuest('grace@example.com')).toEqual([
        { email: 'grace@example.com', name: 'Grace Hopper', status: 'pending', role: 'required' },
    ]);
});

test('a name typed beside the address is the one stored', async () => {
    expect(await addGuest('Amazing Grace <grace@example.com>')).toEqual([
        { email: 'grace@example.com', name: 'Amazing Grace', status: 'pending', role: 'required' },
    ]);
});
