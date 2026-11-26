// The detail column that opens at the right when you click an event in a calendar view, such as the week grid. It shows
// the event's time, place, guests and calendar, and a guest of an invitation can reply to it here. Its bar edits,
// deletes or exports the event, and a delete or a reply on a repeating event first asks which occurrences it applies
// to. A save or a reply keeps the column open on the event as saved; a delete closes it. The view route mounts it for
// the event its URL names.

import { useAuth, useIsGuest } from '@workspace/lib/auth';
import {
    isSeriesOccurrence,
    isTransferableCalendarHome,
    occurrenceScopes,
    truncateRRule,
    useCreateEvent,
    useDeleteEvent,
    useExportCalendar,
    useIsInvitationFromOthers,
    useRsvp,
    useSharedCalendarLabel,
    useUpdateEvent,
} from '@workspace/lib/calendar';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    RecurrenceScope,
    RsvpStatus,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { RECURRENCE_SCOPES } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { EventDetailCard } from '@workspace/ui/components/calendar';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { ProgressDialog } from '@workspace/ui/components/drive';
import { DetailColumn, DetailSection } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserName } from '@workspace/ui/components/user';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { Calendar, Check, Download, HelpCircle, Pencil, Trash2, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EditEventDialog } from './edit-event-dialog';
import type { EventSave } from './hooks/use-event-detail-state';
import { RecurringActionDialog } from './recurring-action-dialog';

// The replies to an invitation, in the order the column shows them.
const RSVP_CHOICES = [
    { status: 'accepted', icon: Check, label: 'Accept' },
    { status: 'tentative', icon: HelpCircle, label: 'Maybe' },
    { status: 'declined', icon: XIcon, label: 'Decline' },
] as const;

type EventDetailProps = {
    event: CalendarEventOccurrence;
    calendar: CalendarItem | null;
    sharedCalendar: SharedCalendar | null;
    // The Home the event is saved in: the viewer's, or the owner's of the calendar shared with them.
    ownerId: string;
    onClose: () => void;
    onSaved: (save: EventSave) => void;
};

