import {useEffect, useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Textarea} from '@workspace/ui/components/textarea';
import {Label} from '@workspace/ui/components/label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {useCalendars, useCreateEvent} from '@workspace/lib/calendar';
import {useAuth} from '@workspace/lib/auth';
import {RecurrencePicker} from './recurrence-picker';
import {TimeSelect, roundToNext15Minutes, addMinutes} from './time-select';

type CreateEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultDate?: Date;
    defaultCalendarId?: string;
}

function toLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function toTimeString(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function CreateEventDialog({open, onOpenChange, defaultDate, defaultCalendarId}: CreateEventDialogProps) {
    const {user} = useAuth();
    const ownerId = user?.id || '';
    const {data: calendars = []} = useCalendars(ownerId);
    const createEvent = useCreateEvent(ownerId);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [calendarId, setCalendarId] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [startTime, setStartTime] = useState('09:00');
    const [endTime, setEndTime] = useState('09:30');
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (open) {
            const now = defaultDate || new Date();
            const rounded = roundToNext15Minutes(now);
            const dateStr = toLocalDateString(rounded);
            const start = toTimeString(rounded);
            const end = addMinutes(start, 30);

            setTitle('');
            setDescription('');
            setLocation('');
            setCalendarId(defaultCalendarId || (calendars.length > 0 ? calendars[0].id : ''));
            setAllDay(false);
            setStartDate(dateStr);
            setEndDate(dateStr);
            setStartTime(start);
            setEndTime(end);
            setRruleString(null);
        }
    }, [open, defaultDate, defaultCalendarId, calendars]);

    const handleStartTimeChange = (newStart: string) => {
        setStartTime(newStart);
        setEndTime(addMinutes(newStart, 30));
    };

    const handleSubmit = async () => {
        if (!title.trim() || !calendarId) return;

        setIsLoading(true);
        try {
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

            await createEvent.mutateAsync({
                calendarId,
                title: title.trim(),
                startTime: startTimestamp,
                endTime: endTimestamp,
                allDay,
                description: description.trim() || null,
                location: location.trim() || null,
                rrule: rruleString,
            });
            onOpenChange(false);
        } catch (error) {
            console.error('Error creating event:', error);
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
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

                    <div className="space-y-3">
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
                                <TimeSelect value={endTime} onChange={setEndTime} referenceTime={startTime}/>
                            </div>
                        )}

                        <div className="flex items-center gap-4">
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
                                startDate={new Date(startDate)}
                            />
                        </div>
                    </div>

                    <div>
                        <Input
                            placeholder="Add location"
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                        />
                    </div>

                    <div>
                        <Textarea
                            placeholder="Add description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                        />
                    </div>

                    {calendars.length > 1 && (
                        <div className="flex items-center gap-3">
                            <Label className="w-20 shrink-0">Calendar</Label>
                            <Select value={calendarId} onValueChange={setCalendarId}>
                                <SelectTrigger className="flex-1">
                                    <SelectValue placeholder="Select calendar"/>
                                </SelectTrigger>
                                <SelectContent>
                                    {calendars.map((cal) => (
                                        <SelectItem key={cal.id} value={cal.id}>
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
                    <Button onClick={handleSubmit} disabled={isLoading || !title.trim()}>
                        {isLoading ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
