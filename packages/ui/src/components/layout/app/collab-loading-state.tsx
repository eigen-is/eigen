import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useState } from 'react';
import { StorageGoneVersions } from '../toolbar/version-history-menu';
import { ErrorState } from './error-state';
import { LoadingState } from './loading-state';

// A cold open (home init + object download) is legitimately slow, so the bare spinner holds for the
// first stretch; past it, say what is taking so long instead of leaving the user guessing.
const SLOW_NOTICE_MS = 10_000;

type CollabLoadingStateProps = {
    // From useCollabDoc — the WS closed with the storage-unavailable code and is retrying.
    storageUnavailable: boolean;
    // From useCollabDoc — the WS closed with the storage-gone code and stopped.
    storageGone: boolean;
    path: DrivePath;
    canWrite: boolean;
};

export function CollabLoadingState({ storageUnavailable, storageGone, path, canWrite }: CollabLoadingStateProps) {
    const [slow, setSlow] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setSlow(true), SLOW_NOTICE_MS);
        return () => clearTimeout(timer);
    }, []);

    if (storageGone) {
        return (
            <ErrorState
                message="The stored data for this document could not be found."
                detail={
                    canWrite
                        ? 'Restore a version from its history, or ask an admin to restore a backup.'
                        : 'Ask someone who can edit it to restore a version, or an admin to restore a backup.'
                }
                action={canWrite && <StorageGoneVersions path={path} />}
            />
        );
    }

    const notice = storageUnavailable
        ? 'Storage is temporarily unavailable, retrying automatically'
        : slow
          ? 'Storage is responding slowly, still connecting…'
          : undefined;

    return <LoadingState message={notice} />;
}
