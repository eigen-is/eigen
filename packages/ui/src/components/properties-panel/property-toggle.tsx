import { Toggle } from '@workspace/ui/components/toggle';
import { cn } from '@workspace/ui/lib/utils';
import type { ComponentProps } from 'react';

// The panel's icon toggle: the same h-7 square as TooltipButton in the Arrange / Align rows, so a row
// of toggles (bold/italic, alignment, layout) lines up with the buttons around it.
export function PropertyToggle({ className, ...props }: ComponentProps<typeof Toggle>) {
    return <Toggle size="sm" className={cn('h-7 w-7 min-w-7 px-0', className)} {...props} />;
}
