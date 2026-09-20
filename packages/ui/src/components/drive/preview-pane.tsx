import { formatFileSize } from '@workspace/lib/format';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { LoadingState } from '../layout/app/loading-state';

// The box every non-image preview fills: the overlay's content area minus its header and footer.
export const PREVIEW_PANE_CLASS = 'w-[80vw] h-[calc(100vh-7rem)]';

type PreviewPaneProps = {
    // Past its format's import ceiling nothing was fetched, because the route would refuse the file.
    oversize: boolean;
    maxBytes: number;
    isLoading: boolean;
    unreadable: boolean;
    children: ReactNode;
};

// The pane a typed-payload quick look draws into, and the three states it reaches before its payload:
// too large, still loading, unreadable. Shared so a `.vcf`, an `.eml` and an `.ics` say the same things.
export function PreviewPane({ oversize, maxBytes, isLoading, unreadable, children }: PreviewPaneProps) {
    return (
        <div className={cn(PREVIEW_PANE_CLASS, 'overflow-auto rounded bg-background')}>
            {oversize ? (
                <EmptyState
                    message="File too large to preview"
                    hint={`A file over ${formatFileSize(maxBytes)} can’t be imported either.`}
                />
            ) : isLoading ? (
                <LoadingState />
            ) : unreadable ? (
                <ErrorState message="Could not read this file" />
            ) : (
                children
            )}
        </div>
    );
}
