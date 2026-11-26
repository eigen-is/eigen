// How the time grid draws what sits on its hours: a timed event as a block at its minutes, and the range a drag over
// an empty column draws before New event opens. Both turn minutes into pixels at the grid's one hour height, and what a
// block shows follows how tall it is. The time grid lays them out and owns every gesture over them.

import type { TimedBlock } from '@workspace/lib/calendar';
import { formatTime } from '@workspace/lib/date';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import type { EventSurfaceProps } from './event-chip';
import { EventSurface, STRIPE_INSET } from './event-chip';

type TimedEventBlockProps = EventSurfaceProps & {
    block: TimedBlock;
    className?: string;
    onResizeStart?: (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => void;
};

export const HOUR_HEIGHT = 48;
// A block's text lines are text-xs at leading-4, inside 2px of padding above and below.
const LINE_HEIGHT = 16;
const BLOCK_PADDING = 4;
// A block stops a pixel short of its slot's bottom and right, so its shadow shows between back-to-back and side-by-side
// events. A ring in the background color would part them too, but Tailwind paints a ring over the shadow.
const BLOCK_GAP_PX = 1;
// A button centers its content, so the lines stack from the top as a column.
const BLOCK = cn('absolute flex flex-col justify-start px-1 py-0.5', STRIPE_INSET);

export function atMinutes(day: Date, minutes: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

export function minutesToPx(minutes: number): number {
    return (minutes * HOUR_HEIGHT) / 60;
}

// What a block shows follows its height: the title always, then the time, then the place. The resize edge shows for
// any fine pointer, such as a Pencil on an iPad whose primary pointer is a finger, and a tap on it still clicks.
export function TimedEventBlock({ block, className, onResizeStart, ...surfaceProps }: TimedEventBlockProps) {
    const { event } = block;
    const height = minutesToPx(block.bottom - block.top);
    const lines = textLines(height);
    return (
        <EventSurface
            event={event}
            {...surfaceProps}
            className={cn(BLOCK, className)}
            style={{
                top: minutesToPx(block.top),
                height: height - BLOCK_GAP_PX,
                left: `${(block.column / block.columns) * 100}%`,
                width: `calc(${(block.span / block.columns) * 100}% - ${BLOCK_GAP_PX}px)`,
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
                    className="absolute inset-x-0 bottom-0 hidden h-1.5 cursor-ns-resize any-pointer-fine:block"
                    onPointerDown={(e) => onResizeStart(event, e)}
                />
            )}
        </EventSurface>
    );
}

// On the default calendar's color, laid out as a block is.
export function DraftBlock({ day, top, bottom, color }: { day: Date; top: number; bottom: number; color: string }) {
    const surface = colorSurface(color, 'tile');
    const height = minutesToPx(bottom - top);
    const range = `${formatTime(atMinutes(day, top))} – ${formatTime(atMinutes(day, bottom))}`;
    return (
        <div
            className={cn(
                'eigen-block pointer-events-none left-0 overflow-hidden text-xs leading-4',
                BLOCK,
                surface.className,
            )}
            style={{ ...surface.style, top: minutesToPx(top), height: height - BLOCK_GAP_PX, right: BLOCK_GAP_PX }}
        >
            {textLines(height) < 2 ? (
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

function textLines(height: number): number {
    return Math.floor((height - BLOCK_PADDING) / LINE_HEIGHT);
}
