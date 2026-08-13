import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CreateEventInput,
    FreeBusyBlock,
    SharedCalendar,
    UpdateCalendarInput,
    UpdateEventInput,
    UpdateSharedCalendarInput,
} from '@workspace/lib/types/calendar';
import { AppError, onMutationError } from '../../api-error';
import { formatFreeBusyTitle, occurrenceDateToString } from '../calendar-utils';
import {
    calendarKeys,
    invalidateCalendarCreated,
    invalidateCalendarDeleted,
    invalidateCalendarUpdated,
    invalidateEventCreated,
    invalidateEventDeleted,
    invalidateEventUpdated,
    invalidateSharedCalendarUpdated,
} from './keys';

// --- Calendar CRUD ---

export function useCalendars(ownerId: string) {
    return useQuery({
        queryKey: calendarKeys.calendarList(ownerId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).calendars.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId,
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
        onSuccess: () => invalidateCalendarCreated(queryClient, ownerId),
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
        onSuccess: () => invalidateCalendarUpdated(queryClient, ownerId),
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

// --- Event CRUD ---

export function useEvents(ownerId: string, from: number, to: number, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.eventRange(ownerId, from, to),
        queryFn: async (): Promise<CalendarEventOccurrence[]> => {
            const response = await calendarApi({ ownerId })
                ['event-range']({ from: String(from) })({ to: String(to) })
                .get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.TWO_MINUTES,
        enabled: !!ownerId && enabled && from > 0 && to > 0,
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
        onSuccess: () => invalidateEventCreated(queryClient, ownerId),
        onError: onMutationError,
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
        onSuccess: () => invalidateEventUpdated(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useDeleteEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ calendarId, id }: Pick<UpdateEventInput, 'id' | 'calendarId'>) => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).events({ id }).delete();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventDeleted(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useMoveEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
            calendarId,
            id,
            targetCalendarId,
        }: {
            calendarId: string;
            id: string;
            targetCalendarId: string;
        }): Promise<CalendarEvent> => {
            const response = await calendarApi({ ownerId })
                .calendars({ calId: calendarId })
                .events({ id })
                .move.put({ targetCalendarId });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient, ownerId),
        onError: onMutationError,
    });
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

export function useAllSharedCalendarEvents(sharedCalendars: SharedCalendar[], from: number, to: number) {
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
                const data = response.data;
                if (sc.permission === 'free-busy') {
                    return (data as FreeBusyBlock[]).map(
                        (block): CalendarEventOccurrence => ({
                            id: '',
                            calendarId: sc.calendarId,
                            uid: '',
                            uri: '',
                            title: block.allDay ? 'Busy' : formatFreeBusyTitle(block.endTime),
                            description: null,
                            location: null,
                            startTime: block.startTime,
                            endTime: block.endTime,
                            allDay: block.allDay,
                            rrule: null,
                            timezone: null,
                            parentEventId: null,
                            recurrenceDate: null,
                            status: block.status,
                            sequence: 0,
                            etag: '',
                            data: null,
                            createByUserId: null,
                            createdAt: new Date(0),
                            updatedAt: new Date(0),
                            occurrenceDate: occurrenceDateToString(block.startTime),
                        }),
                    );
                }
                return data as CalendarEventOccurrence[];
            },
            staleTime: STALE_TIME.TWO_MINUTES,
            enabled: from > 0 && to > 0,
        })),
    });

    const allEvents = results.flatMap((r) => r.data || []);
    const isLoading = results.some((r) => r.isLoading);

    return { data: allEvents, isLoading };
}

// --- Shared calendars ---

export function useSharedCalendars(ownerId: string) {
    return useQuery({
        queryKey: calendarKeys.sharedCalendars(ownerId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).shared.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId,
    });
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

// --- RSVP ---

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
        onSuccess: () => invalidateEventUpdated(queryClient, ownerId),
        onError: onMutationError,
    });
}
