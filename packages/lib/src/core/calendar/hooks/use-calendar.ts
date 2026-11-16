// The Calendar app's queries and mutations: the owner's calendars and events, the calendars shared with them,
// RSVPs and free/busy. A mutation refetches what it changed through the calendar keys' invalidators, and a
// failure toasts through onMutationError, except that an event write refused for its stale etag reloads the events
// and says so. Helpers such as useCalendarOptions list the owner's own calendars and the shared ones they may write
// to, for a picker.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { parseOwnerId } from '@workspace/lib/types';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarOption,
    CreateEventInput,
    EventData,
    SharedCalendar,
    UpdateCalendarInput,
    UpdateEventInput,
    UpdateSharedCalendarInput,
} from '@workspace/lib/types/calendar';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { AppError, onEtagWriteError, onMutationError } from '../../api-error';
import { usePublicUser, usePublicUsers } from '../../public';
import { formatFreeBusyTitle, isInvitationFromOthers, occurrenceDateToString } from '../calendar-utils';
import {
    calendarKeys,
    invalidateCalendarDeleted,
    invalidateCalendarList,
    invalidateEventList,
    invalidateSharedCalendarUpdated,
} from './keys';

// An event write echoes the etag its dialog holds, and a 412 means the event changed elsewhere first. A dialog may have
// nothing typed, such as a delete's, so the toast promises nothing about typing.
const STALE_WRITE_TOAST = 'This event changed elsewhere. Check it and try again.';

function onEventWriteError(queryClient: QueryClient, ownerId: string) {
    return (error: unknown) =>
        onEtagWriteError(error, STALE_WRITE_TOAST, () => invalidateEventList(queryClient, ownerId));
}

// Eden's reviver makes a UTC-midnight Date of a bare YYYY-MM-DD, for a year of 19xx or 20xx only, and a range read
// needs its timestamps revived. So what the type promises holds only from here on, whichever of the two arrived.
function withOccurrenceDay(event: CalendarEventOccurrence): CalendarEventOccurrence {
    return { ...event, occurrenceDate: occurrenceDateToString(new Date(event.occurrenceDate)) };
}

export function useCalendars(ownerId: string, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.calendarList(ownerId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).calendars.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: enabled && !!ownerId,
    });
}

export function useCreateCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: { name: string; color: string }) => {
            const response = await calendarApi({ ownerId }).calendars.post(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateCalendarList(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useUpdateCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ id, ...data }: UpdateCalendarInput) => {
            const response = await calendarApi({ ownerId }).calendars({ calId: id }).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateCalendarList(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDeleteCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await calendarApi({ ownerId }).calendars({ calId: id }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateCalendarDeleted(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useEvents(ownerId: string, from: number, to: number) {
    return useQuery({
        queryKey: calendarKeys.eventRange(ownerId, from, to),
        queryFn: async (): Promise<CalendarEventOccurrence[]> => {
            const response = await calendarApi({ ownerId })
                ['event-range']({ from: String(from) })({ to: String(to) })
                .get();
            if (response.error) throw new AppError(response);
            return response.data.map(withOccurrenceDay);
        },
        staleTime: STALE_TIME.TWO_MINUTES,
        enabled: !!ownerId && from > 0 && to > 0,
    });
}

// A range read answers occurrences; only the stored row says where the series itself starts.
export function useEvent(ownerId: string, calendarId: string, id: string, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.event(ownerId, calendarId, id),
        queryFn: async (): Promise<CalendarEvent> => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).events({ id }).get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.TWO_MINUTES,
        enabled: enabled && !!ownerId && !!calendarId && !!id,
    });
}

export function useCreateEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ calendarId, ...eventData }: CreateEventInput) => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).events.post(eventData);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventList(queryClient, ownerId),
        onError: onEventWriteError(queryClient, ownerId),
    });
}

export function useUpdateEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ calendarId, id, ...data }: UpdateEventInput) => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).events({ id }).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventList(queryClient, ownerId),
        onError: onEventWriteError(queryClient, ownerId),
    });
}

export function useDeleteEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ calendarId, id, etag }: Pick<UpdateEventInput, 'id' | 'calendarId' | 'etag'>) => {
            const response = await calendarApi({ ownerId })
                .calendars({ calId: calendarId })
                .events({ id })
                .delete({}, { query: { etag } });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventList(queryClient, ownerId),
        onError: onEventWriteError(queryClient, ownerId),
    });
}

export function useMoveEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
            calendarId,
            id,
            targetCalendarId,
            etag,
        }: {
            calendarId: string;
            id: string;
            targetCalendarId: string;
            etag: string;
        }): Promise<CalendarEvent> => {
            const response = await calendarApi({ ownerId })
                .calendars({ calId: calendarId })
                .events({ id })
                .move.put({ targetCalendarId, etag });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventList(queryClient, ownerId),
        onError: onEventWriteError(queryClient, ownerId),
    });
}

// A form that can see it is behind before it writes anything gets the same answer as the server's 412.
export function useRefuseStaleEvent(ownerId: string): () => void {
    const queryClient = useQueryClient();

    return () => {
        invalidateEventList(queryClient, ownerId);
        toast.error(STALE_WRITE_TOAST);
    };
}

