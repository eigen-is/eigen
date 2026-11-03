// A guest's Remove button shows to a mouse user on the row's hover only, and Tab reaches it and shows it.
import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { HOVER_REVEALED, revealStates } from '@workspace/ui/test/keyboard-reach';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
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

const { createElement } = await import('react');
const { AttendeeEditor } = await import('../../components/attendee-editor');

test("a guest's Remove button shows on the row's hover only, and Tab reaches and shows it", async () => {
    const attendees = [{ email: 'ada@example.org', status: 'pending' as const, role: 'required' as const }];
    await renderInDocument(createElement(AttendeeEditor, { attendees, onChange: () => {} }));
    const remove = document.querySelector('button[aria-label="Remove ada@example.org"]');
    if (!remove) throw new Error('the guest has no Remove button');
    expect(revealStates(remove)).toEqual(HOVER_REVEALED);
});
