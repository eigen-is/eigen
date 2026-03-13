import {useEffect, useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Textarea} from '@workspace/ui/components/textarea';
import {Label} from '@workspace/ui/components/label';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {useUpdateEvent, useCreateEvent} from '@workspace/lib/calendar';
import {useAuth} from '@workspace/lib/auth';
import type {CalendarEventOccurrence} from '@workspace/lib/types/calendar';
import {RRule} from 'rrule';
import {RecurrencePicker} from './recurrence-picker';
import {TimeSelect, roundToNext15Minutes, addMinutes} from './time-select';
import {RecurringActionDialog} from './recurring-action-dialog';
import type {RecurringAction} from './recurring-action-dialog';
import {parseOccurrenceDate, occurrenceDateToString} from './calendar-utils';

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
    ownerUserId?: string;
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

export function EditEventDialog({open, onOpenChange, event, ownerUserId}: EditEventDialogProps) {
    const {user} = useAuth();
    const eventOwnerId = ownerUserId || user?.id || '';
    const updateEvent = useUpdateEvent(eventOwnerId);
    const createEvent = useCreateEvent(eventOwnerId);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endDate, setEndDate] = useState('');
    const [endTime, setEndTime] = useState('');
    const [rruleString, setRruleString] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [showRecurringDialog, setShowRecurringDialog] = useState(false);

    useEffect(() => {
        if (event && open) {
            setTitle(event.title);
            setDescription(event.description || '');
            setLocation(event.location || '');
            setAllDay(event.allDay);
            setRruleString(event.rrule);

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
    }, [event, open]);

    if (!event) return null;

    const isRecurring = !!event.rrule;

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
        if (isRecurring) {
            setShowRecurringDialog(true);
        } else {
            doSave('all');
        }
    };

    const doSave = async (action: RecurringAction) => {
        setIsLoading(true);
        try {
            const {startTimestamp, endTimestamp} = buildTimestamps();
            const updates = {
                title: title.trim(),
                startTime: startTimestamp,
                endTime: endTimestamp,
                allDay,
                description: description.trim() || null,
                location: location.trim() || null,
                rrule: rruleString,
            };

            if (action === 'all') {
                const targetId = event.parentEventId || event.id;
                await updateEvent.mutateAsync({id: targetId, ...updates});
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
                    await updateEvent.mutateAsync({id: parentId, rrule: truncated});
                }
                await createEvent.mutateAsync({
                    calendarId: event.calendarId,
                    ...updates,
                    allDay: Boolean(allDay),
                });
            }

            onOpenChange(false);
        } catch (error) {
            console.error('Error updating event:', error);
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
                <DialogContent className="sm:max-w-[500px]">
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
                            </div>
                        </div>

                        <div>
                            <Input
                                placeholder="Location"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                            />
                        </div>

                        <div>
                            <Textarea
                                placeholder="Description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                            />
                        </div>
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
