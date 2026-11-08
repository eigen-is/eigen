// The Edit event dialog: every field of an existing event and its guests. Save, or Enter in the title, saves the
// change. A change to a repeating event first asks which occurrences it applies to. A move to another owner's calendar
// that loses something, such as a series' changed occurrences, warns first. An invitation from someone else only lets
// you pick the calendar that holds it. It opens over an event, such as from the event detail dialog, which mounts it
// anew for each opening, so the fields start from the event as it is then.

import { isStaleWrite } from '@workspace/lib/api-error';
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
import type { Attendee, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
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
    event: CalendarEventOccurrence;
    ownerUserId?: string;
    // Remounts the dialog on the current event. After a 412 the toast says it reloaded, so the fields follow.
    onReload: () => void;
};

export function EditEventDialog({ open, onOpenChange, event, ownerUserId, onReload }: EditEventDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const eventOwnerId = ownerUserId || ownerId;

    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);

    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars);

    // The fields live here, not in a child that mounts with the dialog as New event's do. Edit event hides behind the
    // recurring choice or the move warning, and a cancel there brings it back with the edits still in it.
    const loadedTimes = fieldTimes(event);
    const [title, setTitle] = useState(event.title);
    const [description, setDescription] = useState(event.description ?? '');
    const [location, setLocation] = useState(event.location ?? '');
    const [allDay, setAllDay] = useState(event.allDay);
    const [startDate, setStartDate] = useState(loadedTimes.startDate);
    const [startTime, setStartTime] = useState(loadedTimes.startTime);
    const [endDate, setEndDate] = useState(loadedTimes.endDate);
    const [endTime, setEndTime] = useState(loadedTimes.endTime);
    const [rruleString, setRruleString] = useState(event.rrule);
    // Null until the user changes them: the guests can arrive with the series, and the choices with their queries.
    const [editedAttendees, setEditedAttendees] = useState<Attendee[] | null>(null);
    const [pickedCalKey, setPickedCalKey] = useState<string | null>(null);
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);
    const [showMoveConfirm, setShowMoveConfirm] = useState(false);

    // The calendar a cross-home move already created its copy in. A retry after a failed source delete must not create
    // that copy twice, nor send its invitations again. A retry into another calendar still creates the copy there.
    const createdDestinationRef = useRef<string | null>(null);

    // The etag these fields answer to, not the live event's: a refetch can advance that mid-edit, and sending it would
    // overwrite the newer write with the older fields. A save that writes moves it on to what its own write answered.
    const loadedEtag = useRef(event.etag);

    const currentCal =
        calendarOptions.find((c) => c.id === event.calendarId && c.ownerId === eventOwnerId) ?? calendarOptions[0];
    const selectedCalKey = pickedCalKey ?? (currentCal ? calendarKey(currentCal) : '');
    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const calendarChanged = selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== eventOwnerId;

    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(selectedCal?.ownerId || eventOwnerId);
    const deleteEventOnSource = useDeleteEvent(eventOwnerId);
    const moveEvent = useMoveEvent(eventOwnerId);
    const isFromOthers = useIsInvitationFromOthers(eventOwnerId);
    // A series is saved on its master, and only the master's own row says which date the series starts on.
    const { data: master } = useEvent(
        eventOwnerId,
        event.calendarId,
        event.parentEventId || event.id,
        open && isSeriesOccurrence(event),
    );

    const staleWrite = [updateEvent, createEvent, deleteEventOnSource, moveEvent].some((write) =>
        isStaleWrite(write.error),
    );
    const followReload = staleWrite && event.etag !== loadedEtag.current;
    useEffect(() => {
        if (followReload) onReload();
    }, [followReload, onReload]);

    const attendees = editedAttendees ?? heldAttendees(event, master);
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
                const updated = await updateEvent.mutateAsync({
                    id: targetId,
                    calendarId: event.calendarId,
                    etag: loadedEtag.current,
                    ...seriesUpdates,
                });
                loadedEtag.current = updated.etag;
                await moveEvent.mutateAsync({
                    calendarId: event.calendarId,
                    id: targetId,
                    targetCalendarId: selectedCal.id,
                    etag: updated.etag,
                });
            } else {
                // Two Homes have no atomic move. The event is recreated, then deleted, and the organizer link and the
                // overrides stay behind.
                if (createdDestinationRef.current !== selectedCalKey) {
                    await createEvent.mutateAsync({ calendarId: selectedCal.id, ...updates });
                    createdDestinationRef.current = selectedCalKey;
                }
                await deleteEventOnSource.mutateAsync({
                    id: targetId,
                    calendarId: event.calendarId,
                    etag: loadedEtag.current,
                });
                createdDestinationRef.current = null;
            }
        } else if (action === 'all') {
            await updateEvent.mutateAsync({
                id: targetId,
                calendarId: event.calendarId,
                etag: loadedEtag.current,
                ...seriesUpdates,
            });
        } else if (action === 'this') {
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                ...updates,
                rrule: null,
                parentEventId: targetId,
                recurrenceDate: occurrenceDateToString(event.occurrenceDate),
                etag: loadedEtag.current,
            });
        } else if (action === 'this-and-following') {
            if (event.rrule) {
                const truncated = truncateRRule(event.rrule, parseOccurrenceDate(event.occurrenceDate));
                const updated = await updateEvent.mutateAsync({
                    id: targetId,
                    calendarId: event.calendarId,
                    etag: loadedEtag.current,
                    rrule: truncated,
                });
                loadedEtag.current = updated.etag;
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
                        setSelectedCalKey={setPickedCalKey}
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
                                            onChange={setEditedAttendees}
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

// An all-day event runs from UTC midnight to the UTC midnight after its last day.
function fieldTimes(event: CalendarEventOccurrence) {
    if (!event.allDay) {
        return {
            startDate: toLocalDateString(event.startTime),
            startTime: toTimeString(event.startTime),
            endDate: toLocalDateString(event.endTime),
            endTime: toTimeString(event.endTime),
        };
    }
    const utcDay = (date: Date) =>
        toLocalDateString(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return {
        startDate: utcDay(event.startTime),
        startTime: '00:00',
        endDate: utcDay(new Date(event.endTime.getTime() - 86400_000)),
        endTime: '00:00',
    };
}
