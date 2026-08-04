import { useAuth } from '@workspace/lib/auth';
import { toLocalDateString, useCalendars, useCreateEvent, useSharedCalendars } from '@workspace/lib/calendar';
import { useMyTeams } from '@workspace/lib/home';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';
import { AlignLeft, Calendar, Clock, MapPin, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AttendeeEditor } from './attendee-editor';
import type { CalendarOption } from './calendar-utils';
import { resolveCalendarName } from './calendar-utils';
import { RecurrencePicker } from './recurrence-picker';
import { addMinutes, roundToNext15Minutes, TimeSelect, timeToMinutes } from './time-select';

type CreateEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultDate?: Date;
    defaultCalendarId?: string;
};

function toTimeString(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function CreateEventDialog({ open, onOpenChange, defaultDate, defaultCalendarId }: CreateEventDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);
    const { data: myTeams } = useMyTeams();

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
    const [selectedCalKey, setSelectedCalKey] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [startTime, setStartTime] = useState('09:00');
    const [endTime, setEndTime] = useState('09:30');
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [attendees, setAttendees] = useState<Attendee[]>([]);

    const selectedCal = calendarOptions.find((c) => `${c.ownerId}:${c.id}` === selectedCalKey);
    const createEvent = useCreateEvent(selectedCal?.ownerId || ownerId);

    useEffect(() => {
        if (open) {
            const now = new Date();
            const rounded = roundToNext15Minutes(now);

            const targetDate = defaultDate ? new Date(defaultDate) : rounded;
            targetDate.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);

            const dateStr = toLocalDateString(targetDate);
            const start = toTimeString(targetDate);
            const end = addMinutes(start, 30);

            setTitle('');
            setDescription('');
            setLocation('');
            const defaultCal = defaultCalendarId
                ? calendarOptions.find((c) => c.id === defaultCalendarId)
                : calendarOptions[0];
            setSelectedCalKey(defaultCal ? `${defaultCal.ownerId}:${defaultCal.id}` : '');
            setAllDay(false);
            setStartDate(dateStr);
            setEndDate(dateStr);
            setStartTime(start);
            setEndTime(end);
            setRruleString(null);
            setAttendees([]);
        }
    }, [open, defaultDate, defaultCalendarId, calendarOptions]);

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

    const handleSubmit = async () => {
        if (!title.trim() || !selectedCal) return;

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

        await createEvent.mutateAsync({
            calendarId: selectedCal.id,
            title: title.trim(),
            startTime: start,
            endTime: end,
            allDay,
            description: description.trim() || null,
            location: location.trim() || null,
            rrule: rruleString,
            timezone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
            data: attendees.length > 0 ? { attendees } : undefined,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md">
                <DialogHeader>
                    <DialogTitle>New Event</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div>
                        <Input
                            placeholder="Add title"
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
                                        id="all-day"
                                        checked={allDay}
                                        onCheckedChange={(checked) => {
                                            const isAllDay = !!checked;
                                            setAllDay(isAllDay);
                                            if (!isAllDay) {
                                                const now = roundToNext15Minutes(new Date());
                                                setStartTime(toTimeString(now));
                                                setEndTime(addMinutes(toTimeString(now), 30));
                                            }
                                        }}
                                    />
                                    <Label htmlFor="all-day">All day</Label>
                                </div>
                                <RecurrencePicker
                                    value={rruleString}
                                    onChange={setRruleString}
                                    startDate={new Date(`${startDate}T00:00:00`)}
                                />
                                {!allDay && (
                                    <span className="text-xs text-muted-foreground ml-auto">
                                        {Intl.DateTimeFormat()
                                            .resolvedOptions()
                                            .timeZone.split('/')
                                            .pop()
                                            ?.replace(/_/g, ' ')}{' '}
                                        time zone
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

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

                    <div className="flex items-start gap-3">
                        <MapPin className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                        <Input
                            placeholder="Add location"
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                            className="flex-1"
                        />
                    </div>

                    <div className="flex items-start gap-3">
                        <AlignLeft className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                        <Textarea
                            placeholder="Add description"
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
                                        <SelectItem key={`${cal.ownerId}:${cal.id}`} value={`${cal.ownerId}:${cal.id}`}>
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
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createEvent.isPending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={createEvent.isPending || !title.trim()}>
                        {createEvent.isPending ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
