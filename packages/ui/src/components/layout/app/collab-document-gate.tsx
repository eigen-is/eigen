import type { DrivePath } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { CollabLoadingState } from './collab-loading-state';

type CollabDocumentGateProps = {
    // From useCollabDoc — latched, so a WS blip never unmounts the editor.
    loaded: boolean;
    storageUnavailable: boolean;
    storageGone: boolean;
    path: DrivePath;
    canWrite: boolean;
    children: ReactNode;
};

// Every collab editor renders its toolbar and body only once the document has loaded.
export function CollabDocumentGate({ loaded, children, ...status }: CollabDocumentGateProps) {
    if (!loaded) return <CollabLoadingState {...status} />;
    return children;
}
