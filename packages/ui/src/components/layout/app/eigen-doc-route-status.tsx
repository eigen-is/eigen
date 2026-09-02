import { Button } from '../../button';
import { ErrorState } from './error-state';
import { LoadingState } from './loading-state';

type EigenDocRouteStatusProps = {
    // From useEigenDocEditorRoute — the doc-info query has no answer yet.
    isError: boolean;
    error: Error | null;
    onRetry: () => void;
};

// The pre-editor screen every EigenDoc editor route renders while its doc-info query has no answer:
// a spinner, or the failure treatment. A failed query is not a verdict on access, so the route must
// not offer to request access to a document the user may already own. Retry rather than reload: the
// query's own attempts are exhausted by now, and a transient /info failure should not cost the tab.
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
