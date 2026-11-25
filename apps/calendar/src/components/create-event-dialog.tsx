// The New event dialog, opened from the toolbar, a click on a day or a slot, or a drag over a range of the time grid.
// It starts at the times the view gives, or else at the next quarter hour, on the clicked day when there is one, for
// a new event's length, in the default calendar, and saves through useCreateEvent. It shows no form until the
// calendars have loaded, so the event always has a calendar to go to.

import { useAuth } from '@workspace/lib/auth';
import {
    defaultCalendar,
    toLocalDateString,
    useCalendarOptions,
    useCalendars,
    useCreateEvent,
    useSharedCalendars,
    viewerTimeZone,
} from '@workspace/lib/calendar';
import { NEW_EVENT_MINUTES } from '@workspace/lib/constants/calendar';
import type { Attendee } from '@workspace/lib/types/calendar';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { UsersRound } from 'lucide-react';
import { useState } from 'react';
import { AttendeeEditor, useGuestInput } from './attendee-editor';
import { buildEventTimes, calendarKey } from './calendar-utils';
import type { EventFieldTimes } from './event-form-fields';
import { EventFormFields, timesDiffer } from './event-form-fields';
import { roundToNext15Minutes, toTimeString } from './time-select';

// The form's start and end fields: an all-day event's end is its last day, as the end date field shows it.
export type NewEventTimes = { start: Date; end: Date; allDay: boolean };

type CreateEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultDate?: Date;
    initial?: NewEventTimes;
};

export function CreateEventDialog({ open, onOpenChange, defaultDate, initial }: CreateEventDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="New event">
            <CreateEventForm defaultDate={defaultDate} initial={initial} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts empty at its own times.
function CreateEventForm({ defaultDate, initial }: Omit<CreateEventDialogProps, 'open' | 'onOpenChange'>) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const { data: calendars } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);
    const calendarOptions = useCalendarOptions(ownerId, calendars ?? [], sharedCalendars);

    const [seed] = useState((): EventFieldTimes => {
        const { start, end, allDay } = initial ?? nextSlot(defaultDate);
        return {
            allDay,
            rrule: null,
            startDate: toLocalDateString(start),
            startTime: toTimeString(start),
            endDate: toLocalDateString(end),
            endTime: toTimeString(end),
        };
    });
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [pickedCalKey, setPickedCalKey] = useState<string>();
    const [times, setTimes] = useState(seed);
    const [attendees, setAttendees] = useState<Attendee[]>([]);
    const guestInput = useGuestInput({ attendees, onChange: setAttendees, currentUserEmail: user?.email });
    // One user action can set several of these in a row, so each builds on the last.
    const editTimes = (change: Partial<EventFieldTimes>) => setTimes((current) => ({ ...current, ...change }));

    // Until the user picks one, the default calendar follows the list.
    const defaultCal = calendarOptions.find((c) => c.id === defaultCalendar(calendars ?? [])?.id);
    const defaultCalKey = defaultCal ? calendarKey(defaultCal) : '';
    const selectedCalKey = pickedCalKey ?? defaultCalKey;
    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const createEvent = useCreateEvent(selectedCal?.ownerId ?? ownerId);

    if (!calendars) return <LoadingState />;

    const changed =
        [title, description, location].some((text) => text !== '') ||
        selectedCalKey !== defaultCalKey ||
        timesDiffer(times, seed) ||
        attendees.length > 0 ||
        guestInput.hasText;

    return (
        <FormDialogForm
            changed={changed}
            submitLabel="Create"
            onSubmit={async () => {
                const guests = guestInput.commitGuests();
                // A calendar picked here that a refetch dropped shows the picker's placeholder.
                if (!title.trim() || !guests || !selectedCal) return false;
                const { start, end } = buildEventTimes(
                    times.allDay,
                    times.startDate,
                    times.endDate,
                    times.startTime,
                    times.endTime,
                );
                await createEvent.mutateAsync({
                    calendarId: selectedCal.id,
                    title: title.trim(),
                    startTime: start,
                    endTime: end,
                    allDay: times.allDay,
                    description: description.trim() || null,
                    location: location.trim() || null,
                    rrule: times.rrule,
                    timezone: times.allDay ? null : viewerTimeZone(),
                    data: guests.length > 0 ? { attendees: guests } : undefined,
                });
            }}
        >
            <EventFormFields
                title={title}
                setTitle={setTitle}
                allDay={times.allDay}
                setAllDay={(allDay) => editTimes({ allDay })}
                startDate={times.startDate}
                setStartDate={(startDate) => editTimes({ startDate })}
                endDate={times.endDate}
                setEndDate={(endDate) => editTimes({ endDate })}
                startTime={times.startTime}
                setStartTime={(startTime) => editTimes({ startTime })}
                endTime={times.endTime}
                setEndTime={(endTime) => editTimes({ endTime })}
                location={location}
                setLocation={setLocation}
                description={description}
                setDescription={setDescription}
                rruleString={times.rrule}
                setRruleString={(rrule) => editTimes({ rrule })}
                selectedCalKey={selectedCalKey}
                setSelectedCalKey={setPickedCalKey}
                calendarOptions={calendarOptions}
                recurrenceStartDate={new Date(`${times.startDate}T00:00:00`)}
                timezone={viewerTimeZone()}
                attendeesSection={
                    <div className="flex items-start gap-3">
                        <UsersRound className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                        <div className="flex-1">
                            <AttendeeEditor attendees={attendees} onChange={setAttendees} input={guestInput} />
                        </div>
                    </div>
                }
            />
        </FormDialogForm>
    );
}

// The next quarter hour, on the clicked day when there is one, for a new event's length.
function nextSlot(day: Date | undefined): NewEventTimes {
    const rounded = roundToNext15Minutes(new Date());
    const start = day ? new Date(day) : rounded;
    start.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
    return { start, end: new Date(start.getTime() + NEW_EVENT_MINUTES * 60_000), allDay: false };
}
