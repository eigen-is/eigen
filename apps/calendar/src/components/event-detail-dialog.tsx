import {useState} from 'react';
import {Clock, MapPin, AlignLeft, Repeat, Trash2, Pencil} from 'lucide-react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '@workspace/ui/components/dropdown-menu';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {useDeleteEvent, useCreateEvent} from '@workspace/lib/calendar';
import type {CalendarEventOccurrence, CalendarItem} from '@workspace/lib/types/calendar';
import {rruleToText} from './recurrence-picker';
import {EditEventDialog} from './edit-event-dialog';

type EventDetailDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    calendar?: CalendarItem | null;
}

function formatTime(timestamp: number, allDay: boolean): string {
    if (allDay) {
        return new Date(timestamp * 1000).toLocaleDateString('en', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
        });
    }
    return new Date(timestamp * 1000).toLocaleString('en', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatTimeRange(event: CalendarEventOccurrence): string {
    if (event.allDay) {
        const start = formatTime(event.startTime, true);
        const endDate = new Date((event.endTime - 86400) * 1000);
        const startDate = new Date(event.startTime * 1000);
        if (startDate.toDateString() === endDate.toDateString()) {
            return start;
        }
        return `${start} — ${formatTime(event.endTime - 86400, true)}`;
    }
    const startStr = new Date(event.startTime * 1000).toLocaleString('en', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    });
    const startTime = new Date(event.startTime * 1000).toLocaleTimeString('en', {
        hour: '2-digit',
        minute: '2-digit',
    });
    const endTime = new Date(event.endTime * 1000).toLocaleTimeString('en', {
        hour: '2-digit',
        minute: '2-digit',
    });
    return `${startStr} · ${startTime} – ${endTime}`;
}

export function EventDetailDialog({open, onOpenChange, event, calendar}: EventDetailDialogProps) {
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const deleteEvent = useDeleteEvent();
    const createEvent = useCreateEvent();

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isException = !!event.parentEventId;
    const color = calendar?.color || '#4285f4';

    const handleDeleteSingle = async () => {
        if (isRecurring && !isException) {
            await createEvent.mutateAsync({
                calendarId: event.calendarId,
                title: event.title,
                startTime: event.startTime,
                endTime: event.endTime,
                allDay: event.allDay,
                parentEventId: event.id,
                recurrenceDate: event.occurrenceDate,
                status: 'cancelled',
            });
        } else {
            await deleteEvent.mutateAsync(event.id);
        }
        setShowDeleteDialog(false);
        onOpenChange(false);
    };

    const handleDeleteAll = async () => {
        if (isException && event.parentEventId) {
            await deleteEvent.mutateAsync(event.parentEventId);
        } else {
            await deleteEvent.mutateAsync(event.id);
        }
        setShowDeleteDialog(false);
        onOpenChange(false);
    };

    const recurrenceText = event.rrule ? rruleToText(event.rrule) : null;

    return (
        <>
            <Dialog open={open && !showDeleteDialog && !editOpen} onOpenChange={onOpenChange}>
                <DialogContent className="sm:max-w-[450px]">
                    <DialogHeader>
                        <div className="flex items-start gap-3">
                            <div className="h-4 w-4 rounded-full mt-1 shrink-0" style={{backgroundColor: color}}/>
                            <DialogTitle className="text-xl">{event.title}</DialogTitle>
                        </div>
                    </DialogHeader>

                    <div className="space-y-3">
                        <div className="flex items-start gap-3 text-sm">
                            <Clock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0"/>
                            <span>{formatTimeRange(event)}</span>
                        </div>

                        {recurrenceText && (
                            <div className="flex items-start gap-3 text-sm">
                                <Repeat className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0"/>
                                <span className="capitalize">{recurrenceText}</span>
                            </div>
                        )}

                        {event.location && (
                            <div className="flex items-start gap-3 text-sm">
                                <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0"/>
                                <span>{event.location}</span>
                            </div>
                        )}

                        {event.description && (
                            <div className="flex items-start gap-3 text-sm">
                                <AlignLeft className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0"/>
                                <span className="whitespace-pre-wrap">{event.description}</span>
                            </div>
                        )}

                        {calendar && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2 border-t">
                                <div className="h-3 w-3 rounded-full" style={{backgroundColor: color}}/>
                                <span>{calendar.name}</span>
                            </div>
                        )}
                    </div>

                    <DialogFooter className="flex justify-between">
                        <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setEditOpen(true)}>
                                <Pencil className="h-4 w-4"/>
                            </Button>
                            {isRecurring ? (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon">
                                            <Trash2 className="h-4 w-4"/>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                        <DropdownMenuItem onClick={handleDeleteSingle}>
                                            Delete this event
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setShowDeleteDialog(true)}>
                                            Delete all events in series
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            ) : (
                                <Button variant="ghost" size="icon" onClick={() => setShowDeleteDialog(true)}>
                                    <Trash2 className="h-4 w-4"/>
                                </Button>
                            )}
                        </div>
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
                onDelete={isRecurring && !isException ? handleDeleteAll : handleDeleteSingle}
            />

            <EditEventDialog
                open={editOpen}
                onOpenChange={(o) => {
                    setEditOpen(o);
                    if (!o) onOpenChange(false);
                }}
                event={event}
            />
        </>
    );
}
