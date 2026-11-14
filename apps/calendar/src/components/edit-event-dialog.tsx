// The Edit event dialog: every field of an existing event and its guests. A change to a repeating event first asks
// which occurrences it applies to, and a move to another owner's calendar that loses something warns first. An
// invitation from someone else only lets you pick the calendar that holds it. It opens over an event, such as from the
// event detail dialog, which mounts it anew for each opening. A field shows what the user changed, else the event as it
// is now, so a refetch or a refused Save moves only what nobody touched.

import { useAuth } from '@workspace/lib/auth';
import {
    isSeriesOccurrence,
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
    useRefuseStaleEvent,
    useSharedCalendars,
    useUpdateEvent,
    viewerTimeZone,
} from '@workspace/lib/calendar';
import type { Attendee, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { useHeldEtag } from '@workspace/lib/use-held-etag';
import { AttendeeList } from '@workspace/ui/components/calendar';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { UsersRound } from 'lucide-react';
import { useState } from 'react';
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
};

// What the user changed, and nothing else. The times and the repeat are one entry, because a preset rule names the
// start's weekday and an end means nothing beside another event's start.
type TypedFields = {
    title?: string;
    description?: string;
    location?: string;
    times?: ReturnType<typeof fieldTimes>;
    attendees?: Attendee[];
    calendarKey?: string;
};

