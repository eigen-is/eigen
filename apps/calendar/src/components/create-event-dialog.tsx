// The New event dialog, opened from the toolbar, a click on a day or a slot, or a drag over a range of the time grid.
// It starts at the times the view gives, or else at the next quarter hour, on the clicked day when there is one, for
// a new event's length, in the default calendar, and saves through useCreateEvent.

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
import { UsersRound } from 'lucide-react';
import { useState } from 'react';
import { AttendeeEditor } from './attendee-editor';
import { buildEventTimes, calendarKey } from './calendar-utils';
import { EventFormFields } from './event-form-fields';
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
    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);
    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars);

    const [seed] = useState((): NewEventTimes => {
        if (initial) return initial;
        const rounded = roundToNext15Minutes(new Date());
        const start = defaultDate ? new Date(defaultDate) : rounded;
        start.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
        return { start, end: new Date(start.getTime() + NEW_EVENT_MINUTES * 60_000), allDay: false };
    });
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [pickedCalKey, setPickedCalKey] = useState<string>();
    const [allDay, setAllDay] = useState(seed.allDay);
    const [startDate, setStartDate] = useState(toLocalDateString(seed.start));
    const [endDate, setEndDate] = useState(toLocalDateString(seed.end));
    const [startTime, setStartTime] = useState(toTimeString(seed.start));
    const [endTime, setEndTime] = useState(toTimeString(seed.end));
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [attendees, setAttendees] = useState<Attendee[]>([]);

    // Until the user picks one, the default calendar follows the list, which may still be loading.
    const defaultCal = calendarOptions.find((c) => c.id === defaultCalendar(calendars)?.id);
    const selectedCalKey = pickedCalKey ?? (defaultCal ? calendarKey(defaultCal) : '');
    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const createEvent = useCreateEvent(selectedCal?.ownerId ?? ownerId);

    return (
        <FormDialogForm
            canSubmit={title.trim() !== '' && !!selectedCal}
            submitLabel="Save"
            onSubmit={async () => {
                if (!selectedCal) return false;
                const { start, end } = buildEventTimes(allDay, startDate, endDate, startTime, endTime);
                await createEvent.mutateAsync({
                    calendarId: selectedCal.id,
                    title: title.trim(),
                    startTime: start,
                    endTime: end,
                    allDay,
                    description: description.trim() || null,
                    location: location.trim() || null,
                    rrule: rruleString,
                    timezone: allDay ? null : viewerTimeZone(),
                    data: attendees.length > 0 ? { attendees } : undefined,
                });
            }}
        >
            <EventFormFields
                title={title}
                setTitle={setTitle}
                allDay={allDay}
                setAllDay={setAllDay}
                startDate={startDate}
                setStartDate={setStartDate}
                endDate={endDate}
                setEndDate={setEndDate}
                startTime={startTime}
                setStartTime={setStartTime}
                endTime={endTime}
                setEndTime={setEndTime}
                location={location}
                setLocation={setLocation}
                description={description}
                setDescription={setDescription}
                rruleString={rruleString}
                setRruleString={setRruleString}
                selectedCalKey={selectedCalKey}
                setSelectedCalKey={setPickedCalKey}
                calendarOptions={calendarOptions}
                recurrenceStartDate={new Date(`${startDate}T00:00:00`)}
                timezone={viewerTimeZone()}
                attendeesSection={
                    <div className="flex items-start gap-3">
                        <UsersRound className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                        <div className="flex-1">
                            <AttendeeEditor
                                attendees={attendees}
                                onChange={setAttendees}
                                currentUserEmail={user?.email}
                            />
                        </div>
                    </div>
                }
            />
        </FormDialogForm>
    );
}
