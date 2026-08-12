import { useAuth } from '@workspace/lib/auth';
import {
    occurrenceDateToString,
    parseOccurrenceDate,
    toLocalDateString,
    truncateRRule,
    useCalendars,
    useCreateEvent,
    useDeleteEvent,
    useMoveEvent,
    useSharedCalendars,
    useUpdateEvent,
} from '@workspace/lib/calendar';
import { useMyTeams } from '@workspace/lib/home';
import type { Attendee, CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { ConfirmDialog } from '@workspace/ui/components/layout/confirm-dialog';
import { UsersRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AttendeeEditor, AttendeeList } from './attendee-editor';
import { buildEventTimes, useCalendarOptions } from './calendar-utils';
import { EventFormFields } from './event-form-fields';
import type { RecurringAction } from './recurring-action-dialog';
import { RecurringActionDialog } from './recurring-action-dialog';
import { toTimeString } from './time-select';

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    ownerUserId?: string;
    calendars?: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
};

export function EditEventDialog({
    open,
    onOpenChange,
    event,
    ownerUserId,
    calendars: calendarsProp,
    sharedCalendars: sharedCalendarsProp,
}: EditEventDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const eventOwnerId = ownerUserId || ownerId;

    const { data: fetchedCalendars = [] } = useCalendars(ownerId);
    const { data: fetchedSharedCalendars = [] } = useSharedCalendars(ownerId);
    const { data: myTeams } = useMyTeams();
    const calendars = calendarsProp || fetchedCalendars;
    const sharedCalendars = sharedCalendarsProp || fetchedSharedCalendars;

    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars, myTeams);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endDate, setEndDate] = useState('');
    const [endTime, setEndTime] = useState('');
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [attendees, setAttendees] = useState<Attendee[]>([]);
    const [selectedCalKey, setSelectedCalKey] = useState('');
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);
    const [showMoveConfirm, setShowMoveConfirm] = useState(false);

    // A cross-Home move creates the destination event then deletes the source. If the delete fails the
    // dialog stays open; remember that the destination already exists so a retry only re-runs the delete
    // instead of creating a second event (and re-fanning-out invitations). Reset each time the dialog opens.
    const createdDestRef = useRef(false);
    useEffect(() => {
        if (open) createdDestRef.current = false;
    }, [open]);

    const selectedCal = calendarOptions.find((c) => `${c.ownerId}:${c.id}` === selectedCalKey);
    const calendarChanged = event
        ? selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== eventOwnerId
        : false;

    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(selectedCal?.ownerId || eventOwnerId);
    const deleteEventOnSource = useDeleteEvent(eventOwnerId);
    const moveEvent = useMoveEvent(eventOwnerId);
    const saving =
        updateEvent.isPending || createEvent.isPending || deleteEventOnSource.isPending || moveEvent.isPending;

    useEffect(() => {
        if (event && open) {
            setTitle(event.title);
            setDescription(event.description || '');
            setLocation(event.location || '');
            setAllDay(event.allDay);
            setRruleString(event.rrule);
            setAttendees(event.data?.attendees || []);

            const currentCal = calendarOptions.find((c) => c.id === event.calendarId && c.ownerId === eventOwnerId);
            setSelectedCalKey(
                currentCal
                    ? `${currentCal.ownerId}:${currentCal.id}`
                    : calendarOptions[0]
                      ? `${calendarOptions[0].ownerId}:${calendarOptions[0].id}`
                      : '',
            );

            if (event.allDay) {
                const sd = event.startTime;
                const ed = new Date(event.endTime.getTime() - 86400_000);
                setStartDate(toLocalDateString(new Date(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate())));
                setEndDate(toLocalDateString(new Date(ed.getUTCFullYear(), ed.getUTCMonth(), ed.getUTCDate())));
                setStartTime('00:00');
                setEndTime('00:00');
            } else {
                setStartDate(toLocalDateString(event.startTime));
                setStartTime(toTimeString(event.startTime));
                setEndDate(toLocalDateString(event.endTime));
                setEndTime(toTimeString(event.endTime));
            }
        }
    }, [event, open, calendarOptions, eventOwnerId]);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isLinkedEvent = !!event.data?.organizer;

    // A cross-Home move recreates the event in the other Home and deletes the source — which fires
    // deleteEvent's iMIP side effects and can't carry exception children. Warn honestly before that
    // (same precedence as deleteEvent: invitee-decline over organizer-cancel).
    const crossHomeMove = calendarChanged && !!selectedCal && selectedCal.ownerId !== eventOwnerId;
    const moveLossReasons: string[] = [];
    if (isLinkedEvent) moveLossReasons.push('the invitation link will be removed (the organizer will see a decline)');
    else if (event.data?.attendees?.length)
        moveLossReasons.push('guests will be notified it was cancelled and re-invited');
    if (isRecurring) moveLossReasons.push("modified occurrences of the series won't move");

    const handleSaveClick = () => {
        if (!title.trim()) return;
        if (crossHomeMove && moveLossReasons.length > 0) {
            setShowMoveConfirm(true);
        } else if (isRecurring && !calendarChanged) {
            setShowRecurringDialog(true);
        } else {
            doSave('all');
        }
    };

    const doSave = async (action: RecurringAction) => {
        const { start, end } = buildEventTimes(allDay, startDate, endDate, startTime, endTime);

        const data = { ...event.data, attendees: attendees.length > 0 ? attendees : undefined };
        const timezone = allDay ? null : (event.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
        const updates = {
            title: title.trim(),
            startTime: start,
            endTime: end,
            allDay,
            description: description.trim() || null,
            location: location.trim() || null,
            rrule: rruleString,
            timezone,
            data: Object.values(data).some((v) => v !== undefined) ? data : null,
        };

        const targetId = event.parentEventId || event.id;

        if (calendarChanged && selectedCal) {
            if (selectedCal.ownerId === eventOwnerId) {
                // Same Home: apply the edits in place, then the server-owned atomic move re-homes the master
                // and its exception children, preserving the organizer link, timezone, and data a client can't
                // re-send — and never firing deleteEvent's decline.
                await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, ...updates });
                await moveEvent.mutateAsync({
                    calendarId: event.calendarId,
                    id: targetId,
                    targetCalendarId: selectedCal.id,
                });
            } else {
                // Cross-Home move can't be atomic (the calendars live in different Homes): recreate the event
                // in the target Home and delete the source. Organizer link and exception overrides don't cross Homes.
                // The ref keeps the move retry-safe — skip re-creation if a prior attempt already created the
                // destination and only the source delete failed.
                if (!createdDestRef.current) {
                    await createEvent.mutateAsync({ calendarId: selectedCal.id, ...updates });
                    createdDestRef.current = true;
                }
                await deleteEventOnSource.mutateAsync({ id: targetId, calendarId: event.calendarId });
                createdDestRef.current = false;
            }
        } else if (action === 'all') {
            await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, ...updates });
        } else if (action === 'this') {
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                ...updates,
                allDay: Boolean(allDay),
                rrule: null,
                parentEventId: targetId,
                recurrenceDate: occurrenceDateToString(event.occurrenceDate),
            });
        } else if (action === 'this-and-following') {
            const occDate = parseOccurrenceDate(event.occurrenceDate);
            if (event.rrule) {
                const truncated = truncateRRule(event.rrule, occDate);
                await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, rrule: truncated });
            }
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                ...updates,
                allDay: Boolean(allDay),
            });
        }

        onOpenChange(false);
    };

    return (
        <>
            <Dialog open={open && !showRecurringDialog && !showMoveConfirm} onOpenChange={onOpenChange}>
                <DialogContent size="md">
                    <DialogHeader>
                        <DialogTitle>Edit Event</DialogTitle>
                    </DialogHeader>

                    <EventFormFields
                        titlePlaceholder="Event title"
                        locationPlaceholder="Location"
                        descriptionPlaceholder="Description"
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
                        recurrenceStartDate={new Date(startDate)}
                        timezone={event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
                        allDayId="edit-all-day"
                        attendeesSection={
                            isLinkedEvent ? (
                                event.data?.attendees?.length ? (
                                    <div className="flex items-start gap-3">
                                        <UsersRound className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                        <div className="flex-1">
                                            <AttendeeList
                                                attendees={event.data.attendees}
                                                organizer={event.data.organizer}
                                            />
                                        </div>
                                    </div>
                                ) : null
                            ) : (
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
                            )
                        }
                    />

                    <DialogFooter>
                        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveClick} disabled={saving || !title.trim()}>
                            {saving ? 'Saving...' : 'Save'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <RecurringActionDialog
                open={showRecurringDialog}
                onOpenChange={setShowRecurringDialog}
                title="Edit recurring event"
                onConfirm={doSave}
            />

            <ConfirmDialog
                open={showMoveConfirm}
                onOpenChange={setShowMoveConfirm}
                title="Move to another calendar owner?"
                description={`Moving this event to a calendar owned by someone else recreates it there, so ${moveLossReasons.join(', and ')}.`}
                confirmText="Move"
                onConfirm={() => doSave('all')}
            />
        </>
    );
}
