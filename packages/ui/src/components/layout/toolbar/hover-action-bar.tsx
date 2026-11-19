// The small floating bar of icon buttons over an item's corner, such as a chat message's Edit and Delete or a card's
// Edit. A mouse user sees it while the pointer is over the item, the `group` around it, and Tab reaches and shows it.
// Until then it takes no click, so a click there lands on the item. The caller places it, and a caller with no long
// press to offer the same actions on a touch screen shows it there too.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function HoverActionBar({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div
            className={cn(
                'absolute top-1 z-10 flex items-center rounded-md border bg-background shadow-sm pointer-events-none opacity-0 pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:opacity-100',
                className,
            )}
        >
            {children}
        </div>
    );
}
