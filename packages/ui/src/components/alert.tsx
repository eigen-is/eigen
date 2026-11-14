// shadcn's Alert: a bordered note inside a page or dialog, plain or destructive, such as a warning above Admin's
// backup settings or a notice in Drive's trash.

import { cn } from '@workspace/ui/lib/utils';
import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';
import type * as React from 'react';

const alertVariants = cva(
    'relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:text-foreground [&>svg~*]:pl-7',
    {
        variants: {
            variant: {
                default: 'bg-background text-foreground',
                destructive: 'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
                warning: 'border-warning/50 text-warning dark:border-warning [&>svg]:text-warning',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    },
);

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
    return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
    return <div className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />;
}

export { Alert, AlertDescription };
