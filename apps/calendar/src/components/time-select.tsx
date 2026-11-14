// The time picker of the event dialogs: a text field with a list of quarter hours, which for an end time shows each
// slot's duration and whether it falls on a later day. Its value is "hh:mm" on a 24-hour clock, which the dialogs parse
// back into a date, so this file also holds the helpers that write and read that shape, such as a default start.

import { toLocalDateString } from '@workspace/lib/calendar';
import { Input } from '@workspace/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useRef, useState } from 'react';

const TIME_SLOTS = Array.from({ length: 24 * 4 }, (_, i) => minutesToTime(i * 15));

type TimeSelectProps = {
    value: string;
    onChange: (value: string, dayOffset: number) => void;
    referenceTime?: string;
    minTime?: string;
    disabled?: boolean;
};

export function TimeSelect({ value, onChange, referenceTime, minTime, disabled }: TimeSelectProps) {
    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const listRef = useRef<HTMLDivElement>(null);
    const refMinutes = referenceTime ? timeToMinutes(referenceTime) : null;
    const minMinutes = minTime ? timeToMinutes(minTime) : -1;

    const filteredTimeSlots =
        minMinutes >= 0
            ? (() => {
                  const slots: Array<{ time: string; dayOffset: number }> = [];
                  for (let offset = 0; offset < 24 * 60 - 15; offset += 15) {
                      const totalMinutes = minMinutes + offset;
                      slots.push({
                          time: minutesToTime(totalMinutes % (24 * 60)),
                          dayOffset: Math.floor(totalMinutes / (24 * 60)),
                      });
                  }
                  return slots;
              })()
            : TIME_SLOTS.map((time) => ({ time, dayOffset: 0 }));

    useEffect(() => {
        setInputValue(value);
    }, [value]);

    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => {
            if (!listRef.current) return;

            const valueInMinutes = timeToMinutes(value);
            if (valueInMinutes === -1) return;
            const target = filteredTimeSlots.reduce((prev, curr) => {
                const prevDiff = Math.abs(timeToMinutes(prev.time) - valueInMinutes);
                const currDiff = Math.abs(timeToMinutes(curr.time) - valueInMinutes);
                return prevDiff < currDiff ? prev : curr;
            });

            const idx = filteredTimeSlots.findIndex((slot) => slot.time === target.time);

            listRef.current.children.item(idx)?.scrollIntoView({ block: 'center' });
        }, 100);
        return () => clearTimeout(timer);
    }, [open, value]);

    const commitInput = () => {
        const trimmed = inputValue.trim();
        if (isValidTime(trimmed)) {
            const minutes = timeToMinutes(trimmed);
            const dayOffset = refMinutes != null && minutes <= refMinutes ? 1 : 0;
            onChange(minutesToTime(minutes), dayOffset);
        } else {
            setInputValue(value);
        }
    };

    return (
        <Popover open={open && !disabled} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <div className="relative">
                    <Input
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onBlur={commitInput}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                // Enter sets the time, and in a form it would also submit it.
                                e.preventDefault();
                                commitInput();
                                setOpen(false);
                            }
                        }}
                        onClick={() => setOpen(true)}
                        disabled={disabled}
                        className="w-[70px] h-8 text-sm tabular-nums px-2 text-center"
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent className="w-[180px] p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                <div
                    ref={listRef}
                    className="max-h-[240px] overflow-y-auto p-1"
                    tabIndex={-1}
                    onWheel={(e) => {
                        e.stopPropagation();
                    }}
                >
                    {filteredTimeSlots.map((slot) => (
                        <button
                            key={`${slot.time}-${slot.dayOffset}`}
                            type="button"
                            className={cn(
                                'w-full text-left px-3 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer',
                                slot.time === value && 'bg-accent font-medium',
                            )}
                            onClick={() => {
                                onChange(slot.time, slot.dayOffset);
                                setInputValue(slot.time);
                                setOpen(false);
                            }}
                        >
                            {slot.time}
                            {refMinutes != null && (
                                <span className="text-muted-foreground ml-2 text-xs">
                                    {formatDuration(refMinutes, timeToMinutes(slot.time) + slot.dayOffset * 24 * 60)}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}

export function roundToNext15Minutes(date: Date): Date {
    const d = new Date(date);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return d;
}

export function toTimeString(date: Date): string {
    return minutesToTime(date.getHours() * 60 + date.getMinutes());
}

// The end of an event that starts at `start`, as the dialog's date and time fields: past midnight it is the next day.
export function endAfter(start: Date, minutes: number): { date: string; time: string } {
    const end = new Date(start.getTime() + minutes * 60_000);
    return { date: toLocalDateString(end), time: toTimeString(end) };
}

// The end once the start moves to `start`: it stays while it is at least 15 minutes later, on any day.
export function endForStart(start: Date, end: { date: string; time: string }): { date: string; time: string } {
    if (new Date(`${end.date}T${end.time}`).getTime() - start.getTime() >= 15 * 60_000) return end;
    return endAfter(start, 30);
}

export function addMinutes(time: string, minutes: number): string {
    let totalMins = timeToMinutes(time) + minutes;
    if (totalMins >= 24 * 60) totalMins -= 24 * 60;
    if (totalMins < 0) totalMins += 24 * 60;
    return minutesToTime(totalMins);
}

export function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return -1;
    return h * 60 + m;
}

function minutesToTime(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function formatDuration(startMinutes: number, endMinutes: number): string {
    let diff = endMinutes - startMinutes;
    if (diff <= 0) diff += 24 * 60;
    const hours = Math.floor(diff / 60);
    const mins = diff % 60;
    if (hours === 0) return `(${mins}m)`;
    if (mins === 0) return `(${hours}h)`;
    return `(${hours}h${mins}m)`;
}

function isValidTime(str: string): boolean {
    return /^(\d|0\d|1\d|2[0-3]):[0-5]\d$/.test(str);
}
