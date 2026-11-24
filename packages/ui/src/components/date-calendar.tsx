// shadcn's Calendar: react-day-picker's month grid in the house style, its month on the left and the arrows that
// step it on the right, as Google draws one. Weeks start on Calendar's week start, weekdays read as one letter, and
// today is a circle in the app's color. It is as wide as its days by default, and a caller that gives it a width,
// such as `w-full`, spreads the seven columns over it. Its first user is Calendar's mini month; the caller adds what
// it marks.

import { WEEK_STARTS_ON } from '@workspace/lib/calendar';
import { dateFormatter, formatDayMonth } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type * as React from 'react';
import { DayPicker, getDefaultClassNames } from 'react-day-picker';
import { buttonVariants } from './button';

export function DateCalendar({ className, classNames, ...props }: React.ComponentProps<typeof DayPicker>) {
    const defaultClassNames = getDefaultClassNames();

    return (
        <DayPicker
            showOutsideDays
            weekStartsOn={WEEK_STARTS_ON}
            className={cn('w-fit [--cell-size:--spacing(8)]', className)}
            formatters={{ formatWeekdayName: (day) => dateFormatter({ weekday: 'narrow' }).format(day) }}
            labels={{
                labelDayButton: (day, modifiers) =>
                    `${modifiers.today ? 'Today, ' : ''}${formatDayMonth(day, { weekday: 'long', year: true })}`,
                labelPrevious: () => 'Show previous month',
                labelNext: () => 'Show next month',
            }}
            classNames={{
                root: cn('relative', defaultClassNames.root),
                month: cn('flex flex-col gap-1', defaultClassNames.month),
                month_grid: cn('w-full', defaultClassNames.month_grid),
                nav: cn('absolute top-0 right-0 flex items-center', defaultClassNames.nav),
                button_previous: cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'size-(--cell-size) rounded-full',
                    defaultClassNames.button_previous,
                ),
                button_next: cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'size-(--cell-size) rounded-full',
                    defaultClassNames.button_next,
                ),
                month_caption: cn('flex h-(--cell-size) items-center px-2', defaultClassNames.month_caption),
                caption_label: cn('select-none text-sm font-medium', defaultClassNames.caption_label),
                weekday: cn(
                    'h-(--cell-size) min-w-(--cell-size) select-none text-[0.7rem] font-normal text-muted-foreground',
                    defaultClassNames.weekday,
                ),
                day: cn('h-(--cell-size) min-w-(--cell-size) p-0 text-center', defaultClassNames.day),
                day_button: cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'size-(--cell-size) rounded-full text-xs font-normal',
                    defaultClassNames.day_button,
                ),
                today: cn(
                    '[&>button]:bg-(--app-current-color) [&>button]:text-background [&>button]:hover:bg-(--app-current-color)',
                    defaultClassNames.today,
                ),
                outside: cn('text-muted-foreground', defaultClassNames.outside),
                ...classNames,
            }}
            components={{
                Chevron: ({ orientation }) =>
                    orientation === 'left' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />,
            }}
            {...props}
        />
    );
}
