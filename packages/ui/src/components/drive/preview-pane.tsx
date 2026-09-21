import { formatFileSize } from '@workspace/lib/format';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { LoadingState } from '../layout/app/loading-state';

// The box every non-image preview fills: the overlay's content area minus its header and footer. On a
// phone it takes the whole width the overlay allows, so a message reads in the column width the mail
// reader gives it rather than in two thirds of it.
export const PREVIEW_PANE_CLASS = 'w-[90vw] sm:w-[80vw] h-[calc(100vh-7rem)]';

// The gutter a payload draws in: the reader's on a phone, roomier once there is room.
export const PREVIEW_BODY_CLASS = 'p-4 sm:p-8';

type PreviewPaneProps = {
    // Past its format's import ceiling nothing was fetched, because the route would refuse the file.
    oversize: boolean;
    maxBytes: number;
    // The query's own pending state, not `isLoading`: a query still disabled (the owner is not known
    // until auth settles) is not fetching either, and has nothing to show but the loader.
    isPending: boolean;
    unreadable: boolean;
    children: ReactNode;
};

// The pane a typed-payload quick look draws into, and the three states it reaches before its payload:
// too large, still loading, unreadable. Shared so a `.vcf`, an `.eml` and an `.ics` say the same things.
export function PreviewPane({ oversize, maxBytes, isPending, unreadable, children }: PreviewPaneProps) {
    return (
        <div className={cn(PREVIEW_PANE_CLASS, 'overflow-auto rounded bg-background')}>
            {oversize ? (
                <EmptyState
                    message="File too large to preview"
                    hint={`A file over ${formatFileSize(maxBytes)} can’t be imported either.`}
                />
            ) : isPending ? (
                <LoadingState />
            ) : unreadable ? (
                <ErrorState message="Could not read this file" />
            ) : (
                children
            )}
        </div>
    );
}
