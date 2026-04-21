import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';

export function InfoBlock({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            className={cn('flex items-center justify-between rounded-md bg-muted/50 px-3 py-2', className)}
            {...props}
        />
    );
}
