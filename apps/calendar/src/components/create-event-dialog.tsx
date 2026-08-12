import { useAuth } from '@workspace/lib/auth';
import { toLocalDateString, useCalendars, useCreateEvent, useSharedCalendars } from '@workspace/lib/calendar';
import { useMyTeams } from '@workspace/lib/home';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AttendeeEditor } from './attendee-editor';
import { buildEventTimes, useCalendarOptions } from './calendar-utils';
import { EventFormFields } from './event-form-fields';
import { addMinutes, roundToNext15Minutes, toTimeString } from './time-select';

type CreateEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultDate?: Date;
    defaultCalendarId?: string;
};

export function CreateEventDialog({ open, onOpenChange, defaultDate, defaultCalendarId }: CreateEventDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);
    const { data: myTeams } = useMyTeams();

    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars, myTeams);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [selectedCalKey, setSelectedCalKey] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [startTime, setStartTime] = useState('09:00');
    const [endTime, setEndTime] = useState('09:30');
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [attendees, setAttendees] = useState<Attendee[]>([]);

    const selectedCal = calendarOptions.find((c) => `${c.ownerId}:${c.id}` === selectedCalKey);
    const createEvent = useCreateEvent(selectedCal?.ownerId || ownerId);

    useEffect(() => {
        if (open) {
            const now = new Date();
            const rounded = roundToNext15Minutes(now);

            const targetDate = defaultDate ? new Date(defaultDate) : rounded;
            targetDate.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);

            const dateStr = toLocalDateString(targetDate);
            const start = toTimeString(targetDate);
            const end = addMinutes(start, 30);

            setTitle('');
            setDescription('');
            setLocation('');
            const defaultCal = defaultCalendarId
                ? calendarOptions.find((c) => c.id === defaultCalendarId)
                : calendarOptions[0];
            setSelectedCalKey(defaultCal ? `${defaultCal.ownerId}:${defaultCal.id}` : '');
            setAllDay(false);
            setStartDate(dateStr);
            setEndDate(dateStr);
            setStartTime(start);
            setEndTime(end);
            setRruleString(null);
            setAttendees([]);
        }
    }, [open, defaultDate, defaultCalendarId, calendarOptions]);

    const handleSubmit = async () => {
        if (!title.trim() || !selectedCal) return;

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
            timezone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
            data: attendees.length > 0 ? { attendees } : undefined,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md">
                <DialogHeader>
                    <DialogTitle>New Event</DialogTitle>
                </DialogHeader>

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
                    setSelectedCalKey={setSelectedCalKey}
                    calendarOptions={calendarOptions}
                    recurrenceStartDate={new Date(`${startDate}T00:00:00`)}
                    timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
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

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createEvent.isPending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={createEvent.isPending || !title.trim()}>
                        {createEvent.isPending ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
