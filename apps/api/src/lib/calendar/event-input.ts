// The rules a new event or occurrence must meet before the store writes it, and the row its file is built from. The
// event writes check and shape a create or an override here, and the invitation receiver shapes a filed copy the same
// way, so each new VEVENT starts from one row shape.

import { normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
import { RRule } from 'rrule';
import { ApiError } from '../core';
import type { EventToBuild } from '../ical/ical-component';
import { clampStamp } from '../ical/ical-component';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../ical/recurrence-limits';
import type { CreateEventArgs } from './types';

// What a create refuses before it writes anything, so a refused event leaves the collection untouched.
export function validateEventInput(input: { rrule?: string | null; startTime: Date; endTime: Date }): void {
    const rruleStr = input.rrule ?? null;
    if (rruleStr) {
        try {
            RRule.parseString(rruleStr);
        } catch {
            throw new ApiError(400, 'Invalid RRULE');
        }
        // Sub-daily recurrence is never a real event and lets one range query block the event loop.
        if (isSubDailyRrule(rruleStr)) throw new ApiError(400, 'Sub-daily recurrence is not supported');
        // Same DoS class: an out-of-range recurring dtstart makes rrule iterate dtstart→window.
        if (isOutOfRangeRecurrenceStart(input.startTime)) {
            throw new ApiError(400, 'Recurring event start time is out of range');
        }
    }
    // Zero length stays legal: RFC 5545 §3.6.1 lets DTEND equal DTSTART.
    if (input.endTime < input.startTime) throw new ApiError(400, 'Event end time cannot be before start time');
}

// The shape of a row about to be written; the VCALENDAR buildResource makes of it is what the projection re-derives.
export function eventForResource(args: {
    id: string;
    calendarId: string;
    uid: string;
    input: CreateEventArgs;
    now: Date;
}): EventToBuild {
    const { id, calendarId, uid, input, now } = args;
    return {
        id,
        calendarId,
        uid,
        uri: '',
        title: input.title.trim(),
        description: input.description ?? null,
        location: input.location ?? null,
        startTime: input.startTime,
        endTime: input.endTime,
        allDay: input.allDay,
        rrule: input.rrule ?? null,
        timezone: normalizeTimezone(input.timezone),
        parentEventId: input.parentEventId ?? null,
        recurrenceDate: input.recurrenceDate ?? null,
        recurrenceId: input.recurrenceId,
        status: input.status ?? 'confirmed',
        sequence: input.sequence ?? 0,
        etag: '',
        data: input.data ?? null,
        createByUserId: input.createByUserId ?? null,
        createdAt: now,
        // A receiver states the organizer's stamp, so the stored DTSTAMP is the revision the next message beats.
        updatedAt: clampStamp(input.dtstamp, now) ?? now,
    };
}
