import { toLocalDateString } from '@workspace/lib/calendar';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';
import { AlignLeft, Calendar, Clock, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CalendarOption } from './calendar-utils';
import { RecurrencePicker } from './recurrence-picker';
import { addMinutes, roundToNext15Minutes, TimeSelect, timeToMinutes, toTimeString } from './time-select';

type EventFormFieldsProps = {
    titlePlaceholder: string;
    locationPlaceholder: string;
    descriptionPlaceholder: string;
    title: string;
    setTitle: (value: string) => void;
    allDay: boolean;
    setAllDay: (value: boolean) => void;
    startDate: string;
    setStartDate: (value: string) => void;
    endDate: string;
    setEndDate: (value: string) => void;
    startTime: string;
    setStartTime: (value: string) => void;
    endTime: string;
    setEndTime: (value: string) => void;
    location: string;
    setLocation: (value: string) => void;
    description: string;
    setDescription: (value: string) => void;
    rruleString: string | null;
    setRruleString: (value: string | null) => void;
    selectedCalKey: string;
    setSelectedCalKey: (value: string) => void;
    calendarOptions: CalendarOption[];
    recurrenceStartDate: Date;
    timezone: string;
    allDayId: string;
    attendeesSection: ReactNode;
};

export function EventFormFields({
    titlePlaceholder,
    locationPlaceholder,
    descriptionPlaceholder,
    title,
    setTitle,
    allDay,
    setAllDay,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    startTime,
    setStartTime,
    endTime,
    setEndTime,
    location,
    setLocation,
    description,
    setDescription,
    rruleString,
    setRruleString,
    selectedCalKey,
    setSelectedCalKey,
    calendarOptions,
    recurrenceStartDate,
    timezone,
    allDayId,
    attendeesSection,
}: EventFormFieldsProps) {
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
        <div className="space-y-4">
            <div>
                <Input
                    placeholder={titlePlaceholder}
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
                                id={allDayId}
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
                            <Label htmlFor={allDayId}>All day</Label>
                        </div>
                        <RecurrencePicker
                            value={rruleString}
                            onChange={setRruleString}
                            startDate={recurrenceStartDate}
                        />
                        {!allDay && (
                            <span className="text-xs text-muted-foreground ml-auto">
                                {timezone.split('/').pop()?.replace(/_/g, ' ')} time zone
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {attendeesSection}

            <div className="flex items-start gap-3">
                <MapPin className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                <Input
                    placeholder={locationPlaceholder}
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="flex-1"
                />
            </div>

            <div className="flex items-start gap-3">
                <AlignLeft className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
                <Textarea
                    placeholder={descriptionPlaceholder}
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
    );
}
