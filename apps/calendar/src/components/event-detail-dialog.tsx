import { useAuth } from '@workspace/lib/auth';
import {
    isInvitationFromOthers,
    occurrenceDateToString,
    parseOccurrenceDate,
    truncateRRule,
    useCreateEvent,
    useDeleteEvent,
    useRsvp,
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
import { Calendar, Check, HelpCircle, Pencil, Trash2, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSharedCalendarLabel } from './calendar-utils';
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
    const [showRecurringDeleteConfirm, setShowRecurringDeleteConfirm] = useState(false);
    const [pendingDeleteAction, setPendingDeleteAction] = useState<RecurringAction | null>(null);
    const [showRsvpScopeDialog, setShowRsvpScopeDialog] = useState(false);
    const [pendingRsvpStatus, setPendingRsvpStatus] = useState<'accepted' | 'declined' | 'tentative' | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const deleteEvent = useDeleteEvent(eventOwnerId);
    const createEvent = useCreateEvent(eventOwnerId);
    const updateEvent = useUpdateEvent(eventOwnerId);
    const rsvp = useRsvp(user?.id || '');
    const sharedCalendars = useMemo(() => (sharedCalendar ? [sharedCalendar] : []), [sharedCalendar]);
    const sharedCalendarLabel = useSharedCalendarLabel(sharedCalendars);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isException = !!event.parentEventId;
    const isPartOfSeries = isRecurring || isException;
    const calendarName = calendar?.name || (sharedCalendar ? sharedCalendarLabel(sharedCalendar) : null);
    const isShared = !!sharedCalendar;
    const canEdit = !isShared || sharedCalendar?.permission === 'write';
    // An ORGANIZER equal to the calendar owner is an event they organize, not an invitation to them;
    // the owner's address is known only when the owner is the viewer.
    const isLinkedEvent = isInvitationFromOthers(event, {
        email: eventOwnerId === user?.id ? user.email : undefined,
    });
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
        // Close the detail view only after the awaited work resolves (matching handleNonRecurringDelete):
        // on rejection the nested confirm DeleteDialog stays open for retry instead of being torn down.
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

    const handleRecurringDeleteAction = (action: RecurringAction) => {
        setPendingDeleteAction(action);
        setShowRecurringDeleteDialog(false);
        setShowRecurringDeleteConfirm(true);
    };

    const handleRecurringDeleteConfirm = async () => {
        if (pendingDeleteAction) {
            await handleDelete(pendingDeleteAction);
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
                open={
                    open &&
                    !showDeleteDialog &&
                    !showRecurringDeleteDialog &&
                    !showRecurringDeleteConfirm &&
                    !editOpen &&
                    !showRsvpScopeDialog
                }
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
                        {canEdit && (
                            <div className="flex gap-1 mr-auto">
                                <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)}>
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="icon" onClick={handleDeleteClick}>
                                    <Trash2 className="h-4 w-4" />
                                </Button>
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
                onConfirm={handleRecurringDeleteAction}
            />

            <DeleteDialog
                open={showRecurringDeleteConfirm}
                onOpenChange={(o) => {
                    setShowRecurringDeleteConfirm(o);
                    if (!o) setPendingDeleteAction(null);
                }}
                title="Delete Event"
                description="Are you sure you want to delete this event?"
                itemName={event.title}
                onDelete={handleRecurringDeleteConfirm}
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
