import type { CollabDoc } from '@workspace/lib/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { CollabLoadingState } from './collab-loading-state';

type CollabDocumentGateProps = {
    // `loaded` is latched, so a WS blip never unmounts the editor.
    collab: Pick<CollabDoc, 'loaded' | 'storageUnavailable' | 'storageGone'>;
    path: DrivePath;
    canWrite: boolean;
    children: ReactNode;
};

// Every collab editor renders its toolbar and body only once the document has loaded.
export function CollabDocumentGate({ collab, path, canWrite, children }: CollabDocumentGateProps) {
    if (!collab.loaded) {
        return (
            <CollabLoadingState
                storageUnavailable={collab.storageUnavailable}
                storageGone={collab.storageGone}
                path={path}
                canWrite={canWrite}
            />
        );
    }
    return children;
}
