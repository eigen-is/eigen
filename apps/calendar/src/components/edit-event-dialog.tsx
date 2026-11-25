// The Edit event dialog: every field of an existing event and its guests. A change to a repeating event first asks
// which occurrences it applies to, a move to another owner's calendar that loses something warns first, and an
// invitation from someone else only lets you pick its calendar. The event's detail column mounts it anew for each
// opening, and it shows a series once its master has loaded. A field shows what the user changed, else the event as
// it is now, so a refetch or a refused Save moves only what nobody touched.

import { useAuth } from '@workspace/lib/auth';
import {
    isSeriesOccurrence,
    occurrenceScopes,
    toLocalDateString,
    useCalendarOptions,
    useCalendars,
    useCreateEvent,
    useDeleteEvent,
    useEvent,
    useIsInvitationFromOthers,
    useMoveEvent,
    useRefuseStaleEvent,
    useSaveOccurrence,
    useSharedCalendars,
    viewerTimeZone,
} from '@workspace/lib/calendar';
import type { Attendee, CalendarEventOccurrence, RecurrenceScope } from '@workspace/lib/types/calendar';
import { useHeldEtag } from '@workspace/lib/use-held-etag';
import { AttendeeList } from '@workspace/ui/components/calendar';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { UsersRound } from 'lucide-react';
import { useState } from 'react';
import { AttendeeEditor, useGuestInput } from './attendee-editor';
import { buildEventTimes, calendarKey } from './calendar-utils';
import type { EventFieldTimes } from './event-form-fields';
import { EventFormFields, timesDiffer } from './event-form-fields';
import { RecurringActionDialog } from './recurring-action-dialog';
import { toTimeString } from './time-select';

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence;
    // The Home the event is saved in: the viewer's, or the owner's of the calendar shared with them.
    ownerId: string;
};

// What the user changed, and nothing else.
type TypedFields = {
    title?: string;
    description?: string;
    location?: string;
    times?: EventFieldTimes;
    attendees?: Attendee[];
    calendarKey?: string;
};

