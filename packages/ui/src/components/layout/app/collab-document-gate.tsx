// The gate every collab editor, such as a doc, a sheet or a drawing, wraps its toolbar and body in: until useCollabDoc
// says the document has loaded it shows the loading screen, so no toolbar exists before the document does.

import type { CollabDoc } from '@workspace/lib/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { CollabLoadingState } from './collab-loading-state';

type CollabDocumentGateProps = {
    collab: Pick<CollabDoc, 'loaded' | 'storageUnavailable' | 'storageGone' | 'loadError'>;
    path: DrivePath;
    canWrite: boolean;
    children: ReactNode;
};

export function CollabDocumentGate({ collab, path, canWrite, children }: CollabDocumentGateProps) {
    if (!collab.loaded) {
        return (
            <CollabLoadingState
                storageUnavailable={collab.storageUnavailable}
                storageGone={collab.storageGone}
                loadError={collab.loadError}
                path={path}
                canWrite={canWrite}
            />
        );
    }
    return children;
}
