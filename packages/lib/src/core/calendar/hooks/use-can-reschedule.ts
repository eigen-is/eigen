// Whether a drag may move an event in the calendar views: only where its save goes through as the organizer's. A
// calendar the viewer sees as free/busy or can only read, and somebody else's invitation, stay put and only open on a
// click. A view asks once for every owner it shows, so a shared calendar's owner is looked up by address, and until that
// address arrives their events stay put, as the dialogs keep an invitation's details locked meanwhile.

import { useAuth } from '@workspace/lib/auth';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useCallback, useMemo } from 'react';
import { usePublicUsers } from '../../public';
import { isInvitationOnCalendar, ownerAddressToLookUp, writableShares } from '../calendar-utils';

export function useCanReschedule(
    calendars: readonly CalendarItem[],
    sharedCalendars: readonly SharedCalendar[],
): (event: CalendarEventOccurrence) => boolean {
    const { user } = useAuth();
    const writable = useMemo(() => writableShares(sharedCalendars), [sharedCalendars]);
    const lookUps = useMemo(
        () => [...new Set(writable.flatMap((sc) => ownerAddressToLookUp(sc.ownerUserId, user?.id) ?? []))],
        [writable, user?.id],
    );
    const owners = usePublicUsers(lookUps);

    return useCallback(
        (event: CalendarEventOccurrence) => {
            if (!user) return false;
            const ownerId = calendars.some((c) => c.id === event.calendarId)
                ? user.id
                : writable.find((sc) => sc.calendarId === event.calendarId)?.ownerUserId;
            return !!ownerId && !isInvitationOnCalendar(event, ownerId, user, owners[ownerId]?.email);
        },
        [calendars, writable, owners, user],
    );
}
