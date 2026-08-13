import type { QueryClient } from '@tanstack/react-query';
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
    access: (ownerId: string, calendarId: string) => [...calendarKeys.owner(ownerId), 'access', calendarId] as const,
};

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
