// InfoBlock is the muted bar that holds a line of facts in a dialog or a panel, such as a picker's Location or the
// title of a list of people. A bar that opens something puts a button in it with STRETCHED_TRIGGER_CLASS, so the
// whole bar is the button's hit area and its focus ring.

import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';

// The bar needs `relative` for the stretch. A control that must stay clickable in the bar is positioned too and comes
// after the button, so it paints above the hit area. The focus ring sits inside the bar, because a bar in a scrolling
// container would clip a ring outside it.
export const STRETCHED_TRIGGER_CLASS =
    'cursor-pointer outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 focus-visible:after:ring-inset';

export function InfoBlock({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            className={cn('flex items-center justify-between rounded-md bg-muted/50 px-3 py-2', className)}
            {...props}
        />
    );
}
