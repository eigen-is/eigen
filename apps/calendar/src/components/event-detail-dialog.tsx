// The panel that opens when you click an event in a calendar view, such as the month view. It shows the event's time,
// place, guests and calendar. A guest of an invitation can reply to it here. Its buttons edit, delete or export the
// event, and a delete or a reply on a repeating event first asks which occurrences it applies to.

import { useAuth, useIsGuest } from '@workspace/lib/auth';
import {
    getCalendarColor,
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
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { RECURRENCE_SCOPES } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { EventDetailCard } from '@workspace/ui/components/calendar';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { ProgressDialog } from '@workspace/ui/components/drive';
import { DetailSection } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserName } from '@workspace/ui/components/user';
import { Calendar, Check, Download, HelpCircle, Pencil, Trash2, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EditEventDialog } from './edit-event-dialog';
import { RecurringActionDialog } from './recurring-action-dialog';

// The replies to an invitation, in the order the panel shows them.
const RSVP_CHOICES = [
    { status: 'accepted', icon: Check, label: 'Accept' },
    { status: 'tentative', icon: HelpCircle, label: 'Maybe' },
    { status: 'declined', icon: XIcon, label: 'Decline' },
] as const;

type EventDetailDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    calendar?: CalendarItem | null;
    sharedCalendar?: SharedCalendar | null;
    // The Home the event is saved in: the viewer's, or the owner's of the calendar shared with them.
    ownerId: string;
};

export function EventDetailDialog({
    open,
    onOpenChange,
    event,
    calendar,
    sharedCalendar,
    ownerId,
}: EventDetailDialogProps) {
    const { user } = useAuth();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showRecurringDeleteDialog, setShowRecurringDeleteDialog] = useState(false);
    const [showRsvpScopeDialog, setShowRsvpScopeDialog] = useState(false);
    const [pendingRsvpStatus, setPendingRsvpStatus] = useState<'accepted' | 'declined' | 'tentative' | null>(null);
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

    if (!event) return null;

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
        // The panel closes only after the delete is done. If it fails, the confirm dialog stays open for a retry.
        onOpenChange(false);
    };

    const handleNonRecurringDelete = async () => {
        await deleteEvent.mutateAsync({ id: event.id, calendarId: event.calendarId, etag: event.etag });
        onOpenChange(false);
    };

    const handleDeleteClick = () => (isPartOfSeries ? setShowRecurringDeleteDialog(true) : setShowDeleteDialog(true));

    const handleRsvpScopeConfirm = (scope: RecurrenceScope) => {
        if (!pendingRsvpStatus) return;
        const eventId = event.parentEventId || event.id;
        if (scope === 'this') {
            rsvp.mutate({
                calendarId: event.calendarId,
                eventId,
                status: pendingRsvpStatus,
                scope: 'this',
                recurrenceDate: event.occurrenceDate,
            });
        } else {
            rsvp.mutate({ calendarId: event.calendarId, eventId, status: pendingRsvpStatus });
        }
        setPendingRsvpStatus(null);
        onOpenChange(false);
    };

    return (
        <>
            <Dialog
                open={open && !showDeleteDialog && !showRecurringDeleteDialog && !editOpen && !showRsvpScopeDialog}
                onOpenChange={onOpenChange}
            >
                <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
                    <DialogHeader>
                        <DialogTitle className="sr-only">{event.title}</DialogTitle>
                        <DialogDescription className="sr-only">
                            Event time, location, guests and details.
                        </DialogDescription>
                    </DialogHeader>

                    <EventDetailCard
                        title={event.title}
                        color={getCalendarColor(event, calendar ? [calendar] : [], sharedCalendars)}
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
                                            onClick={() => {
                                                if (isPartOfSeries) {
                                                    setPendingRsvpStatus(status);
                                                    setShowRsvpScopeDialog(true);
                                                } else {
                                                    rsvp.mutate({
                                                        calendarId: event.calendarId,
                                                        eventId: event.id,
                                                        status,
                                                    });
                                                    onOpenChange(false);
                                                }
                                            }}
                                            className="gap-1"
                                        >
                                            <Icon className="h-3 w-3" /> {label}
                                        </Button>
                                    ))}
                                </div>
                            </DetailSection>
                        )}
                    </EventDetailCard>

                    <DialogFooter
                        start={
                            (canEdit || canExport) && (
                                <div className="flex gap-1">
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
                                                onClick={handleDeleteClick}
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
                                                void exportCalendar(ownerId, event.calendarId, [
                                                    event.parentEventId || event.id,
                                                ])
                                            }
                                        />
                                    )}
                                </div>
                            )
                        }
                    >
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
                onOpenChange={(editing) => {
                    setEditOpen(editing);
                    if (!editing) onOpenChange(false);
                }}
                event={event}
                ownerId={ownerId}
            />

            <ProgressDialog open={isExporting} title="Exporting event" />
        </>
    );
}
