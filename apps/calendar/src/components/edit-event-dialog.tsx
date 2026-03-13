import {useEffect, useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Textarea} from '@workspace/ui/components/textarea';
import {Label} from '@workspace/ui/components/label';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {useUpdateEvent} from '@workspace/lib/calendar';
import type {CalendarEventOccurrence} from '@workspace/lib/types/calendar';
import {RecurrencePicker} from './recurrence-picker';

type EditEventDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    event: CalendarEventOccurrence | null;
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

export function EditEventDialog({open, onOpenChange, event}: EditEventDialogProps) {
    const updateEvent = useUpdateEvent();

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

    const handleSubmit = async () => {
        if (!title.trim()) return;

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

            await updateEvent.mutateAsync({
                id: event.id,
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
            console.error('Error updating event:', error);
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
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

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Checkbox
                                id="edit-all-day"
                                checked={allDay}
                                onCheckedChange={(checked) => setAllDay(!!checked)}
                            />
                            <Label htmlFor="edit-all-day">All day</Label>
                        </div>

                        {allDay ? (
                            <div className="flex items-center gap-2">
                                <Input type="date" value={startDate}
                                       onChange={(e) => setStartDate(e.target.value)} className="flex-1"/>
                                <span className="text-muted-foreground">—</span>
                                <Input type="date" value={endDate}
                                       onChange={(e) => setEndDate(e.target.value)} className="flex-1"/>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Input type="date" value={startDate}
                                           onChange={(e) => setStartDate(e.target.value)} className="flex-1"/>
                                    <Input type="time" value={startTime}
                                           onChange={(e) => setStartTime(e.target.value)} className="w-28"/>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input type="date" value={endDate}
                                           onChange={(e) => setEndDate(e.target.value)} className="flex-1"/>
                                    <Input type="time" value={endTime}
                                           onChange={(e) => setEndTime(e.target.value)} className="w-28"/>
                                </div>
                            </div>
                        )}
                    </div>

                    <RecurrencePicker
                        value={rruleString}
                        onChange={setRruleString}
                        startDate={new Date(startDate)}
                    />

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
                    <Button onClick={handleSubmit} disabled={isLoading || !title.trim()}>
                        {isLoading ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
