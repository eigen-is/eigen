// shadcn's Collapsible on Radix: a trigger that shows and hides a region below it, such as a
// folder's children in a sidebar tree. The content animates open and closed with Radix's height variable.

import { cn } from '@workspace/ui/lib/utils';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type * as React from 'react';

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
    return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
    return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
    return (
        <CollapsiblePrimitive.Content
            data-slot="collapsible-content"
            className={cn(
                'overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
                className,
            )}
            {...props}
        />
    );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
