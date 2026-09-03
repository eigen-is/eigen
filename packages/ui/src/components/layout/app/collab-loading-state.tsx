import { useEffect, useState } from 'react';
import { LoadingState } from './loading-state';

// A cold open (home init + object download) is legitimately slow, so the bare spinner holds for the
// first stretch; past it, say what is taking so long instead of leaving the user guessing.
const SLOW_NOTICE_MS = 10_000;

type CollabLoadingStateProps = {
    // From useCollabDoc — the WS closed with the storage-unavailable code and is retrying.
    storageUnavailable: boolean;
};

export function CollabLoadingState({ storageUnavailable }: CollabLoadingStateProps) {
    const [slow, setSlow] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setSlow(true), SLOW_NOTICE_MS);
        return () => clearTimeout(timer);
    }, []);

    const notice = storageUnavailable
        ? 'Storage is temporarily unavailable, retrying automatically'
        : slow
          ? 'Storage is responding slowly, still connecting…'
          : undefined;

    return <LoadingState message={notice} />;
}
