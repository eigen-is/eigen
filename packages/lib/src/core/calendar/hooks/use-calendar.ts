import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarApi } from '@workspace/lib/api.ts';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    CreateEventInput,
    SharedCalendar,
    UpdateCalendarInput,
    UpdateEventInput,
    UpdateSharedCalendarInput,
} from '@workspace/lib/types/calendar';
import { AppError, onMutationError } from '../../api-error';
import { invalidateHomeSize } from '../../home';

export const calendarKeys = {
    all: ['calendar'] as const,
    owner: (ownerId: string) => [...calendarKeys.all, ownerId] as const,
    calendars: (ownerId: string) => [...calendarKeys.owner(ownerId), 'calendars'] as const,
    calendarList: (ownerId: string) => [...calendarKeys.calendars(ownerId), 'list'] as const,
    events: (ownerId: string) => [...calendarKeys.owner(ownerId), 'events'] as const,
    eventRange: (ownerId: string, from: number, to: number) => [...calendarKeys.events(ownerId), { from, to }] as const,
    calendarEvents: (ownerId: string, calendarId: string, from: number, to: number) =>
        [
            ...calendarKeys.events(ownerId),
            calendarId,
            {
                from,
                to,
            },
        ] as const,
    sharedCalendars: (ownerId: string) => [...calendarKeys.owner(ownerId), 'shared'] as const,
};

// --- Calendar CRUD ---

export function useCalendars(ownerId: string) {
    return useQuery({
        queryKey: calendarKeys.calendarList(ownerId),
        queryFn: async () => {
            const response = await calendarApi({ ownerId }).calendars.get();
            return (response.data || []) as CalendarItem[];
        },
        staleTime: 5 * 60 * 1000,
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
            return (response.data || []) as CalendarEventOccurrence[];
        },
        staleTime: 2 * 60 * 1000,
        enabled: !!ownerId && enabled && from > 0 && to > 0,
    });
}

export function useCalendarEvents(ownerId: string, calendarId: string, from: number, to: number, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.calendarEvents(ownerId, calendarId, from, to),
        queryFn: async (): Promise<CalendarEventOccurrence[]> => {
            const response = await calendarApi({ ownerId })
                .calendars({ calId: calendarId })
                ['event-range']({ from: String(from) })({ to: String(to) })
                .get();
            return (response.data || []) as CalendarEventOccurrence[];
        },
        staleTime: 2 * 60 * 1000,
        enabled: !!ownerId && enabled && !!calendarId && from > 0 && to > 0,
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

export function useCalendarAccess(ownerId: string, calendarId: string, enabled = true) {
    return useQuery({
        queryKey: [...calendarKeys.owner(ownerId), 'access', calendarId],
        queryFn: async (): Promise<{
            ownerUserId: string;
            shares: Array<{ targetId: string; permission: string }>;
        }> => {
            const response = await calendarApi({ ownerId }).calendars({ calId: calendarId }).access.get();
            return response.data as { ownerUserId: string; shares: Array<{ targetId: string; permission: string }> };
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId && !!calendarId && enabled,
    });
}

export function useAllSharedCalendarEvents(sharedCalendars: SharedCalendar[], from: number, to: number) {
    const visibleShared = sharedCalendars.filter((sc) => sc.visible && sc.permission !== 'free-busy');

    const results = useQueries({
        queries: visibleShared.map((sc) => ({
            queryKey: calendarKeys.calendarEvents(sc.ownerUserId, sc.calendarId, from, to),
            queryFn: async (): Promise<CalendarEventOccurrence[]> => {
                const response = await calendarApi({ ownerId: sc.ownerUserId })
                    .calendars({ calId: sc.calendarId })
                    ['event-range']({ from: String(from) })({ to: String(to) })
                    .get();
                return (response.data || []) as CalendarEventOccurrence[];
            },
            staleTime: 2 * 60 * 1000,
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
            return (response.data || []) as SharedCalendar[];
        },
        staleTime: 5 * 60 * 1000,
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

// --- Invalidation functions (ownerId-scoped, used from mutation onSuccess) ---

export function invalidateCalendarCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.calendarList(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateCalendarUpdated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.calendarList(ownerId) });
}

export function invalidateCalendarDeleted(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.calendarList(ownerId) });
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateEventCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
}

export function invalidateEventUpdated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
}

export function invalidateEventDeleted(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
}

export function invalidateSharedCalendarUpdated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.sharedCalendars(ownerId) });
}

export function invalidateCalendarShared(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.sharedCalendars(ownerId) });
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
}

export function invalidateCalendarUnshared(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: calendarKeys.sharedCalendars(ownerId) });
    queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) });
}