// The owner's address tells their own organized events from invitations; a team owner has none to ask for. Until a
// user owner's address arrives every event counts as an invitation, so none is briefly editable.
export function useIsInvitationFromOthers(eventOwnerId: string): (event: { data?: EventData | null }) => boolean {
    const { user } = useAuth();
    const ownerIsViewer = eventOwnerId === user?.id;
    const ownerIsTeam = parseOwnerId(eventOwnerId).type === 'team';
    const owner = usePublicUser(ownerIsViewer || ownerIsTeam ? undefined : eventOwnerId);
    const ownerEmail = ownerIsViewer ? user?.email : owner.data?.email;
    return useCallback(
        (event: { data?: EventData | null }) => owner.isLoading || isInvitationFromOthers(event, ownerEmail),
        [owner.isLoading, ownerEmail],
    );
}

export function useCalendarAccess(ownerId: string, calendarId: string, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.access(ownerId, calendarId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).access.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId && !!calendarId && enabled,
    });
}

export function useAllSharedCalendarEvents(
    sharedCalendars: readonly SharedCalendar[],
    from: number,
    to: number,
): { data: CalendarEventOccurrence[]; isLoading: boolean } {
    const visibleShared = sharedCalendars.filter((sc) => sc.visible);

    const results = useQueries({
        queries: visibleShared.map((sc) => ({
            queryKey: calendarKeys.calendarEvents(sc.ownerUserId, sc.calendarId, from, to),
            queryFn: async (): Promise<CalendarEventOccurrence[]> => {
                const response = await calendarApi({ ownerId: sc.ownerUserId })
                    .calendars({ calId: sc.calendarId })
                    ['event-range']({ from: String(from) })({ to: String(to) })
                    .get();
                if (response.error) throw new AppError(response);
                return response.data.map((item): CalendarEventOccurrence => {
                    if ('etag' in item) return withOccurrenceDay(item);
                    return {
                        id: '',
                        calendarId: sc.calendarId,
                        uid: '',
                        uri: '',
                        title: item.allDay ? 'Busy' : formatFreeBusyTitle(item.endTime),
                        description: null,
                        location: null,
                        startTime: item.startTime,
                        endTime: item.endTime,
                        allDay: item.allDay,
                        rrule: null,
                        timezone: null,
                        parentEventId: null,
                        recurrenceDate: null,
                        status: item.status,
                        sequence: 0,
                        etag: '',
                        data: null,
                        createByUserId: null,
                        createdAt: new Date(0),
                        updatedAt: new Date(0),
                        occurrenceDate: occurrenceDateToString(item.startTime),
                    };
                });
            },
            staleTime: STALE_TIME.TWO_MINUTES,
            enabled: from > 0 && to > 0,
        })),
    });

    const allEvents = results.flatMap((r) => r.data || []);
    const isLoading = results.some((r) => r.isLoading);

    return { data: allEvents, isLoading };
}

export function useSharedCalendars(ownerId: string, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.sharedCalendars(ownerId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).shared.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: enabled && !!ownerId,
    });
}

// A team the viewer is not in still resolves to a name; an unresolved one keeps the calendar's name, never `team_<id>`.
export function useSharedCalendarLabel(sharedCalendars: readonly SharedCalendar[]): (sc: SharedCalendar) => string {
    const teamOwnerIds = useMemo(
        () => [
            ...new Set(
                sharedCalendars
                    .filter((sc) => parseOwnerId(sc.ownerUserId).type === 'team')
                    .map((sc) => sc.ownerUserId),
            ),
        ],
        [sharedCalendars],
    );
    const teams = usePublicUsers(teamOwnerIds);

    return useCallback(
        (sc: SharedCalendar) => {
            if (parseOwnerId(sc.ownerUserId).type === 'team') {
                return teams[sc.ownerUserId]?.name?.trim() || sc.calendarName;
            }
            return sc.calendarName;
        },
        [teams],
    );
}

export function useCalendarOptions(
    ownerId: string,
    calendars: readonly CalendarItem[],
    sharedCalendars: readonly SharedCalendar[],
): CalendarOption[] {
    const label = useSharedCalendarLabel(sharedCalendars);

    return useMemo(() => {
        const options: CalendarOption[] = calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, ownerId }));
        for (const sc of sharedCalendars) {
            if (sc.permission === 'write') {
                options.push({
                    id: sc.calendarId,
                    name: label(sc),
                    color: sc.color || sc.calendarColor,
                    ownerId: sc.ownerUserId,
                });
            }
        }
        return options;
    }, [calendars, sharedCalendars, ownerId, label]);
}

export function useUpdateSharedCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ id, ...data }: UpdateSharedCalendarInput) => {
            const response = await calendarApi({ ownerId }).shared({ id }).put(data);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDeleteSharedCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await calendarApi({ ownerId }).shared({ id }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useRsvp(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            calendarId,
            eventId,
            status,
            scope,
            recurrenceDate,
            remove,
        }: {
            calendarId: string;
            eventId: string;
            status: 'accepted' | 'declined' | 'tentative';
            scope?: 'this' | 'this-and-following' | 'all';
            recurrenceDate?: string;
            remove?: boolean;
        }) => {
            const response = await calendarApi({ ownerId })
                .calendars({ calId: calendarId })
                .events({ id: eventId })
                .rsvp.put({ status, scope, recurrenceDate, remove });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventList(queryClient, ownerId),
        onError: onMutationError,
    });
}
