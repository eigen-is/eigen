import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { useVersions } from '@workspace/lib/versioning';
import { useEffect, useState } from 'react';
import { Button } from '../../button';
import { RestoreVersionDialog } from '../toolbar/version-history-menu';
import { ErrorState } from './error-state';
import { LoadingState } from './loading-state';

// A cold open (home init + object download) is legitimately slow, so the bare spinner holds for the
// first stretch; past it, say what is taking so long instead of leaving the user guessing.
const SLOW_NOTICE_MS = 10_000;

type CollabLoadingStateProps = {
    // From useCollabDoc — the WS closed with the storage-unavailable code and is retrying.
    storageUnavailable: boolean;
    // From useCollabDoc — the WS closed with the storage-gone code and stopped.
    storageGone?: boolean;
    // Hosts whose File menu is not up before load pass these, so the gone state offers version history itself.
    path?: DrivePath;
    canWrite?: boolean;
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
                detail="Restore a version from its history, or ask an admin to restore a backup."
                action={path && canWrite && <StorageGoneVersions path={path} />}
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

function StorageGoneVersions({ path }: { path: DrivePath }) {
    const { data } = useVersions(path.ownerId, path.mountId, path.id);
    const [pendingSnapshot, setPendingSnapshot] = useState<Snapshot | null>(null);

    if (!data || data.length === 0) return null;

    return (
        <>
            <div className="mt-2 flex max-h-64 min-w-[240px] flex-col overflow-y-auto">
                {data.map((snap) => (
                    <Button
                        key={snap.id}
                        variant="ghost"
                        className="justify-between gap-4"
                        onClick={() => setPendingSnapshot(snap)}
                    >
                        <span>{formatDateTime(snap.createdAt)}</span>
                        <span className="text-xs text-muted-foreground">Restore</span>
                    </Button>
                ))}
            </div>
            <RestoreVersionDialog
                path={path}
                snapshot={pendingSnapshot}
                storageGone
                onClose={() => setPendingSnapshot(null)}
            />
        </>
    );
}
