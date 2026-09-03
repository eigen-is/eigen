import { Button } from '../../button';
import { ErrorState } from './error-state';
import { LoadingState } from './loading-state';

type EigenDocRouteStatusProps = {
    // From useEigenDocEditorRoute — the doc-info query has no answer yet.
    isError: boolean;
    error: Error | null;
    onRetry: () => void;
};

// What an EigenDoc editor route renders until its doc-info query answers. A failed query is not a
// verdict on access, so this never offers to request it; retry, because the query's own attempts are spent.
export function EigenDocRouteStatus({ isError, error, onRetry }: EigenDocRouteStatusProps) {
    if (!isError) return <LoadingState />;
    return (
        <ErrorState
            message="Could not open this document."
            detail={error?.message}
            action={<Button onClick={onRetry}>Try again</Button>}
        />
    );
}