export function EventDetail({ event, calendar, sharedCalendar, ownerId, onClose, onSaved }: EventDetailProps) {
    const { user } = useAuth();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showRecurringDeleteDialog, setShowRecurringDeleteDialog] = useState(false);
    const [showRsvpScopeDialog, setShowRsvpScopeDialog] = useState(false);
    const [rsvpAwaitingScope, setRsvpAwaitingScope] = useState<RsvpStatus | null>(null);
    const [sentRsvpStatus, setSentRsvpStatus] = useState<RsvpStatus>();
    const { pending: replying, run: runReply } = useDialogPending();
    const [editOpen, setEditOpen] = useState(false);
    // Each opening mounts Edit event anew, so nothing typed in the last one comes back.
    const [editMount, setEditMount] = useState(0);
    const deleteEvent = useDeleteEvent(ownerId);
    const createEvent = useCreateEvent(ownerId);
    const updateEvent = useUpdateEvent(ownerId);
    const rsvp = useRsvp(user?.id || '');
    const { exportCalendar, isExporting } = useExportCalendar();
    const isGuest = useIsGuest();
    const sharedCalendars = useMemo(() => (sharedCalendar ? [sharedCalendar] : []), [sharedCalendar]);
    const sharedCalendarLabel = useSharedCalendarLabel(sharedCalendars);
    const isFromOthers = useIsInvitationFromOthers(ownerId);

    const isException = !!event.parentEventId;
    const isPartOfSeries = isSeriesOccurrence(event);
    const calendarName = calendar?.name || (sharedCalendar ? sharedCalendarLabel(sharedCalendar) : null);
    const canEdit = !sharedCalendar || sharedCalendar.permission === 'write';
    const canExport = !isGuest && isTransferableCalendarHome(ownerId, user?.id ?? '');
    const isLinkedEvent = isFromOthers(event);
    const attendees = event.data?.attendees ?? [];
    const myAttendeeStatus = attendees.find((a) => a.email.toLowerCase() === user?.email?.toLowerCase())?.status;

    const handleRecurringDelete = async (scope: RecurrenceScope) => {
        if (isLinkedEvent && isPartOfSeries) {
            const eventId = event.parentEventId || event.id;
            if (scope === 'all') {
                await deleteEvent.mutateAsync({ id: eventId, calendarId: event.calendarId, etag: event.etag });
            } else {
                await rsvp.mutateAsync({
                    calendarId: event.calendarId,
                    eventId,
                    status: 'declined',
                    scope,
                    recurrenceDate: event.occurrenceDate,
                    remove: true,
                });
            }
        } else if (scope === 'this') {
            if (isException) {
                await updateEvent.mutateAsync({
                    id: event.id,
                    calendarId: event.calendarId,
                    etag: event.etag,
                    status: 'cancelled',
                });
            } else {
                await createEvent.mutateAsync({
                    calendarId: event.calendarId,
                    title: event.title,
                    startTime: event.startTime,
                    endTime: event.endTime,
                    allDay: event.allDay,
                    parentEventId: event.id,
                    recurrenceDate: event.occurrenceDate,
                    status: 'cancelled',
                    etag: event.etag,
                });
            }
        } else if (scope === 'this-and-following') {
            if (event.rrule) {
                const truncated = truncateRRule(event.rrule, event.occurrenceDate, event);
                await updateEvent.mutateAsync({
                    id: event.id,
                    calendarId: event.calendarId,
                    etag: event.etag,
                    rrule: truncated,
                });
            }
        } else {
            await deleteEvent.mutateAsync({
                id: event.parentEventId || event.id,
                calendarId: event.calendarId,
                etag: event.etag,
            });
        }
        // The column closes only after the delete is done. If it fails, the confirm dialog stays open for a retry.
        onClose();
    };

    const handleNonRecurringDelete = async () => {
        await deleteEvent.mutateAsync({ id: event.id, calendarId: event.calendarId, etag: event.etag });
        onClose();
    };

    const handleRsvpScopeConfirm = async (scope: RecurrenceScope) => {
        if (!rsvpAwaitingScope) return;
        const eventId = event.parentEventId || event.id;
        if (scope === 'this') {
            await rsvp.mutateAsync({
                calendarId: event.calendarId,
                eventId,
                status: rsvpAwaitingScope,
                scope: 'this',
                recurrenceDate: event.occurrenceDate,
            });
        } else {
            await rsvp.mutateAsync({ calendarId: event.calendarId, eventId, status: rsvpAwaitingScope });
        }
        setRsvpAwaitingScope(null);
    };

    const handleRsvp = (status: RsvpStatus) => {
        if (isPartOfSeries) {
            setRsvpAwaitingScope(status);
            setShowRsvpScopeDialog(true);
            return;
        }
        setSentRsvpStatus(status);
        void runReply(async () => {
            await rsvp.mutateAsync({ calendarId: event.calendarId, eventId: event.id, status });
        });
    };

    return (
        <>
            <DetailColumn
                width="medium"
                onClose={onClose}
                actions={
                    <>
                        {canEdit && (
                            <>
                                <TooltipButton
                                    icon={Pencil}
                                    tooltipText="Edit event"
                                    onClick={() => {
                                        setEditMount((mount) => mount + 1);
                                        setEditOpen(true);
                                    }}
                                />
                                <TooltipButton
                                    icon={Trash2}
                                    tooltipText="Delete event"
                                    onClick={() =>
                                        isPartOfSeries ? setShowRecurringDeleteDialog(true) : setShowDeleteDialog(true)
                                    }
                                />
                            </>
                        )}
                        {canExport && (
                            <TooltipButton
                                icon={Download}
                                tooltipText="Export event"
                                disabled={isExporting}
                                // An occurrence is drawn from its series, so the series is what leaves.
                                onClick={() =>
                                    void exportCalendar(ownerId, event.calendarId, [event.parentEventId || event.id])
                                }
                            />
                        )}
                    </>
                }
            >
                <EventDetailCard
                    title={event.title}
                    status={event.status}
                    start={event.startTime}
                    end={event.endTime}
                    allDay={event.allDay}
                    timezone={event.timezone}
                    rrule={event.rrule}
                    location={event.location}
                    description={event.description}
                    organizer={event.data?.organizer}
                    attendees={attendees}
                    meta={
                        calendarName && (
                            <span className="flex min-w-0 items-center gap-1.5">
                                <Calendar className="h-3 w-3 shrink-0" />
                                <span className="min-w-0 truncate">
                                    {calendarName}
                                    {sharedCalendar && !isLinkedEvent && (
                                        <>
                                            {' '}
                                            · Created by <UserName userId={event.createByUserId || undefined} />
                                        </>
                                    )}
                                </span>
                            </span>
                        )
                    }
                >
                    {isLinkedEvent && myAttendeeStatus && (
                        <DetailSection label="RSVP">
                            <div className="flex gap-2">
                                {RSVP_CHOICES.map(({ status, icon: Icon, label }) => (
                                    <Button
                                        key={status}
                                        size="sm"
                                        variant={myAttendeeStatus === status ? 'default' : 'outline'}
                                        pending={replying && sentRsvpStatus === status}
                                        disabled={replying && sentRsvpStatus !== status}
                                        onClick={() => handleRsvp(status)}
                                        className="gap-1"
                                    >
                                        <Icon className="h-3 w-3" /> {label}
                                    </Button>
                                ))}
                            </div>
                        </DetailSection>
                    )}
                </EventDetailCard>
            </DetailColumn>

            <ConfirmDialog
                open={showDeleteDialog}
                onOpenChange={setShowDeleteDialog}
                title="Delete event"
                description={
                    <>
                        Are you sure you want to delete <strong>{event.title}</strong>?
                    </>
                }
                onConfirm={handleNonRecurringDelete}
                confirmText="Delete"
                destructive
            />

            <RecurringActionDialog
                open={showRecurringDeleteDialog}
                onOpenChange={setShowRecurringDeleteDialog}
                title="Delete recurring event"
                onConfirm={handleRecurringDelete}
                // An invitation's this and following goes to the series on the server, so even a changed date offers it.
                options={isLinkedEvent ? RECURRENCE_SCOPES : occurrenceScopes(event)}
            />

            <RecurringActionDialog
                open={showRsvpScopeDialog}
                onOpenChange={setShowRsvpScopeDialog}
                title="RSVP for recurring event"
                onConfirm={handleRsvpScopeConfirm}
                options={['this', 'all']}
            />

            <EditEventDialog
                key={editMount}
                open={editOpen}
                onOpenChange={setEditOpen}
                event={event}
                ownerId={ownerId}
                onSaved={onSaved}
            />

            <ProgressDialog open={isExporting} title="Exporting event" />
        </>
    );
}
