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
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';
import { AlignLeft, Calendar, Clock, MapPin, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AttendeeEditor, AttendeeList } from './attendee-editor';
import type { CalendarOption } from './calendar-utils';
import { resolveCalendarName } from './calendar-utils';
import { RecurrencePicker } from './recurrence-picker';
import type { RecurringAction } from './recurring-action-dialog';
import { RecurringActionDialog } from './recurring-action-dialog';
import { addMinutes, roundToNext15Minutes, TimeSelect, timeToMinutes } from './time-select';

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    ownerUserId?: string;
    calendars?: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
};

function toLocalTimeString(date: Date): string {
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${min}`;
}

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

    const calendarOptions = useMemo(() => {
        const options: CalendarOption[] = calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, ownerId }));
        for (const sc of sharedCalendars) {
            if (sc.permission === 'write') {
                options.push({
                    id: sc.calendarId,
                    name: resolveCalendarName(sc, myTeams),
                    color: sc.color || sc.calendarColor,
                    ownerId: sc.ownerUserId,
                });
            }
        }
        return options;
    }, [calendars, sharedCalendars, ownerId, myTeams]);

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
                setStartTime(toLocalTimeString(event.startTime));
                setEndDate(toLocalDateString(event.endTime));
                setEndTime(toLocalTimeString(event.endTime));
            }
        }
    }, [event, open, calendarOptions, eventOwnerId]);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isLinkedEvent = !!event.data?.organizer;

    const handleSaveClick = () => {
        if (!title.trim()) return;
        if (isRecurring && !calendarChanged) {
            setShowRecurringDialog(true);
        } else {
            doSave('all');
        }
    };

    const doSave = async (action: RecurringAction) => {
        let start: Date;
        let end: Date;

        if (allDay) {
            start = new Date(`${startDate}T00:00:00Z`);
            end = new Date(`${endDate}T00:00:00Z`);
            end.setUTCDate(end.getUTCDate() + 1);
        } else {
            start = new Date(`${startDate}T${startTime}`);
            end = new Date(`${endDate}T${endTime}`);
        }

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
                await createEvent.mutateAsync({ calendarId: selectedCal.id, ...updates });
                await deleteEventOnSource.mutateAsync({ id: targetId, calendarId: event.calendarId });
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

    const handleStartTimeChange = (newStart: string) => {
        setStartTime(newStart);

        const minEnd = addMinutes(newStart, 15);
        const currentEndMinutes = timeToMinutes(endTime);
        const minEndMinutes = timeToMinutes(minEnd);

        if (currentEndMinutes < minEndMinutes) {
            const newEnd = addMinutes(newStart, 30);
            setEndTime(newEnd);
            const wraps = timeToMinutes(newEnd) <= timeToMinutes(newStart);
            const d = new Date(`${startDate}T00:00`);
            if (wraps) d.setDate(d.getDate() + 1);
            setEndDate(toLocalDateString(d));
        }
    };

    const handleEndTimeChange = (newEnd: string, dayOffset: number) => {
        setEndTime(newEnd);
        const d = new Date(`${startDate}T00:00`);
        if (dayOffset > 0) d.setDate(d.getDate() + dayOffset);
        setEndDate(toLocalDateString(d));
    };

    return (
        <>
            <Dialog open={open && !showRecurringDialog} onOpenChange={onOpenChange}>
                <DialogContent size="md">
                    <DialogHeader>
                        <DialogTitle>Edit Event</DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div>
                            <Input
                                placeholder="Event title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                autoFocus
                                className="text-lg border-0 border-b rounded-none px-0 focus-visible:ring-0 focus-visible:border-primary"
                            />
                        </div>

                        <div className="flex items-start gap-3">
                            <Clock className="h-4 w-4 mt-2 text-muted-foreground shrink-0" />
                            <div className="flex-1 space-y-3">
                                {allDay ? (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Input
                                            type="date"
                                            value={startDate}
                                            onChange={(e) => {
                                                setStartDate(e.target.value);
                                                if (endDate < e.target.value) setEndDate(e.target.value);
                                            }}
                                            className="flex-1 min-w-fit h-8 text-sm"
                                        />
                                        <span className="text-muted-foreground text-sm">to</span>
                                        <Input
                                            type="date"
                                            value={endDate}
                                            min={startDate}
                                            onChange={(e) => setEndDate(e.target.value)}
                                            className="flex-1 min-w-fit h-8 text-sm"
                                        />
                                    </div>
                                ) : (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Input
                                            type="date"
                                            value={startDate}
                                            onChange={(e) => {
                                                setStartDate(e.target.value);
                                                setEndDate(e.target.value);
                                            }}
                                            className="h-8 text-sm"
                                        />
                                        <TimeSelect value={startTime} onChange={handleStartTimeChange} />
                                        <span className="text-muted-foreground text-sm">–</span>
                                        <TimeSelect
                                            value={endTime}
                                            onChange={handleEndTimeChange}
                                            referenceTime={startTime}
                                            minTime={addMinutes(startTime, 15)}
                                        />
                                    </div>
                                )}

                                <div className="flex flex-wrap items-center gap-4">
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="edit-all-day"
                                            checked={allDay}
                                            onCheckedChange={(checked) => {
                                                const isAllDay = !!checked;
                                                setAllDay(isAllDay);
                                                if (!isAllDay) {
                                                    const now = roundToNext15Minutes(new Date());
                                                    setStartTime(toLocalTimeString(now));
                                                    setEndTime(addMinutes(toLocalTimeString(now), 30));
                                                }
                                            }}
                                        />
                                        <Label htmlFor="edit-all-day">All day</Label>
                                    </div>
                                    <RecurrencePicker
                                        value={rruleString}
                                        onChange={setRruleString}
                                        startDate={new Date(startDate)}
                                    />
                                    {!allDay && (
                                        <span className="text-xs text-muted-foreground ml-auto">
                                            {(event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
                                                .split('/')
                                                .pop()
                                                ?.replace(/_/g, ' ')}{' '}
                                            time zone
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {isLinkedEvent ? (
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
                        )}

                        <div className="flex items-start gap-3">
                            <MapPin className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                            <Input
                                placeholder="Location"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                className="flex-1"
                            />
                        </div>

                        <div className="flex items-start gap-3">
                            <AlignLeft className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                            <Textarea
                                placeholder="Description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                className="flex-1"
                            />
                        </div>

                        {calendarOptions.length > 1 && (
                            <div className="flex items-center gap-3">
                                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                                <Select value={selectedCalKey} onValueChange={setSelectedCalKey}>
                                    <SelectTrigger className="flex-1">
                                        <SelectValue placeholder="Select calendar" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {calendarOptions.map((cal) => (
                                            <SelectItem
                                                key={`${cal.ownerId}:${cal.id}`}
                                                value={`${cal.ownerId}:${cal.id}`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <div
                                                        className="h-3 w-3 rounded-full shrink-0"
                                                        style={{ backgroundColor: cal.color }}
                                                    />
                                                    {cal.name}
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                    </div>

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
        </>
    );
}
