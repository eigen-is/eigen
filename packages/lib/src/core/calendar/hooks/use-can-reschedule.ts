// Whether a drag may move an event in the calendar views: only where its save goes through as the organizer's. A
// calendar the viewer sees as free/busy or can only read, and somebody else's invitation, stay put and only open on a
// click. A view asks once for every owner it shows, so a shared calendar's owner is looked up by address, and until that
// address arrives their events stay put, as the dialogs keep an invitation's details locked meanwhile.

import { useAuth } from '@workspace/lib/auth';
import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useCallback, useMemo } from 'react';
import { usePublicUsers } from '../../public';
import { isInvitationFromOthers } from '../calendar-utils';

export function useCanReschedule(
    calendars: readonly CalendarItem[],
    sharedCalendars: readonly SharedCalendar[] = [],
): (event: CalendarEventOccurrence) => boolean {
    const { user } = useAuth();
    const writable = useMemo(() => sharedCalendars.filter((sc) => sc.permission === 'write'), [sharedCalendars]);
    // A team Home has no address, so its events are judged by Eigen's organizer stamp instead.
    const userOwners = useMemo(
        () => [
            ...new Set(
                writable.filter((sc) => parseOwnerId(sc.ownerUserId).type !== 'team').map((sc) => sc.ownerUserId),
            ),
        ],
        [writable],
    );
    const owners = usePublicUsers(userOwners);

    return useCallback(
        (event: CalendarEventOccurrence) => {
            if (!user) return false;
            if (calendars.some((c) => c.id === event.calendarId)) return !isInvitationFromOthers(event, user.email);
            const sc = writable.find((s) => s.calendarId === event.calendarId);
            if (!sc) return false;
            if (parseOwnerId(sc.ownerUserId).type === 'team') return !isInvitationFromOthers(event);
            const ownerEmail = owners[sc.ownerUserId]?.email;
            return !!ownerEmail && !isInvitationFromOthers(event, ownerEmail);
        },
        [calendars, writable, owners, user],
    );
}
