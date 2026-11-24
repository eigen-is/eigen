// How the time grid draws what sits on its hours: a timed event as a block at its minutes, and the range a drag over
// an empty column draws before New event opens. Both turn minutes into pixels at the grid's one hour height, and what a
// block shows follows how tall it is. The time grid lays them out and owns every gesture over them.

import type { TimedBlock } from '@workspace/lib/calendar';
import { formatTime } from '@workspace/lib/date';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import type { EventSurfaceProps } from './event-chip';
import { EventSurface } from './event-chip';

type TimedEventBlockProps = EventSurfaceProps & {
    block: TimedBlock;
    className?: string;
    onResizeStart?: (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => void;
};

export const HOUR_HEIGHT = 48;
// A block's text lines are text-xs at leading-4, inside 2px of padding above and below.
const LINE_HEIGHT = 16;
const BLOCK_PADDING = 4;
// Dark mode draws a 2px color stripe at the left edge, so the text starts further in.
const BLOCK = 'absolute rounded px-1 py-0.5 dark:pl-2';

export function atMinutes(day: Date, minutes: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

// What a block shows follows its height: the title always, then the time, then the place. The resize edge needs a
// fine pointer, since a finger never drags.
export function TimedEventBlock({ block, className, onResizeStart, ...surfaceProps }: TimedEventBlockProps) {
    const { event } = block;
    const height = ((block.bottom - block.top) * HOUR_HEIGHT) / 60;
    const lines = Math.floor((height - BLOCK_PADDING) / LINE_HEIGHT);
    return (
        <EventSurface
            event={event}
            {...surfaceProps}
            className={cn(BLOCK, 'ring-1 ring-background', className)}
            style={{
                top: (block.top * HOUR_HEIGHT) / 60,
                height,
                left: `${(block.column / block.columns) * 100}%`,
                width: `${(block.span / block.columns) * 100}%`,
            }}
        >
            {lines < 2 ? (
                <span className="block truncate">
                    <span className="font-medium">{event.title}</span>, {formatTime(event.startTime)}
                </span>
            ) : (
                <>
                    <span className="block truncate font-medium">{event.title}</span>
                    <span className="block truncate">
                        {`${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}
                    </span>
                    {lines > 2 && event.location && <span className="block truncate">{event.location}</span>}
                </>
            )}
            {onResizeStart && (
                <span
                    className="absolute inset-x-0 bottom-0 hidden h-1.5 cursor-ns-resize pointer-fine:block"
                    onPointerDown={(e) => onResizeStart(event, e)}
                />
            )}
        </EventSurface>
    );
}

// On the default calendar's color, laid out as a block is.
export function DraftBlock({ day, top, bottom, color }: { day: Date; top: number; bottom: number; color: string }) {
    const surface = colorSurface(color, 'tile');
    const height = ((bottom - top) * HOUR_HEIGHT) / 60;
    const range = `${formatTime(atMinutes(day, top))} – ${formatTime(atMinutes(day, bottom))}`;
    return (
        <div
            className={cn(
                'pointer-events-none inset-x-0 overflow-hidden text-xs leading-4 shadow-md',
                BLOCK,
                surface.className,
            )}
            style={{ ...surface.style, top: (top * HOUR_HEIGHT) / 60, height }}
        >
            {height - BLOCK_PADDING < 2 * LINE_HEIGHT ? (
                <span className="block truncate">
                    <span className="font-medium">(No title)</span>, {range}
                </span>
            ) : (
                <>
                    <span className="block truncate font-medium">(No title)</span>
                    <span className="block truncate">{range}</span>
                </>
            )}
        </div>
    );
}
