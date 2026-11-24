// Saves one occurrence of an event at a recurrence scope: this one becomes an override in the master, this and the
// following ones split the series in two, and all of them change the master, read from the cache or else the server.
// Its host is bound to the event's owner, such as Edit event, and holds the etag every write that sends one answers
// to. A refused write reloads the events and says so, through the event writes' own error path.

import { useQueryClient } from '@tanstack/react-query';
import type { CalendarEvent, SaveOccurrenceInput } from '@workspace/lib/types/calendar';
import { onMutationError } from '../../api-error';
import type { HeldEtag } from '../../use-held-etag';
import { isSeriesOccurrence, seriesEditFromOccurrence, truncateRRule } from '../calendar-utils';
import { eventQueryConfig, useCreateEvent, useUpdateEvent } from './use-calendar';

export function useSaveOccurrence(
    ownerId: string,
    { heldEtag, holdEtag }: HeldEtag,
): (save: SaveOccurrenceInput) => Promise<CalendarEvent> {
    const queryClient = useQueryClient();
    const createEvent = useCreateEvent(ownerId);
    const updateEvent = useUpdateEvent(ownerId);

    return async ({ occurrence, scope, edited, seriesData }) => {
        const { calendarId, occurrenceDate } = occurrence;
        const id = occurrence.parentEventId || occurrence.id;
        const { title, description, location, allDay, startTime, endTime, rrule, timezone, data } = edited;
        const fields = { title, description, location, allDay, startTime, endTime, timezone, data };

        if (scope === 'this') {
            return createEvent.mutateAsync({
                calendarId,
                ...fields,
                rrule: null,
                parentEventId: id,
                recurrenceDate: occurrenceDate,
                etag: heldEtag,
            });
        }
        if (scope === 'this-and-following') {
            if (occurrence.rrule) {
                const truncated = await updateEvent.mutateAsync({
                    id,
                    calendarId,
                    etag: heldEtag,
                    rrule: truncateRRule(occurrence.rrule, occurrenceDate, occurrence),
                });
                // The truncation takes the occurrence out of the list, so a retry has only this etag to answer to.
                holdEtag(truncated.etag);
            }
            return createEvent.mutateAsync({ calendarId, ...fields, rrule });
        }
        if (!isSeriesOccurrence(occurrence)) {
            return updateEvent.mutateAsync({ id, calendarId, etag: heldEtag, ...fields, rrule });
        }
        const master = await queryClient
            .ensureQueryData(eventQueryConfig(ownerId, calendarId, id))
            .catch((error: unknown) => {
                onMutationError(error);
                throw error;
            });
        // The master takes only what changed: the occurrence's own times would restart the series there. An override
        // carries no rule of its own, and sending its empty one would end the series.
        return updateEvent.mutateAsync({
            id,
            calendarId,
            etag: heldEtag,
            rrule: occurrence.parentEventId ? undefined : rrule,
            timezone,
            ...(seriesData && { data: seriesData }),
            ...seriesEditFromOccurrence(occurrence, master, edited),
        });
    };
}
