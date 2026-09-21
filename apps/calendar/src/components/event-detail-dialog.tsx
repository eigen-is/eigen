import { useAuth, useIsGuest } from '@workspace/lib/auth';
import {
    isInvitationFromOthers,
    isSeriesOccurrence,
    isTransferableCalendarHome,
    occurrenceDateToString,
    parseOccurrenceDate,
    truncateRRule,
    useCreateEvent,
    useDeleteEvent,
    useExportCalendar,
    useRsvp,
    useSharedCalendarLabel,
    useUpdateEvent,
} from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { DeleteDialog } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { EventDetailCard } from '@workspace/ui/components/calendar';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { UserName } from '@workspace/ui/components/user';
import { Calendar, Check, Download, HelpCircle, Pencil, Trash2, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EditEventDialog } from './edit-event-dialog';
import type { RecurringAction } from './recurring-action-dialog';
import { RecurringActionDialog } from './recurring-action-dialog';

type EventDetailDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    calendar?: CalendarItem | null;
    sharedCalendar?: SharedCalendar | null;
};

export function EventDetailDialog({ open, onOpenChange, event, calendar, sharedCalendar }: EventDetailDialogProps) {
    const { user } = useAuth();
    const eventOwnerId = sharedCalendar?.ownerUserId || user?.id || '';
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [showRecurringDeleteDialog, setShowRecurringDeleteDialog] = useState(false);
    const [showRsvpScopeDialog, setShowRsvpScopeDialog] = useState(false);
    const [pendingRsvpStatus, setPendingRsvpStatus] = useState<'accepted' | 'declined' | 'tentative' | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const deleteEvent = useDeleteEvent(eventOwnerId);
    const createEvent = useCreateEvent(eventOwnerId);
    const updateEvent = useUpdateEvent(eventOwnerId);
    const rsvp = useRsvp(user?.id || '');
    const { exportCalendar, isExporting } = useExportCalendar();
    const isGuest = useIsGuest();
    const sharedCalendars = useMemo(() => (sharedCalendar ? [sharedCalendar] : []), [sharedCalendar]);
    const sharedCalendarLabel = useSharedCalendarLabel(sharedCalendars);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isException = !!event.parentEventId;
    const isPartOfSeries = isSeriesOccurrence(event);
    const calendarName = calendar?.name || (sharedCalendar ? sharedCalendarLabel(sharedCalendar) : null);
    const isShared = !!sharedCalendar;
    const canEdit = !isShared || sharedCalendar?.permission === 'write';
    const canExport = !isGuest && isTransferableCalendarHome(eventOwnerId, user?.id ?? '');
    // The owner's address is known only when the owner is the viewer; without it an organized event reads as an invitation.
    const isLinkedEvent = isInvitationFromOthers(event, eventOwnerId === user?.id ? user.email : undefined);
    const myAttendeeStatus = event.data?.attendees?.find(
        (a) => a.email.toLowerCase() === user?.email?.toLowerCase(),
    )?.status;
    const attendees = event.data?.attendees ?? [];

    const handleDelete = async (action: RecurringAction) => {
        if (isLinkedEvent && isPartOfSeries) {
            const eventId = event.parentEventId || event.id;
            if (action === 'this') {
                await rsvp.mutateAsync({
                    calendarId: event.calendarId,
                    eventId,
                    status: 'declined',
                    scope: 'this',
                    recurrenceDate: occurrenceDateToString(event.occurrenceDate),
                    remove: true,
                });
            } else if (action === 'this-and-following') {
                await rsvp.mutateAsync({
                    calendarId: event.calendarId,
                    eventId,
                    status: 'declined',
                    scope: 'this-and-following',
                    recurrenceDate: occurrenceDateToString(event.occurrenceDate),
                    remove: true,
                });
            } else {
                await deleteEvent.mutateAsync({ id: eventId, calendarId: event.calendarId });
            }
        } else {
            if (action === 'this') {
                if (isException) {
                    await updateEvent.mutateAsync({
                        id: event.id,
                        calendarId: event.calendarId,
                        status: 'cancelled',
                    });
                } else if (isRecurring) {
                    await createEvent.mutateAsync({
                        calendarId: event.calendarId,
                        title: event.title,
                        startTime: event.startTime,
                        endTime: event.endTime,
                        allDay: Boolean(event.allDay),
                        parentEventId: event.id,
                        recurrenceDate: occurrenceDateToString(event.occurrenceDate),
                        status: 'cancelled',
                    });
                } else {
                    await deleteEvent.mutateAsync({ id: event.id, calendarId: event.calendarId });
                }
            } else if (action === 'this-and-following') {
                const parentId = event.parentEventId || event.id;
                const occDate = parseOccurrenceDate(event.occurrenceDate);
                const rrule = event.rrule || (isException && event.parentEventId ? null : null);
                if (rrule) {
                    const truncated = truncateRRule(rrule, occDate);
                    await updateEvent.mutateAsync({ id: parentId, calendarId: event.calendarId, rrule: truncated });
                }
            } else if (action === 'all') {
                const targetId = event.parentEventId || event.id;
                await deleteEvent.mutateAsync({ id: targetId, calendarId: event.calendarId });
            }
        }
        // Closing only after the await keeps the nested confirm dialog alive for a retry when the delete rejects.
        onOpenChange(false);
    };

    const handleNonRecurringDelete = async () => {
        await deleteEvent.mutateAsync({ id: event.id, calendarId: event.calendarId });
        onOpenChange(false);
    };

    const handleDeleteClick = () => {
        if (isPartOfSeries) {
            setShowRecurringDeleteDialog(true);
        } else {
            setShowDeleteDialog(true);
        }
    };

    const handleRsvpScopeConfirm = (action: RecurringAction) => {
        if (!pendingRsvpStatus) return;
        const eventId = event.parentEventId || event.id;
        if (action === 'this') {
            rsvp.mutate({
                calendarId: event.calendarId,
                eventId,
                status: pendingRsvpStatus,
                scope: 'this',
                recurrenceDate: occurrenceDateToString(event.occurrenceDate),
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
                <DialogContent size="md" onOpenAutoFocus={(e) => e.preventDefault()}>
                    <DialogHeader>
                        <DialogTitle className="text-xl">{event.title}</DialogTitle>
                        <DialogDescription className="sr-only">
                            Event time, location, guests and details.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        {/* The title is the dialog's own header, so the card draws everything but it. */}
                        <EventDetailCard
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
                        />

                        {isLinkedEvent && myAttendeeStatus && (
                            <div className="pt-3 mt-3 border-t">
                                <div className="text-sm font-medium mb-2">RSVP</div>
                                <div className="flex gap-2">
                                    {(['accepted', 'tentative', 'declined'] as const).map((status) => (
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
                                            {status === 'accepted' && (
                                                <>
                                                    <Check className="h-3 w-3" /> Accept
                                                </>
                                            )}
                                            {status === 'tentative' && (
                                                <>
                                                    <HelpCircle className="h-3 w-3" /> Maybe
                                                </>
                                            )}
                                            {status === 'declined' && (
                                                <>
                                                    <XIcon className="h-3 w-3" /> Decline
                                                </>
                                            )}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {calendarName && (
                            <div className="pt-3 mt-3 border-t flex items-start gap-3">
                                <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                <div className="text-sm text-muted-foreground">
                                    {calendarName}
                                    {isShared && sharedCalendar && !isLinkedEvent && (
                                        <div className="text-xs">
                                            Created by: <UserName userId={event.createByUserId || undefined} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        {(canEdit || canExport) && (
                            <div className="flex gap-1 mr-auto">
                                {canEdit && (
                                    <>
                                        <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)}>
                                            <Pencil className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={handleDeleteClick}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </>
                                )}
                                {canExport && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        title="Export event"
                                        aria-label="Export event"
                                        disabled={isExporting}
                                        // An occurrence is drawn from its series, so the series is what leaves.
                                        onClick={() =>
                                            void exportCalendar(eventOwnerId, event.calendarId, [
                                                event.parentEventId || event.id,
                                            ])
                                        }
                                    >
                                        <Download className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        )}
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteDialog
                open={showDeleteDialog}
                onOpenChange={setShowDeleteDialog}
                title="Delete Event"
                description="Are you sure you want to delete this event?"
                itemName={event.title}
                onDelete={handleNonRecurringDelete}
            />

            <RecurringActionDialog
                open={showRecurringDeleteDialog}
                onOpenChange={setShowRecurringDeleteDialog}
                title="Delete recurring event"
                onConfirm={handleDelete}
            />

            <RecurringActionDialog
                open={showRsvpScopeDialog}
                onOpenChange={setShowRsvpScopeDialog}
                title="RSVP for recurring event"
                onConfirm={handleRsvpScopeConfirm}
                options={['this', 'all']}
            />

            <EditEventDialog
                open={editOpen}
                onOpenChange={(o: boolean) => {
                    setEditOpen(o);
                    if (!o) onOpenChange(false);
                }}
                event={event}
                ownerUserId={sharedCalendar?.ownerUserId}
            />
        </>
    );
}