export function EditEventDialog({ open, onOpenChange, event, ownerId }: EditEventDialogProps) {
    const { user } = useAuth();
    const viewerId = user?.id ?? '';

    const { data: calendars = [] } = useCalendars(viewerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(viewerId);

    const calendarOptions = useCalendarOptions(viewerId, calendars, sharedCalendars);

    // The fields live here, not in a child that mounts with the dialog as New event's do. Edit event hides behind the
    // recurring choice or the move warning, and a cancel there brings it back with the edits still in it.
    const [typed, setTyped] = useState<TypedFields>({});
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);
    const [showMoveConfirm, setShowMoveConfirm] = useState(false);

    // A refused save goes back to the form the toast says to check.
    const held = useHeldEtag(event.etag, Object.keys(typed).length > 0, () => {
        setShowRecurringDialog(false);
        setShowMoveConfirm(false);
    });
    const { heldEtag, holdEtag, refuse, saveHeld } = held;

    const times = typed.times ?? fieldTimes(event);
    const edit = (change: TypedFields) => setTyped((current) => ({ ...current, ...change }));
    // One user action can set several of these in a row, so each builds on the last.
    const editTimes = (change: Partial<EventFieldTimes>) => {
        setTyped((current) => ({ ...current, times: { ...(current.times ?? times), ...change } }));
    };

    const currentCal =
        calendarOptions.find((c) => c.id === event.calendarId && c.ownerId === ownerId) ?? calendarOptions[0];
    const currentCalKey = currentCal ? calendarKey(currentCal) : '';
    const selectedCalKey = typed.calendarKey ?? currentCalKey;
    const selectedCal = calendarOptions.find((c) => calendarKey(c) === selectedCalKey);
    const calendarChanged = selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== ownerId;

    const saveOccurrence = useSaveOccurrence(ownerId, held);
    const createEvent = useCreateEvent(selectedCal?.ownerId || ownerId);
    const deleteEventOnSource = useDeleteEvent(ownerId);
    const moveEvent = useMoveEvent(ownerId);
    const refuseStaleEvent = useRefuseStaleEvent(ownerId);
    const isFromOthers = useIsInvitationFromOthers(ownerId);
    // The series' own guests are on its master.
    const { data: master } = useEvent(
        ownerId,
        event.calendarId,
        open && isSeriesOccurrence(event) ? event.parentEventId || event.id : null,
    );

    const title = typed.title ?? event.title;
    const description = typed.description ?? event.description ?? '';
    const location = typed.location ?? event.location ?? '';
    const { allDay, startDate, startTime, endDate, endTime, rrule: rruleString } = times;
    // A list the user edited says who is on it, and each guest's reply stays the server's.
    const serverAttendees = event.data?.attendees ?? [];
    const withReplies = (typedGuests: readonly Attendee[] | undefined) =>
        typedGuests?.map(
            (guest) =>
                serverAttendees.find((stored) => stored.email.toLowerCase() === guest.email.toLowerCase()) ?? guest,
        ) ?? serverAttendees;
    const attendees = withReplies(typed.attendees);
    const guestInput = useGuestInput({ attendees, onChange: (value) => edit({ attendees: value }) });
    const isRecurring = !!event.rrule;
    const isPartOfSeries = isSeriesOccurrence(event);
    const isLinkedEvent = isFromOthers(event);
    // An invitation from someone else is read-only except for which calendar holds the copy.
    const canSave = !isLinkedEvent || calendarChanged;

    // A cross-Home move fires deleteEvent's iMIP side effects and leaves the exception children behind, so warn first.
    const crossHomeMove = calendarChanged && !!selectedCal && selectedCal.ownerId !== ownerId;
    const moveLossReasons: string[] = [];
    if (isLinkedEvent) moveLossReasons.push('the invitation link will be removed (the organizer will see a decline)');
    else if (attendees.length) moveLossReasons.push('guests will be notified it was canceled and re-invited');
    if (isRecurring) moveLossReasons.push("modified occurrences of the series won't move");

    const changed =
        title !== event.title ||
        description !== (event.description ?? '') ||
        location !== (event.location ?? '') ||
        timesDiffer(times, fieldTimes(event)) ||
        attendees.length !== serverAttendees.length ||
        attendees.some((guest, index) => guest !== serverAttendees[index]) ||
        selectedCalKey !== currentCalKey ||
        guestInput.hasText;

    // A guest the Save just added is in `typedGuests` before a render puts them in `typed`.
    const write = async (scope: RecurrenceScope, typedGuests: readonly Attendee[] | undefined) => {
        const { start, end } = buildEventTimes(allDay, startDate, endDate, startTime, endTime);
        const savedGuests = withReplies(typedGuests);

        const seriesGuests = (own: readonly Attendee[]) => {
            const emails = (guests: readonly Attendee[]) => new Set(guests.map((guest) => guest.email.toLowerCase()));
            const shown = emails(serverAttendees);
            const listed = emails(savedGuests);
            const owned = emails(own);
            const kept = own.filter(({ email }) => !shown.has(email.toLowerCase()) || listed.has(email.toLowerCase()));
            const joined = savedGuests.filter(
                ({ email }) => !shown.has(email.toLowerCase()) && !owned.has(email.toLowerCase()),
            );
            return [...kept, ...joined];
        };
        const edited = {
            title: title.trim(),
            description: description.trim() || null,
            location: location.trim() || null,
            allDay,
            startTime: start,
            endTime: end,
            rrule: rruleString,
            timezone: allDay ? null : (event.timezone ?? viewerTimeZone()),
            data: { ...event.data, attendees: savedGuests },
        };
        // The series' guests are its own list plus or minus the guests changed here, so one this date leaves out stays.
        const seriesData =
            master && typedGuests ? { attendees: seriesGuests(master.data?.attendees ?? []) } : undefined;
        const occurrenceSave = { occurrence: event, edited, seriesData };

        const targetId = event.parentEventId || event.id;

        if (!calendarChanged || !selectedCal) {
            await saveOccurrence({ ...occurrenceSave, scope });
        } else if (selectedCal.ownerId === ownerId) {
            // The server-owned move carries the exception children and the organizer link, and fires no decline.
            const updated = await saveOccurrence({ ...occurrenceSave, scope: 'all' });
            holdEtag(updated.etag);
            await moveEvent.mutateAsync({
                calendarId: event.calendarId,
                id: targetId,
                targetCalendarId: selectedCal.id,
                etag: updated.etag,
            });
        } else {
            // Two Homes have no atomic move. The event is recreated, then deleted, and the organizer link and the
            // overrides stay behind. An override is copied as one event, without a rule.
            await createEvent.mutateAsync({
                calendarId: selectedCal.id,
                ...edited,
                rrule: event.parentEventId ? undefined : rruleString,
            });
            await deleteEventOnSource.mutateAsync({
                id: targetId,
                calendarId: event.calendarId,
                etag: heldEtag,
            });
        }
    };

    // A cross-home copy made by a form already behind the event would only stand beside the original.
    const save = async (scope: RecurrenceScope, typedGuests = typed.attendees): Promise<false | undefined> => {
        if (crossHomeMove && heldEtag !== event.etag) {
            refuseStaleEvent();
            refuse();
            return false;
        }
        await saveHeld(() => write(scope, typedGuests));
    };

    // Edit event is hidden while the recurring choice or the move warning is up, so their save closes it too.
    const saveAndClose = async (scope: RecurrenceScope) => {
        if ((await save(scope)) !== false) onOpenChange(false);
    };

    return (
        <>
            <FormDialog
                open={open && !showRecurringDialog && !showMoveConfirm}
                onOpenChange={onOpenChange}
                title="Edit event"
            >
                {isPartOfSeries && !master ? (
                    <LoadingState />
                ) : (
                    <FormDialogForm
                        changed={changed}
                        submitLabel="Save"
                        readOnly={!canSave}
                        onSubmit={async () => {
                            const guests = guestInput.commitGuests();
                            // An invitation's title is the organizer's, so its copy moves whatever the title holds.
                            if ((!isLinkedEvent && !title.trim()) || guests === false) return false;
                            if (crossHomeMove && moveLossReasons.length > 0) {
                                setShowMoveConfirm(true);
                                return false;
                            }
                            if (isPartOfSeries && !calendarChanged) {
                                setShowRecurringDialog(true);
                                return false;
                            }
                            return save('all', guests);
                        }}
                    >
                        {isLinkedEvent && (
                            <p className="text-xs text-muted-foreground">
                                You were invited to this event. Only the organizer can change its details.
                            </p>
                        )}

                        <EventFormFields
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
                                                input={guestInput}
                                            />
                                        </div>
                                    </div>
                                )
                            }
                        />
                    </FormDialogForm>
                )}
            </FormDialog>

            <RecurringActionDialog
                open={showRecurringDialog}
                onOpenChange={setShowRecurringDialog}
                title="Edit recurring event"
                onConfirm={saveAndClose}
                options={occurrenceScopes(event)}
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
function fieldTimes(event: CalendarEventOccurrence): EventFieldTimes {
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
