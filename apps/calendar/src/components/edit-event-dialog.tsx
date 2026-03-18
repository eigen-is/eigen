import {useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';
import {AlignLeft, Calendar, Clock, MapPin, UsersRound} from 'lucide-react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Textarea} from '@workspace/ui/components/textarea';
import {Label} from '@workspace/ui/components/label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {
    useCalendars,
    useCreateEvent,
    useDeleteEvent,
    useSharedCalendars,
    useUpdateEvent
} from '@workspace/lib/calendar';
import {useAuth} from '@workspace/lib/auth';
import type {Attendee, CalendarEventOccurrence, CalendarItem, SharedCalendar} from '@workspace/lib/types/calendar';
import {RRule} from 'rrule';
import {RecurrencePicker} from './recurrence-picker';
import {addMinutes, roundToNext15Minutes, TimeSelect} from './time-select';
import type {RecurringAction} from './recurring-action-dialog';
import {RecurringActionDialog} from './recurring-action-dialog';
import {occurrenceDateToString, parseOccurrenceDate} from './calendar-utils';
import {AttendeeEditor} from './attendee-editor';

type CalendarOption = {
    id: string;
    name: string;
    color: string;
    ownerId: string;
}

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    ownerUserId?: string;
    calendars?: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
}

function toLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function toLocalTimeString(date: Date): string {
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${min}`;
}

function truncateRRule(rruleStr: string, beforeDate: Date): string {
    const options = RRule.parseString(rruleStr);
    const until = new Date(beforeDate);
    until.setUTCDate(until.getUTCDate() - 1);
    until.setUTCHours(23, 59, 59, 0);
    options.until = until;
    delete options.count;
    const result = new RRule(options).toString();
    return result.replace(/^RRULE:/, '');
}

export function EditEventDialog({open, onOpenChange, event, ownerUserId, calendars: calendarsProp, sharedCalendars: sharedCalendarsProp}: EditEventDialogProps) {
    const {user} = useAuth();
    const ownerId = user?.id || '';
    const eventOwnerId = ownerUserId || ownerId;

    const {data: fetchedCalendars = []} = useCalendars(ownerId);
    const {data: fetchedSharedCalendars = []} = useSharedCalendars(ownerId);
    const calendars = calendarsProp || fetchedCalendars;
    const sharedCalendars = sharedCalendarsProp || fetchedSharedCalendars;

    const calendarOptions = useMemo(() => {
        const options: CalendarOption[] = calendars.map(c => ({id: c.id, name: c.name, color: c.color, ownerId}));
        for (const sc of sharedCalendars) {
            if (sc.permission === 'write') {
                options.push({id: sc.calendarId, name: sc.calendarName, color: sc.color || sc.calendarColor, ownerId: sc.ownerUserId});
            }
        }
        return options;
    }, [calendars, sharedCalendars, ownerId]);

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
    const [isLoading, setIsLoading] = useState(false);
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);

    const selectedCal = calendarOptions.find(c => `${c.ownerId}:${c.id}` === selectedCalKey);
    const calendarChanged = event ? (selectedCal?.id !== event.calendarId || selectedCal?.ownerId !== eventOwnerId) : false;

    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(selectedCal?.ownerId || eventOwnerId);
    const deleteEventOnSource = useDeleteEvent(eventOwnerId);

    useEffect(() => {
        if (event && open) {
            setTitle(event.title);
            setDescription(event.description || '');
            setLocation(event.location || '');
            setAllDay(event.allDay);
            setRruleString(event.rrule);
            setAttendees(event.data?.attendees || []);

            const currentCal = calendarOptions.find(c => c.id === event.calendarId && c.ownerId === eventOwnerId);
            setSelectedCalKey(currentCal ? `${currentCal.ownerId}:${currentCal.id}` : calendarOptions[0] ? `${calendarOptions[0].ownerId}:${calendarOptions[0].id}` : '');

            if (event.allDay) {
                const sd = new Date(event.startTime * 1000);
                const ed = new Date((event.endTime - 86400) * 1000);
                setStartDate(toLocalDateString(new Date(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate())));
                setEndDate(toLocalDateString(new Date(ed.getUTCFullYear(), ed.getUTCMonth(), ed.getUTCDate())));
                setStartTime('00:00');
                setEndTime('00:00');
            } else {
                const sd = new Date(event.startTime * 1000);
                const ed = new Date(event.endTime * 1000);
                setStartDate(toLocalDateString(sd));
                setStartTime(toLocalTimeString(sd));
                setEndDate(toLocalDateString(ed));
                setEndTime(toLocalTimeString(ed));
            }
        }
    }, [event, open, calendarOptions, eventOwnerId]);

    if (!event) return null;

    const isRecurring = !!event.rrule;
    const isLinkedEvent = !!event.data?.organizer;

    const buildTimestamps = () => {
        let startTimestamp: number;
        let endTimestamp: number;

        if (allDay) {
            const sd = new Date(startDate + 'T00:00:00Z');
            const ed = new Date(endDate + 'T00:00:00Z');
            ed.setUTCDate(ed.getUTCDate() + 1);
            startTimestamp = Math.floor(sd.getTime() / 1000);
            endTimestamp = Math.floor(ed.getTime() / 1000);
        } else {
            const sd = new Date(`${startDate}T${startTime}`);
            const ed = new Date(`${endDate}T${endTime}`);
            startTimestamp = Math.floor(sd.getTime() / 1000);
            endTimestamp = Math.floor(ed.getTime() / 1000);
        }
        return {startTimestamp, endTimestamp};
    };

    const handleSaveClick = () => {
        if (!title.trim()) return;
        if (isRecurring && !calendarChanged) {
            setShowRecurringDialog(true);
        } else {
            doSave('all');
        }
    };

    const moveEvent = async (updates: Record<string, any>) => {
        if (!selectedCal) return;
        await createEvent.mutateAsync({
            calendarId: selectedCal.id,
            title: updates.title,
            startTime: updates.startTime,
            endTime: updates.endTime,
            allDay: Boolean(updates.allDay),
            description: updates.description,
            location: updates.location,
            rrule: updates.rrule,
        });
        await deleteEventOnSource.mutateAsync({id: event.parentEventId || event.id, calendarId: event.calendarId});
    };

    const doSave = async (action: RecurringAction) => {
        setIsLoading(true);
        try {
            const {startTimestamp, endTimestamp} = buildTimestamps();
            const data = {...event.data, attendees: attendees.length > 0 ? attendees : undefined};
            const timezone = allDay ? null : (event.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
            const updates = {
                title: title.trim(),
                startTime: startTimestamp,
                endTime: endTimestamp,
                allDay,
                description: description.trim() || null,
                location: location.trim() || null,
                rrule: rruleString,
                timezone,
                data: Object.values(data).some(v => v !== undefined) ? data : null,
            };

            if (calendarChanged) {
                await moveEvent(updates);
            } else if (action === 'all') {
                const targetId = event.parentEventId || event.id;
                await updateEvent.mutateAsync({id: targetId, calendarId: event.calendarId, ...updates});
            } else if (action === 'this') {
                await createEvent.mutateAsync({
                    calendarId: event.calendarId,
                    ...updates,
                    allDay: Boolean(allDay),
                    rrule: null,
                    parentEventId: event.parentEventId || event.id,
                    recurrenceDate: occurrenceDateToString(event.occurrenceDate),
                });
            } else if (action === 'this-and-following') {
                const parentId = event.parentEventId || event.id;
                const occDate = parseOccurrenceDate(event.occurrenceDate);
                if (event.rrule) {
                    const truncated = truncateRRule(event.rrule, occDate);
                    await updateEvent.mutateAsync({id: parentId, calendarId: event.calendarId, rrule: truncated});
                }
                await createEvent.mutateAsync({
                    calendarId: event.calendarId,
                    ...updates,
                    allDay: Boolean(allDay),
                });
            }

            onOpenChange(false);
        } catch (error) {
            toast.error('Failed to update event');
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    const handleStartTimeChange = (newStart: string) => {
        setStartTime(newStart);
        setEndTime(addMinutes(newStart, 30));
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
                            <Clock className="h-4 w-4 mt-2 text-muted-foreground shrink-0"/>
                            <div className="flex-1 space-y-3">
                                {allDay ? (
                                    <div className="flex items-center gap-2">
                                        <Input type="date" value={startDate}
                                               onChange={(e) => setStartDate(e.target.value)} className="flex-1 h-8 text-sm"/>
                                        <span className="text-muted-foreground text-sm">to</span>
                                        <Input type="date" value={endDate}
                                               onChange={(e) => setEndDate(e.target.value)} className="flex-1 h-8 text-sm"/>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <Input type="date" value={startDate}
                                               onChange={(e) => {
                                                   setStartDate(e.target.value);
                                                   setEndDate(e.target.value);
                                               }}
                                               className="h-8 text-sm"/>
                                        <TimeSelect value={startTime} onChange={handleStartTimeChange}/>
                                        <span className="text-muted-foreground text-sm">–</span>
                                        <TimeSelect value={endTime} onChange={setEndTime} referenceTime={startTime} minTime={addMinutes(startTime, 15)}/>
                                    </div>
                                )}

                                <div className="flex items-center gap-4">
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
                                            {(event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).split('/').pop()?.replace(/_/g, ' ')} time zone
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {!isLinkedEvent && (
                            <div className="flex items-start gap-3">
                                <UsersRound className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0"/>
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
                            <MapPin className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0"/>
                            <Input
                                placeholder="Location"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                className="flex-1"
                            />
                        </div>

                        <div className="flex items-start gap-3">
                            <AlignLeft className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0"/>
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
                                <Calendar className="h-4 w-4 text-muted-foreground shrink-0"/>
                                <Select value={selectedCalKey} onValueChange={setSelectedCalKey}>
                                    <SelectTrigger className="flex-1">
                                        <SelectValue placeholder="Select calendar"/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {calendarOptions.map((cal) => (
                                            <SelectItem key={`${cal.ownerId}:${cal.id}`} value={`${cal.ownerId}:${cal.id}`}>
                                                <div className="flex items-center gap-2">
                                                    <div className="h-3 w-3 rounded-full shrink-0"
                                                         style={{backgroundColor: cal.color}}/>
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
                        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveClick} disabled={isLoading || !title.trim()}>
                            {isLoading ? 'Saving...' : 'Save'}
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
