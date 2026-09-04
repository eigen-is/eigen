// The body every eigendoc editor route shares: resolve the document, show the status screen while it
// is still resolving or has failed, hand a denied reader the request-access screen, and otherwise
// render the app's editor beside the share dialog. The five routes then differ only in which editor
// they mount and what extra search params they thread into it.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { useEigenDocEditorRoute } from '../../../hooks/use-eigen-doc-editor-route';
import { DriveAccessDialog } from '../../drive/drive-access-dialog';
import { EigenDocRouteStatus } from './eigen-doc-route-status';
import { RequestAccessView } from './request-access-view';

// What every editor takes; an app adds its own props around these.
type EigenDocEditorProps = {
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};

export function EigenDocEditorRoute({
    ownerId,
    mountId,
    pathId,
    children,
}: {
    ownerId: string;
    mountId: string;
    pathId: string;
    children: (props: EigenDocEditorProps) => ReactNode;
}) {
    const {
        docInfo,
        isError,
        error,
        refetch,
        path,
        mediaFolderId,
        chatFolderId,
        accessDialogOpen,
        openAccessDialog,
        setAccessDialogOpen,
    } = useEigenDocEditorRoute(ownerId, mountId, pathId);

    if (!docInfo) return <EigenDocRouteStatus isError={isError} error={error} onRetry={refetch} />;
    if (!docInfo.canRead || !path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return (
        <>
            {children({
                path,
                canWrite: docInfo.canWrite,
                mediaFolderId,
                chatFolderId,
                onAccessDialogOpen: openAccessDialog,
            })}
            <DriveAccessDialog path={path} open={accessDialogOpen} onOpenChange={setAccessDialogOpen} />
        </>
    );
}