export function EditEventDialog({ open, onOpenChange, event, ownerUserId }: EditEventDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const eventOwnerId = ownerUserId || ownerId;

    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);

    const calendarOptions = useCalendarOptions(ownerId, calendars, sharedCalendars);

    // The fields live here, not in a child that mounts with the dialog as New event's do. Edit event hides behind the
    // recurring choice or the move warning, and a cancel there brings it back with the edits still in it.
    const [typed, setTyped] = useState<TypedFields>({});
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);
    const [showMoveConfirm, setShowMoveConfirm] = useState(false);

    // A refused save goes back to the form the toast says to check.
    const { heldEtag, holdEtag, refuse, saveHeld } = useHeldEtag(event.etag, Object.keys(typed).length > 0, () => {
        setShowRecurringDialog(false);
        setShowMoveConfirm(false);
    });

    const times = typed.times ?? fieldTimes(event);
    const edit = (change: TypedFields) => setTyped((current) => ({ ...current, ...change }));
    // One user action can set several of these in a row, so each builds on the last.
    const editTimes = (change: Partial<typeof times>) => {
        setTyped((current) => ({ ...current, times: { ...(current.times ?? times), ...change } }));
    };

    const currentCal =
        calendarOptions.find((c) => c.id === event.calendarId && c.ownerId === eventOwnerId) ?? calendarOptions[0];
    const selectedCalKey = typed.calendarKey ?? (currentCal ? calendarKey(currentCal) : '');
    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const calendarChanged = selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== eventOwnerId;

    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(selectedCal?.ownerId || eventOwnerId);
    const deleteEventOnSource = useDeleteEvent(eventOwnerId);
    const moveEvent = useMoveEvent(eventOwnerId);
    const refuseStaleEvent = useRefuseStaleEvent(eventOwnerId);
    const isFromOthers = useIsInvitationFromOthers(eventOwnerId);
    // A series is saved on its master, and only the master's own row says which date the series starts on.
    const { data: master } = useEvent(
        eventOwnerId,
        event.calendarId,
        event.parentEventId || event.id,
        open && isSeriesOccurrence(event),
    );

    const title = typed.title ?? event.title;
    const description = typed.description ?? event.description ?? '';
    const location = typed.location ?? event.location ?? '';
    const { allDay, startDate, startTime, endDate, endTime, rrule: rruleString } = times;
    // A list the user edited says who is on it, and each guest's reply stays the server's.
    const serverAttendees = event.data?.attendees ?? [];
    const attendees =
        typed.attendees?.map(
            (guest) => serverAttendees.find((held) => held.email.toLowerCase() === guest.email.toLowerCase()) ?? guest,
        ) ?? serverAttendees;
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

    const write = async (action: RecurringAction) => {
        const { start, end } = buildEventTimes(allDay, startDate, endDate, startTime, endTime);

        const seriesGuests = (own: readonly Attendee[]) => {
            const emails = (guests: readonly Attendee[]) => new Set(guests.map((guest) => guest.email.toLowerCase()));
            const shown = emails(serverAttendees);
            const listed = emails(attendees);
            const owned = emails(own);
            const kept = own.filter(({ email }) => !shown.has(email.toLowerCase()) || listed.has(email.toLowerCase()));
            const joined = attendees.filter(
                ({ email }) => !shown.has(email.toLowerCase()) && !owned.has(email.toLowerCase()),
            );
            return [...kept, ...joined];
        };
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
            data: { ...event.data, attendees },
        };
        // The master is saved with what the user changed, never with the clicked occurrence's own times: taking
        // those would drag the series' start onto that date and drop every occurrence before it. Its guests are its
        // own list with the guests added or removed here, so a guest the date leaves out stays on the series.
        const seriesUpdates = master
            ? {
                  rrule: updates.rrule,
                  timezone,
                  ...(typed.attendees && { data: { attendees: seriesGuests(master.data?.attendees ?? []) } }),
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
                    etag: heldEtag,
                    ...seriesUpdates,
                });
                holdEtag(updated.etag);
                await moveEvent.mutateAsync({
                    calendarId: event.calendarId,
                    id: targetId,
                    targetCalendarId: selectedCal.id,
                    etag: updated.etag,
                });
            } else {
                // Two Homes have no atomic move. The event is recreated, then deleted, and the organizer link and the
                // overrides stay behind.
                await createEvent.mutateAsync({ calendarId: selectedCal.id, ...updates });
                await deleteEventOnSource.mutateAsync({
                    id: targetId,
                    calendarId: event.calendarId,
                    etag: heldEtag,
                });
            }
        } else if (action === 'all') {
            await updateEvent.mutateAsync({
                id: targetId,
                calendarId: event.calendarId,
                etag: heldEtag,
                ...seriesUpdates,
            });
        } else if (action === 'this') {
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                ...updates,
                rrule: null,
                parentEventId: targetId,
                recurrenceDate: event.occurrenceDate,
                etag: heldEtag,
            });
        } else if (action === 'this-and-following') {
            if (event.rrule) {
                const truncated = truncateRRule(event.rrule, event.occurrenceDate, event);
                const updated = await updateEvent.mutateAsync({
                    id: targetId,
                    calendarId: event.calendarId,
                    etag: heldEtag,
                    rrule: truncated,
                });
                holdEtag(updated.etag);
            }
            await createEvent.mutateAsync({ calendarId: event.calendarId, ...updates });
        }
    };

    // A cross-home copy made by a form already behind the event would only stand beside the original.
    const save = async (action: RecurringAction): Promise<false | undefined> => {
        if (crossHomeMove && heldEtag !== event.etag) {
            refuseStaleEvent();
            refuse();
            return false;
        }
        await saveHeld(() => write(action));
    };

    // Edit event is hidden while the recurring choice or the move warning is up, so their save closes it too.
    const saveAndClose = async (action: RecurringAction) => {
        if ((await save(action)) !== false) onOpenChange(false);
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
                        return save('all');
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
                        setTitle={(value) => edit({ title: value })}
                        allDay={allDay}
                        setAllDay={(value) => editTimes({ allDay: value })}
                        startDate={startDate}
                        setStartDate={(value) => editTimes({ startDate: value })}
                        endDate={endDate}
                        setEndDate={(value) => editTimes({ endDate: value })}
                        startTime={startTime}
                        setStartTime={(value) => editTimes({ startTime: value })}
                        endTime={endTime}
                        setEndTime={(value) => editTimes({ endTime: value })}
                        location={location}
                        setLocation={(value) => edit({ location: value })}
                        description={description}
                        setDescription={(value) => edit({ description: value })}
                        rruleString={rruleString}
                        setRruleString={(value) => editTimes({ rrule: value })}
                        selectedCalKey={selectedCalKey}
                        setSelectedCalKey={(value) => edit({ calendarKey: value })}
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
                                            onChange={(value) => edit({ attendees: value })}
                                            currentUserEmail={user?.email}
                                        />
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
    const { allDay, rrule } = event;
    if (!allDay) {
        return {
            allDay,
            rrule,
            startDate: toLocalDateString(event.startTime),
            startTime: toTimeString(event.startTime),
            endDate: toLocalDateString(event.endTime),
            endTime: toTimeString(event.endTime),
        };
    }
    const utcDay = (date: Date) =>
        toLocalDateString(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return {
        allDay,
        rrule,
        startDate: utcDay(event.startTime),
        startTime: '00:00',
        endDate: utcDay(new Date(event.endTime.getTime() - 86400_000)),
        endTime: '00:00',
    };
}
