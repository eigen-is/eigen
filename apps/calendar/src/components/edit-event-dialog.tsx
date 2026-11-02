// The Edit event dialog: every field of an existing event and its guests. Save, or Enter in a field, saves the change,
// after asking which occurrences of a repeating event it applies to, or before a move to another owner's calendar
// that loses something. An invitation from someone else only lets you pick the calendar that holds it. It opens over
// an event, such as from the event detail dialog.

import { useAuth } from '@workspace/lib/auth';
import {
    heldAttendees,
    isSeriesOccurrence,
    occurrenceDateToString,
    parseOccurrenceDate,
    seriesEditFromOccurrence,
    toLocalDateString,
    truncateRRule,
    useCalendarOptions,
    useCalendars,
    useCreateEvent,
    useDeleteEvent,
    useEvent,
    useIsInvitationFromOthers,
    useMoveEvent,
    useSharedCalendars,
    useUpdateEvent,
    viewerTimeZone,
} from '@workspace/lib/calendar';
import type { Attendee, CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { ConfirmDialog, FormDialog, FormDialogForm } from '@workspace/ui';
import { AttendeeList } from '@workspace/ui/components/calendar';
import { UsersRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AttendeeEditor } from './attendee-editor';
import { buildEventTimes, calendarKey } from './calendar-utils';
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
    const ownerId = user?.id ?? '';
    const eventOwnerId = ownerUserId || ownerId;

    const { data: fetchedCalendars = [] } = useCalendars(ownerId);
    const { data: fetchedSharedCalendars = [] } = useSharedCalendars(ownerId);
    const calendars = calendarsProp ?? fetchedCalendars;
    const sharedCalendars = sharedCalendarsProp ?? fetchedSharedCalendars;

    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars);

    // The fields live here, not in a child that mounts with the dialog as New event's do. Edit event hides behind the
    // recurring choice or the move warning, and a cancel there brings it back with the edits still in it.
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

    // A retry after a failed source delete must not create the destination twice, nor fan invitations out again.
    const createdDestinationRef = useRef(false);
    useEffect(() => {
        if (open) createdDestinationRef.current = false;
    }, [open]);

    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const calendarChanged = event
        ? selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== eventOwnerId
        : false;

    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(selectedCal?.ownerId || eventOwnerId);
    const deleteEventOnSource = useDeleteEvent(eventOwnerId);
    const moveEvent = useMoveEvent(eventOwnerId);
    const isFromOthers = useIsInvitationFromOthers(eventOwnerId);
    // A series is saved on its master, and only the master's own row says which date the series starts on.
    const { data: master } = useEvent(
        eventOwnerId,
        event?.calendarId ?? '',
        event ? event.parentEventId || event.id : '',
        open && !!event && isSeriesOccurrence(event),
    );

    useEffect(() => {
        if (event && open) {
            setTitle(event.title);
            setDescription(event.description ?? '');
            setLocation(event.location ?? '');
            setAllDay(event.allDay);
            setRruleString(event.rrule);
            setAttendees(heldAttendees(event, master));

            const currentCal =
                calendarOptions.find((c) => c.id === event.calendarId && c.ownerId === eventOwnerId) ??
                calendarOptions[0];
            setSelectedCalKey(currentCal ? calendarKey(currentCal) : '');

            if (event.allDay) {
                // An all-day event runs from UTC midnight to the UTC midnight after its last day.
                const utcDay = (date: Date) =>
                    toLocalDateString(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
                setStartDate(utcDay(event.startTime));
                setEndDate(utcDay(new Date(event.endTime.getTime() - 86400_000)));
                setStartTime('00:00');
                setEndTime('00:00');
            } else {
                setStartDate(toLocalDateString(event.startTime));
                setStartTime(toTimeString(event.startTime));
                setEndDate(toLocalDateString(event.endTime));
                setEndTime(toTimeString(event.endTime));
            }
        }
    }, [event, master, open, calendarOptions, eventOwnerId]);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    // An override of one occurrence carries no rule of its own: sending one back saves over the whole series.
    const isOverride = !!event.parentEventId;
    const isPartOfSeries = isSeriesOccurrence(event);
    const isLinkedEvent = isFromOthers(event);
    // An invitation from someone else is read-only except for which calendar holds the copy.
    const canSave = !isLinkedEvent || calendarChanged;

    // A cross-Home move fires deleteEvent's iMIP side effects and leaves the exception children behind, so warn first.
    const crossHomeMove = calendarChanged && !!selectedCal && selectedCal.ownerId !== eventOwnerId;
    const moveLossReasons: string[] = [];
    if (isLinkedEvent) moveLossReasons.push('the invitation link will be removed (the organizer will see a decline)');
    else if (attendees.length) moveLossReasons.push('guests will be notified it was canceled and re-invited');
    if (isRecurring) moveLossReasons.push("modified occurrences of the series won't move");

    const save = async (action: RecurringAction) => {
        const { start, end } = buildEventTimes(allDay, startDate, endDate, startTime, endTime);

        const data = { ...event.data, attendees: attendees.length > 0 ? attendees : undefined };
        const timezone = allDay ? null : (event.timezone ?? viewerTimeZone());
        const edited = {
            title: title.trim(),
            description: description.trim() || null,
            location: location.trim() || null,
            allDay,
            startTime: start,
            endTime: end,
        };
        const updates = {
            ...edited,
            rrule: isOverride ? undefined : rruleString,
            timezone,
            data: Object.values(data).some((v) => v !== undefined) ? data : null,
        };
        // The master is saved with what the user changed, never with the clicked occurrence's own times: taking
        // those would drag the series' start onto that date and drop every occurrence before it.
        const seriesUpdates = master
            ? {
                  rrule: updates.rrule,
                  timezone,
                  data: updates.data,
                  ...seriesEditFromOccurrence(event, master, edited),
              }
            : updates;

        const targetId = event.parentEventId || event.id;

        if (calendarChanged && selectedCal) {
            if (selectedCal.ownerId === eventOwnerId) {
                // The server-owned move carries the exception children and the organizer link, and fires no decline.
                await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, ...seriesUpdates });
                await moveEvent.mutateAsync({
                    calendarId: event.calendarId,
                    id: targetId,
                    targetCalendarId: selectedCal.id,
                });
            } else {
                // Two Homes have no atomic move. The event is recreated, then deleted, and the organizer link and the
                // overrides stay behind.
                if (!createdDestinationRef.current) {
                    await createEvent.mutateAsync({ calendarId: selectedCal.id, ...updates });
                    createdDestinationRef.current = true;
                }
                await deleteEventOnSource.mutateAsync({ id: targetId, calendarId: event.calendarId });
                createdDestinationRef.current = false;
            }
        } else if (action === 'all') {
            await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, ...seriesUpdates });
        } else if (action === 'this') {
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                ...updates,
                rrule: null,
                parentEventId: targetId,
                recurrenceDate: occurrenceDateToString(event.occurrenceDate),
            });
        } else if (action === 'this-and-following') {
            if (event.rrule) {
                const truncated = truncateRRule(event.rrule, parseOccurrenceDate(event.occurrenceDate));
                await updateEvent.mutateAsync({ id: targetId, calendarId: event.calendarId, rrule: truncated });
            }
            await createEvent.mutateAsync({ calendarId: event.calendarId, ...updates });
        }
    };

    // Edit event is hidden while the recurring choice or the move warning is up, so their save closes it too.
    const saveAndClose = async (action: RecurringAction) => {
        await save(action);
        onOpenChange(false);
    };

    return (
        <>
            <FormDialog
                open={open && !showRecurringDialog && !showMoveConfirm}
                onOpenChange={onOpenChange}
                title="Edit event"
                size="md"
            >
                <FormDialogForm
                    canSubmit={title.trim() !== '' && (!isPartOfSeries || !!master)}
                    submitLabel="Save"
                    readOnly={!canSave}
                    onSubmit={async () => {
                        if (crossHomeMove && moveLossReasons.length > 0) {
                            setShowMoveConfirm(true);
                            return false;
                        }
                        if (isPartOfSeries && !calendarChanged) {
                            setShowRecurringDialog(true);
                            return false;
                        }
                        await save('all');
                    }}
                >
                    {isLinkedEvent && (
                        <p className="text-xs text-muted-foreground">
                            You were invited to this event. Only the organizer can change its details.
                        </p>
                    )}

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
                        recurrenceStartDate={new Date(`${startDate}T00:00:00`)}
                        timezone={event.timezone || viewerTimeZone()}
                        allDayId="edit-all-day"
                        detailsDisabled={isLinkedEvent}
                        attendeesSection={
                            isLinkedEvent ? (
                                attendees.length ? (
                                    <div className="flex items-start gap-3">
                                        <UsersRound className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                        <div className="flex-1">
                                            <AttendeeList attendees={attendees} organizer={event.data?.organizer} />
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
                                        {isPartOfSeries && attendees.length === 0 && (
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Saved for one occurrence, this keeps the series' guests.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )
                        }
                    />
                </FormDialogForm>
            </FormDialog>

            <RecurringActionDialog
                open={showRecurringDialog}
                onOpenChange={setShowRecurringDialog}
                title="Edit recurring event"
                onConfirm={saveAndClose}
                options={isOverride ? ['this', 'all'] : undefined}
            />

            <ConfirmDialog
                open={showMoveConfirm}
                onOpenChange={setShowMoveConfirm}
                title="Move to another calendar owner?"
                description={`Moving this event to a calendar owned by someone else recreates it there, so ${moveLossReasons.join(', and ')}.`}
                confirmText="Move"
                onConfirm={() => saveAndClose('all')}
            />
        </>
    );
}
