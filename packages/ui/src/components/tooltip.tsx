// shadcn's Tooltip on Radix: a small label shown on hover or focus of its trigger. Each Tooltip brings
// its own provider with no delay, so a tooltip shows at once unless its caller passes a delayDuration.
// A focus shows it only with a focus ring, as from a Tab, so a closing dialog that gives the focus back to a button a
// mouse clicked opens no tooltip to take the next Esc.

import { hasFocusRing } from '@workspace/ui/hooks/use-focus-return';
import { cn } from '@workspace/ui/lib/utils';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type * as React from 'react';

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
    return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
    return (
        <TooltipProvider>
            <TooltipPrimitive.Root data-slot="tooltip" disableHoverableContent {...props} />
        </TooltipProvider>
    );
}

function TooltipTrigger({ onFocus, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
    return (
        <TooltipPrimitive.Trigger
            data-slot="tooltip-trigger"
            // Radix opens on any focus no pointer pressed, a returned one included (radix-ui/primitives#1800). It skips
            // its own handler once this one prevents the default.
            onFocus={(event) => {
                onFocus?.(event);
                if (!hasFocusRing(event.currentTarget)) event.preventDefault();
            }}
            {...props}
        />
    );
}

function TooltipContent({
    className,
    sideOffset = 0,
    children,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                data-slot="tooltip-content"
                sideOffset={sideOffset}
                className={cn(
                    'select-none bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit rounded-md px-3 py-1.5 text-xs text-balance',
                    className,
                )}
                {...props}
            >
                {children}
                <TooltipPrimitive.Arrow className="select-none bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}

export { Tooltip, TooltipContent, TooltipTrigger };
