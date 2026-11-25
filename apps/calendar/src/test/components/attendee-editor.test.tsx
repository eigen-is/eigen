// A guest's Remove button shows to a mouse user on the row's hover only, and Tab reaches it and shows it. A guest added
// by address, in the field a screen reader names Guests, takes their name from the user's contacts, and an address
// nobody knows is stored with no name at all. Inviting yourself, or a guest already on the list, is refused under the
// field, with no toast.
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import type { Attendee } from '@workspace/lib/types/calendar';
import type { Contact } from '@workspace/lib/types/contact';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { expectKeyboardReveal } from '@workspace/ui/test/hover-reveal';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { toast } from 'sonner';

installHappyDom();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
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
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'Me@example.com' } }) }));
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
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/public', () => realPublic);
});

const toastInfo = spyOn(toast, 'info');
afterAll(() => toastInfo.mockRestore());

const { act, createElement } = await import('react');
const { AttendeeEditor, useGuestInput } = await import('../../components/attendee-editor');

// The editor with the field its dialog owns, as New event and Edit event hold it.
function Editor({ attendees, onChange }: { attendees: Attendee[]; onChange: (attendees: Attendee[]) => void }) {
    const input = useGuestInput({ attendees, onChange });
    return createElement(AttendeeEditor, { attendees, onChange, input });
}

test("a guest's Remove button shows on the row's hover only, and Tab reaches and shows it", async () => {
    const attendees = [{ email: 'ada@example.org', status: 'pending' as const, role: 'required' as const }];
    await renderInDocument(createElement(Editor, { attendees, onChange: () => {} }));
    const remove = document.querySelector('button[aria-label="Remove ada@example.org"]');
    if (!remove) throw new Error('the guest has no Remove button');
    expectKeyboardReveal(remove);
});

// Types an address into the field labelled Guests and presses its + button, and answers the guest list the editor hands back.
async function addGuest(typed: string, attendees: Attendee[] = []): Promise<Attendee[]> {
    let added: Attendee[] = [];
    await renderInDocument(
        createElement(Editor, {
            attendees,
            onChange: (attendees) => {
                added = attendees;
            },
        }),
    );
    const label = [...document.querySelectorAll('label')].find((each) => each.textContent === 'Guests');
    const input = document.querySelector<HTMLInputElement>(`input#${label?.htmlFor}`);
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

test('inviting yourself adds no guest, keeps the address and says why under the field, with no toast', async () => {
    expect(await addGuest('me@example.com')).toEqual([]);
    const input = document.querySelector<HTMLInputElement>('input#attendee-input');
    const message = document.querySelector('[data-slot="field-error"]');
    expect(input?.value).toBe('me@example.com');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(message?.textContent).toBe('You cannot invite yourself');
    expect(toastInfo).not.toHaveBeenCalled();
});

test('a guest already on the list is refused under the field, and the list stays as it was', async () => {
    const ada: Attendee = { email: 'ada@example.org', status: 'pending', role: 'required' };
    expect(await addGuest('Ada@example.org', [ada])).toEqual([]);
    const message = document.querySelector('[data-slot="field-error"]');
    expect(message?.textContent).toBe('ada@example.org is already in the list');
});
