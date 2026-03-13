import {useRef, useEffect, useState} from 'react';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {Input} from '@workspace/ui/components/input';
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

function isValidTime(str: string): boolean {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

type TimeSelectProps = {
    value: string;
    onChange: (value: string) => void;
    referenceTime?: string;
}

export function TimeSelect({value, onChange, referenceTime}: TimeSelectProps) {
    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const refMinutes = referenceTime ? timeToMinutes(referenceTime) : null;

    useEffect(() => {
        setInputValue(value);
    }, [value]);

    useEffect(() => {
        if (open && listRef.current) {
            requestAnimationFrame(() => {
                if (!listRef.current) return;
                const target = TIME_SLOTS.includes(value) ? value : TIME_SLOTS.reduce((prev, curr) =>
                    Math.abs(timeToMinutes(curr) - timeToMinutes(value)) < Math.abs(timeToMinutes(prev) - timeToMinutes(value)) ? curr : prev
                );
                const idx = TIME_SLOTS.indexOf(target);
                if (idx >= 0) {
                    const el = listRef.current.children[idx] as HTMLElement;
                    if (el) {
                        el.scrollIntoView({block: 'center'});
                    }
                }
            });
        }
    }, [open, value]);

    const commitInput = () => {
        const trimmed = inputValue.trim();
        if (isValidTime(trimmed)) {
            onChange(trimmed);
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
                <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1" tabIndex={-1}>
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
                                setInputValue(slot);
                                setOpen(false);
                            }}
                        >
                            {slot}
                            {refMinutes != null && (
                                <span className="text-muted-foreground ml-2 text-xs">
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
