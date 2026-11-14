// The guest list's header: the organizer is a guest, in the count and in the breakdown alike, so the parts add up to
// the whole. Their reply is their own attendee row's, or accepted when the file lists them only as organizer.
import { expect, mock, test } from 'bun:test';
import type { Attendee } from '@workspace/lib/types/calendar';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));

const { createElement } = await import('react');
const { AttendeeList } = await import('../../../components/calendar/attendee-list');

const organizer = { email: 'olga@example.com', name: 'Olga' };

function guest(email: string, status: Attendee['status']): Attendee {
    return { email, status, role: 'required' };
}

async function render(attendees: Attendee[]): Promise<string> {
    const { container, unmount } = await renderInDocument(createElement(AttendeeList, { attendees, organizer }));
    const text = container.textContent ?? '';
    await unmount();
    return text;
}

test('the organizer counts as an accepted guest', async () => {
    const text = await render([
        guest('ada@example.com', 'accepted'),
        guest('bob@example.com', 'pending'),
        guest('cy@example.com', 'pending'),
    ]);

    expect(text).toContain('4 guests');
    expect(text).toContain('2 accepted, 2 pending');
});

test('an organizer the file also lists as a guest counts once', async () => {
    const text = await render([guest('OLGA@example.com', 'accepted'), guest('bob@example.com', 'declined')]);

    expect(text).toContain('2 guests');
    expect(text).toContain('1 accepted, 1 declined');
});

test('an organizer the file lists as declined counts as declined', async () => {
    const text = await render([guest('olga@example.com', 'declined'), guest('bob@example.com', 'accepted')]);

    expect(text).toContain('2 guests');
    expect(text).toContain('1 accepted, 1 declined');
});
