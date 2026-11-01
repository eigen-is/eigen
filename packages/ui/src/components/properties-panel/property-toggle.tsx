// The properties panel's icon toggle, such as bold, italic or an alignment. It is the same h-7 square as the
// TooltipButton in the Arrange and Align rows, so a row of toggles lines up with the buttons around it. A caller whose
// selection disagrees sets data-mixed, and the toggle then draws a dashed border, neither on nor off.

import { Toggle } from '@workspace/ui/components/toggle';
import { cn } from '@workspace/ui/lib/utils';
import type { ComponentProps } from 'react';

export function PropertyToggle({ className, ...props }: ComponentProps<typeof Toggle>) {
    return (
        <Toggle
            size="sm"
            className={cn(
                'h-7 w-7 min-w-7 px-0 data-[mixed]:border data-[mixed]:border-dashed data-[mixed]:border-input',
                className,
            )}
            {...props}
        />
    );
}
