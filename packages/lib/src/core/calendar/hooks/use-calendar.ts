import {type QueryClient, useMutation, useQueries, useQuery, useQueryClient} from '@tanstack/react-query';
import {calendarApi} from '@workspace/lib/api.ts';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    CreateEventInput,
    SharedCalendar,
    UpdateCalendarInput,
    UpdateEventInput,
    UpdateSharedCalendarInput
} from '@workspace/lib/types/calendar';
import {invalidateHomeSize} from '../../home';

export const calendarKeys = {
    all: ['calendar'] as const,
    calendars: () => [...calendarKeys.all, 'calendars'] as const,
    calendarList: () => [...calendarKeys.calendars(), 'list'] as const,
    events: () => [...calendarKeys.all, 'events'] as const,
    eventRange: (from: number, to: number) => [...calendarKeys.events(), {from, to}] as const,
    calendarEvents: (ownerId: string, calendarId: string, from: number, to: number) => [...calendarKeys.events(), ownerId, calendarId, {from, to}] as const,
    sharedCalendars: () => [...calendarKeys.all, 'shared'] as const,
};

// --- Calendar CRUD ---

export function useCalendars(ownerId: string) {
    return useQuery({
        queryKey: calendarKeys.calendarList(),
        queryFn: async () => {
            const response = await calendarApi({ownerId}).calendars.get();
            return (response.data || []) as CalendarItem[];
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId,
    });
}

export function useCreateCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (data: {name: string; color: string}) => {
            const response = await calendarApi({ownerId}).calendars.post(data);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateCalendarCreated(queryClient),
    });
}

export function useUpdateCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({id, ...data}: UpdateCalendarInput) => {
            const response = await (calendarApi({ownerId}).calendars as any)({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateCalendarUpdated(queryClient),
    });
}

export function useDeleteCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await (calendarApi({ownerId}).calendars as any)({id}).delete();
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateCalendarDeleted(queryClient),
    });
}

// --- Event CRUD ---

export function useEvents(ownerId: string, from: number, to: number, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.eventRange(from, to),
        queryFn: async () => {
            const response = await (calendarApi({ownerId}).events as any)({from: String(from)})({to: String(to)}).get();
            return (response.data || []) as CalendarEventOccurrence[];
        },
        staleTime: 2 * 60 * 1000,
        enabled: !!ownerId && enabled && from > 0 && to > 0,
    });
}

export function useCalendarEvents(ownerId: string, calendarId: string, from: number, to: number, enabled = true) {
    return useQuery({
        queryKey: calendarKeys.calendarEvents(ownerId, calendarId, from, to),
        queryFn: async () => {
            const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events({from: String(from)})({to: String(to)}).get();
            return (response.data || []) as CalendarEventOccurrence[];
        },
        staleTime: 2 * 60 * 1000,
        enabled: !!ownerId && enabled && !!calendarId && from > 0 && to > 0,
    });
}

export function useCreateEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({calendarId, ...eventData}: CreateEventInput) => {
            const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events.post(eventData as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventCreated(queryClient),
    });
}

export function useUpdateEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({calendarId, id, ...data}: UpdateEventInput) => {
            const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient),
    });
}

export function useDeleteEvent(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({calendarId, id}: Pick<UpdateEventInput, 'id' | 'calendarId'>) => {
            const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).events({id}).delete();
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventDeleted(queryClient),
    });
}

export function useCalendarAccess(ownerId: string, calendarId: string, enabled = true) {
    return useQuery({
        queryKey: [...calendarKeys.all, 'access', ownerId, calendarId],
        queryFn: async () => {
            const response = await (calendarApi({ownerId}).calendars as any)({calId: calendarId}).access.get();
            return response.data as {ownerUserId: string; shares: Array<{targetId: string; permission: string}>};
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId && !!calendarId && enabled,
    });
}

export function useAllSharedCalendarEvents(sharedCalendars: SharedCalendar[], from: number, to: number) {
    const visibleShared = sharedCalendars.filter(sc => sc.visible && sc.permission !== 'free-busy');

    const results = useQueries({
        queries: visibleShared.map(sc => ({
            queryKey: calendarKeys.calendarEvents(sc.ownerUserId, sc.calendarId, from, to),
            queryFn: async () => {
                const response = await (calendarApi({ownerId: sc.ownerUserId}).calendars as any)({calId: sc.calendarId}).events({from: String(from)})({to: String(to)}).get();
                return (response.data || []) as CalendarEventOccurrence[];
            },
            staleTime: 2 * 60 * 1000,
            enabled: from > 0 && to > 0,
        })),
    });

    const allEvents = results.flatMap(r => r.data || []);
    const isLoading = results.some(r => r.isLoading);

    return {data: allEvents, isLoading};
}

// --- Shared calendars ---

export function useSharedCalendars(ownerId: string) {
    return useQuery({
        queryKey: calendarKeys.sharedCalendars(),
        queryFn: async () => {
            const response = await calendarApi({ownerId}).shared.get();
            return (response.data || []) as SharedCalendar[];
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId,
    });
}

export function useUpdateSharedCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({id, ...data}: UpdateSharedCalendarInput) => {
            const response = await calendarApi({ownerId}).shared({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient),
    });
}

export function useDeleteSharedCalendar(ownerId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await calendarApi({ownerId}).shared({id}).delete();
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient),
    });
}

// --- RSVP ---

export function useRsvp(ownerId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({calendarId, eventId, status, scope, recurrenceDate, remove}: {
            calendarId: string; eventId: string;
            status: 'accepted' | 'declined' | 'tentative';
            scope?: 'this' | 'this-and-following' | 'all';
            recurrenceDate?: string;
            remove?: boolean;
        }) => {
            const response = await (calendarApi({ownerId}).calendars as any)
                ({calId: calendarId}).events({id: eventId}).rsvp.put({status, scope, recurrenceDate, remove});
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient),
    });
}

// --- SSE invalidation functions ---

export function invalidateCalendarCreated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.calendarList()});
    invalidateHomeSize(queryClient);
}

export function invalidateCalendarUpdated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.calendarList()});
}

export function invalidateCalendarDeleted(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.calendarList()});
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
    invalidateHomeSize(queryClient);
}

export function invalidateEventCreated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
}

export function invalidateEventUpdated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
}

export function invalidateEventDeleted(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
}

export function invalidateSharedCalendarUpdated(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.sharedCalendars()});
}

export function invalidateCalendarShared(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.sharedCalendars()});
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
}

export function invalidateCalendarUnshared(queryClient: QueryClient): void {
    queryClient.invalidateQueries({queryKey: calendarKeys.sharedCalendars()});
    queryClient.invalidateQueries({queryKey: calendarKeys.events()});
}
