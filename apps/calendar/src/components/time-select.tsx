import {useRef, useEffect, useState} from 'react';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {Button} from '@workspace/ui/components/button';
import {cn} from '@workspace/ui/lib/utils';

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

function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
}

function formatDuration(startMinutes: number, endMinutes: number): string {
    let diff = endMinutes - startMinutes;
    if (diff <= 0) diff += 24 * 60;
    const hours = Math.floor(diff / 60);
    const mins = diff % 60;
    if (hours === 0) return `(${mins} mins)`;
    if (mins === 0) return hours === 1 ? '(1 hr)' : `(${hours} hrs)`;
    return hours === 1 ? `(1 hr ${mins} mins)` : `(${hours} hrs ${mins} mins)`;
}

type TimeSelectProps = {
    value: string;
    onChange: (value: string) => void;
    referenceTime?: string;
}

export function TimeSelect({value, onChange, referenceTime}: TimeSelectProps) {
    const [open, setOpen] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const refMinutes = referenceTime ? timeToMinutes(referenceTime) : null;

    useEffect(() => {
        if (open && listRef.current) {
            const idx = TIME_SLOTS.indexOf(value);
            if (idx >= 0) {
                const el = listRef.current.children[idx] as HTMLElement;
                el?.scrollIntoView({block: 'center'});
            }
        }
    }, [open, value]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-[140px] justify-start font-normal tabular-nums">
                    {value}
                    {refMinutes != null && (
                        <span className="text-muted-foreground ml-1 text-xs">
                            {formatDuration(refMinutes, timeToMinutes(value))}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0" align="start">
                <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1">
                    {TIME_SLOTS.map((slot) => (
                        <button
                            key={slot}
                            type="button"
                            className={cn(
                                'w-full text-left px-3 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer',
                                slot === value && 'bg-accent font-medium'
                            )}
                            onClick={() => {
                                onChange(slot);
                                setOpen(false);
                            }}
                        >
                            {slot}
                            {refMinutes != null && (
                                <span className="text-muted-foreground ml-2">
                                    {formatDuration(refMinutes, timeToMinutes(slot))}
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
