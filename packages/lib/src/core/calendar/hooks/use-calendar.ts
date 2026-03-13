import {type QueryClient, useMutation, useQuery, useQueries, useQueryClient} from '@tanstack/react-query';
import {calendarApi} from '@workspace/lib/api.ts';
import type {CalendarItem, CalendarEventOccurrence, SharedCalendar, CreateEventInput, UpdateEventInput, UpdateCalendarInput, UpdateSharedCalendarInput} from '@workspace/lib/types/calendar';
import {invalidateHomeSize} from '../../home';
import {useAuth} from '@workspace/lib/auth';

export const calendarKeys = {
    all: ['calendar'] as const,
    calendars: () => [...calendarKeys.all, 'calendars'] as const,
    calendarList: () => [...calendarKeys.calendars(), 'list'] as const,
    events: () => [...calendarKeys.all, 'events'] as const,
    eventRange: (from: number, to: number) => [...calendarKeys.events(), {from, to}] as const,
    calendarEvents: (calendarId: string, from: number, to: number) => [...calendarKeys.events(), calendarId, {from, to}] as const,
    sharedCalendars: () => [...calendarKeys.all, 'shared'] as const,
    sharedEvents: (ownerUserId: string, calendarId: string, from: number, to: number) => [...calendarKeys.events(), 'shared', ownerUserId, calendarId, {from, to}] as const,
};

// --- Calendar CRUD ---

export function useCalendars() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

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

export function useCreateCalendar() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (data: {name: string; color: string}) => {
            const response = await calendarApi({ownerId}).calendars.post(data);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateCalendarCreated(queryClient),
    });
}

export function useUpdateCalendar() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({id, ...data}: UpdateCalendarInput) => {
            const response = await (calendarApi({ownerId}).calendars as any)({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateCalendarUpdated(queryClient),
    });
}

export function useDeleteCalendar() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

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

export function useEvents(from: number, to: number, enabled = true) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

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

export function useSharedCalendarEvents(ownerUserId: string, calendarId: string, from: number, to: number, enabled = true) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: calendarKeys.sharedEvents(ownerUserId, calendarId, from, to),
        queryFn: async () => {
            const response = await (calendarApi({ownerId: ownerUserId}).calendars as any)({calId: calendarId}).events({from: String(from)})({to: String(to)}).get();
            return (response.data || []) as CalendarEventOccurrence[];
        },
        staleTime: 2 * 60 * 1000,
        enabled: !!ownerId && enabled && !!ownerUserId && !!calendarId && from > 0 && to > 0,
    });
}

export function useCreateEvent() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const defaultOwnerId = user?.id || '';

    return useMutation({
        mutationFn: async ({calendarId, ownerId, ...eventData}: CreateEventInput) => {
            const targetOwnerId = ownerId || defaultOwnerId;
            const response = await (calendarApi({ownerId: targetOwnerId}).calendars as any)({calId: calendarId}).events.post(eventData as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventCreated(queryClient),
    });
}

export function useUpdateEvent() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({id, ...data}: UpdateEventInput) => {
            const response = await (calendarApi({ownerId}).events as any)({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventUpdated(queryClient),
    });
}

export function useDeleteEvent() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await (calendarApi({ownerId}).events as any)({id}).delete();
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateEventDeleted(queryClient),
    });
}

export function useCalendarAccess(ownerUserId: string, calendarId: string, enabled = true) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: [...calendarKeys.all, 'access', ownerUserId, calendarId],
        queryFn: async () => {
            const response = await (calendarApi({ownerId: ownerUserId}).calendars as any)({calId: calendarId}).access.get();
            return response.data as {ownerUserId: string; shares: Array<{targetId: string; permission: string}>};
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!ownerId && !!ownerUserId && !!calendarId && enabled,
    });
}

export function useAllSharedCalendarEvents(sharedCalendars: SharedCalendar[], from: number, to: number) {
    const {user} = useAuth();
    const ownerId = user?.id || '';

    const visibleShared = sharedCalendars.filter(sc => sc.visible && sc.permission !== 'free-busy');

    const results = useQueries({
        queries: visibleShared.map(sc => ({
            queryKey: calendarKeys.sharedEvents(sc.ownerUserId, sc.calendarId, from, to),
            queryFn: async () => {
                const response = await (calendarApi({ownerId: sc.ownerUserId}).calendars as any)({calId: sc.calendarId}).events({from: String(from)})({to: String(to)}).get();
                return (response.data || []) as CalendarEventOccurrence[];
            },
            staleTime: 2 * 60 * 1000,
            enabled: !!ownerId && from > 0 && to > 0,
        })),
    });

    const allEvents = results.flatMap(r => r.data || []);
    const isLoading = results.some(r => r.isLoading);

    return {data: allEvents, isLoading};
}

// --- Shared calendars ---

export function useSharedCalendars() {
    const {user} = useAuth();
    const ownerId = user?.id || '';

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

export function useUpdateSharedCalendar() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({id, ...data}: UpdateSharedCalendarInput) => {
            const response = await calendarApi({ownerId}).shared({id}).put(data as any);
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient),
    });
}

export function useDeleteSharedCalendar() {
    const queryClient = useQueryClient();
    const {user} = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (id: string) => {
            const response = await calendarApi({ownerId}).shared({id}).delete();
            if (response.error) throw new Error(String(response.error));
            return response.data;
        },
        onSuccess: () => invalidateSharedCalendarUpdated(queryClient),
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
