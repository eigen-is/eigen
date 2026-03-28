import type { SSEvent, SSEventType } from '@workspace/lib/types/sse';

type CalendarEventType = (typeof SSEventType)[keyof typeof SSEventType] & `calendar:${string}`;

export function buildCalendarEvent(type: CalendarEventType, ownerId: string): SSEvent {
    return { type, ownerId } as SSEvent;
}
