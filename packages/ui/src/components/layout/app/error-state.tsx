// The centered message a page or panel shows in place of what failed to load, such as a Drive list or
// the error boundary's fallback, with an optional detail line and action under it. Its default
// sentence is the one every Drive list shows on a failed load, as EmptyState's is for an empty one.

import type { ReactNode } from 'react';

type ErrorStateProps = {
    message?: string;
    detail?: string;
    action?: ReactNode;
};

export function ErrorState({
    message = 'Encountering the null vector: a rendezvous with nothing at all.',
    detail,
    action,
}: ErrorStateProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-2 p-8 text-center">
            <p className="text-destructive">{message}</p>
            {detail && <p className="text-muted-foreground text-sm">{detail}</p>}
            {action}
        </div>
    );
}
