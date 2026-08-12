import { formatTime } from '@workspace/lib/date';
import { Input } from '@workspace/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useRef, useState } from 'react';

function formatTimeSlot(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(2000, 0, 1, h, m);
    return formatTime(d);
}

function generateTimeSlots(): string[] {
    const slots: string[] = [];
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
            slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        }
    }
    return slots;
}

const TIME_SLOTS = generateTimeSlots();

export function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return -1;
    return h * 60 + m;
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

type TimeSelectProps = {
    value: string;
    onChange: (value: string, dayOffset: number) => void;
    referenceTime?: string;
    minTime?: string;
};

export function TimeSelect({ value, onChange, referenceTime, minTime }: TimeSelectProps) {
    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const refMinutes = referenceTime ? timeToMinutes(referenceTime) : null;
    const minMinutes = minTime ? timeToMinutes(minTime) : -1;

    const filteredTimeSlots =
        minMinutes >= 0
            ? (() => {
                  const slots: Array<{ time: string; dayOffset: number }> = [];
                  const maxDuration = 23 * 60 + 45;
                  const maxSlots = 95;
                  for (let i = 0; i <= maxSlots; i++) {
                      const totalMinutes = minMinutes + i * 15;
                      const duration = 15 + i * 15;

                      if (duration > maxDuration) break;

                      let dayOffset = 0;
                      let timeMinutes = totalMinutes;

                      if (totalMinutes >= 24 * 60) {
                          dayOffset = Math.floor(totalMinutes / (24 * 60));
                          timeMinutes = totalMinutes % (24 * 60);
                      }

                      const hours = Math.floor(timeMinutes / 60);
                      const minutes = timeMinutes % 60;
                      const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

                      slots.push({ time: timeString, dayOffset });
                  }

                  return slots;
              })()
            : TIME_SLOTS.map((time) => ({ time, dayOffset: 0 }));

    useEffect(() => {
        setInputValue(value);
    }, [value]);

    useEffect(() => {
        if (open) {
            setTimeout(() => {
                if (!listRef.current) return;

                const valueInMinutes = timeToMinutes(value);
                if (valueInMinutes === -1) return;
                const target = filteredTimeSlots.reduce((prev, curr) => {
                    const prevDiff = Math.abs(timeToMinutes(prev.time) - valueInMinutes);
                    const currDiff = Math.abs(timeToMinutes(curr.time) - valueInMinutes);
                    return prevDiff < currDiff ? prev : curr;
                });

                const idx = filteredTimeSlots.findIndex((slot) => slot.time === target.time);

                if (idx >= 0) {
                    const el = listRef.current.children[idx] as HTMLElement;
                    if (el) {
                        el.scrollIntoView({ block: 'center' });
                    }
                }
            }, 100);
        }
    }, [open, value]);

    const commitInput = () => {
        const trimmed = inputValue.trim();
        if (isValidTime(trimmed)) {
            const [h, m] = trimmed.split(':');
            const formattedTime = `${String(parseInt(h, 10)).padStart(2, '0')}:${m.padStart(2, '0')}`;
            const minutes = timeToMinutes(formattedTime);
            const dayOffset = refMinutes != null && minutes <= refMinutes ? 1 : 0;
            onChange(formattedTime, dayOffset);
        } else {
            setInputValue(value);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <div className="relative">
                    <Input
                        ref={inputRef}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onBlur={commitInput}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitInput();
                                setOpen(false);
                            }
                        }}
                        onClick={() => setOpen(true)}
                        className="w-[70px] h-8 text-sm tabular-nums px-2 text-center"
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent className="w-[180px] p-0" align="start" onOpenAutoFocus={(e: Event) => e.preventDefault()}>
                <div
                    ref={listRef}
                    className="max-h-[240px] overflow-y-auto p-1"
                    tabIndex={-1}
                    onWheel={(e: React.WheelEvent<HTMLDivElement>) => {
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
                            {formatTimeSlot(slot.time)}
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

export function toTimeString(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function roundToNext15Minutes(date: Date): Date {
    const d = new Date(date);
    const mins = d.getMinutes();
    const remainder = mins % 15;
    if (remainder > 0) {
        d.setMinutes(mins + (15 - remainder), 0, 0);
    } else {
        d.setMinutes(mins, 0, 0);
    }
    return d;
}

export function addMinutes(time: string, minutes: number): string {
    let totalMins = timeToMinutes(time) + minutes;
    if (totalMins >= 24 * 60) totalMins -= 24 * 60;
    if (totalMins < 0) totalMins += 24 * 60;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
