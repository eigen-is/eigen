import { describe, expect, test } from 'bun:test';
import { isClickableNotification, resolveNotificationLink } from '../../../core/notification/resolve-link';
import { calendarInviteTag } from '../../../core/notification/tags';

describe('isClickableNotification', () => {
    test('a share opens what was shared', () => {
        expect(isClickableNotification('calendar-share')).toBe(true);
    });

    test('an unshare has nothing to open', () => {
        expect(isClickableNotification('calendar-unshare')).toBe(false);
    });
});

describe('resolveNotificationLink', () => {
    test("an invitation opens Calendar on the event's local day, with the event", async () => {
        const tag = calendarInviteTag('organizer-event-1', new Date(2026, 10, 20, 14));
        expect(await resolveNotificationLink({ type: 'calendar-invite', tag, details: null })).toBe(
            '/?date=2026-11-20&eventId=organizer-event-1',
        );
    });
});
