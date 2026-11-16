// The New event dialog, opened from the toolbar or from a click on a day. It starts at the next quarter hour, on the
// clicked day when there is one, for half an hour, in the default calendar, and saves through useCreateEvent.

import { useAuth } from '@workspace/lib/auth';
import {
    toLocalDateString,
    useCalendarOptions,
    useCalendars,
    useCreateEvent,
    useSharedCalendars,
    viewerTimeZone,
} from '@workspace/lib/calendar';
import type { Attendee } from '@workspace/lib/types/calendar';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { UsersRound } from 'lucide-react';
import { useState } from 'react';
import { AttendeeEditor } from './attendee-editor';
import { buildEventTimes, calendarKey } from './calendar-utils';
import { EventFormFields } from './event-form-fields';
import { endAfter, roundToNext15Minutes, toTimeString } from './time-select';

type CreateEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultDate?: Date;
    defaultCalendarId?: string;
};

export function CreateEventDialog({ open, onOpenChange, defaultDate, defaultCalendarId }: CreateEventDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="New event" size="md">
            <CreateEventForm defaultDate={defaultDate} defaultCalendarId={defaultCalendarId} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts empty at the next quarter hour.
function CreateEventForm({ defaultDate, defaultCalendarId }: Omit<CreateEventDialogProps, 'open' | 'onOpenChange'>) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);
    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars);

    const [initial] = useState(() => {
        const rounded = roundToNext15Minutes(new Date());
        const start = defaultDate ? new Date(defaultDate) : rounded;
        start.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
        return { start, end: endAfter(start, 30) };
    });
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [pickedCalKey, setPickedCalKey] = useState<string>();
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState(toLocalDateString(initial.start));
    const [endDate, setEndDate] = useState(initial.end.date);
    const [startTime, setStartTime] = useState(toTimeString(initial.start));
    const [endTime, setEndTime] = useState(initial.end.time);
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [attendees, setAttendees] = useState<Attendee[]>([]);

    // Until the user picks one, the default calendar follows the list, which may still be loading.
    const defaultCal = defaultCalendarId ? calendarOptions.find((c) => c.id === defaultCalendarId) : calendarOptions[0];
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
                titlePlaceholder="Add title"
                locationPlaceholder="Add location"
                descriptionPlaceholder="Add description"
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
                allDayId="all-day"
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
