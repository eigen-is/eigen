// The scaffold every Eigen document editor route shares, such as the doc, sheet or board route: it
// loads the document's info, shows its name as the layout's document title, finds its media and chat
// folders and owns the access dialog's state. Editors differ only in the JSX around it, so a route body
// is a guard plus its own component. The editor's File menu hands the open document to the palette.

import { useCollabDocumentInfo } from '@workspace/lib/collab';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { useCallback, useEffect, useState } from 'react';
import { useLayout } from '../components/layout/app/layout-context';

type EigenDocEditorRoute = {
    // Routes gate on docInfo, not a loading flag: a failed background refetch must not unmount an
    // open editor, and isLoading dips false between retries. Until it lands, render EigenDocRouteStatus.
    docInfo: CollabDocumentInfo | undefined;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
    path: DrivePath | null;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    accessDialogOpen: boolean;
    openAccessDialog: () => void;
    setAccessDialogOpen: (open: boolean) => void;
};

export function useEigenDocEditorRoute(ownerId: string, mountId: string, pathId: string): EigenDocEditorRoute {
    const { data: docInfo, isError, error, refetch } = useCollabDocumentInfo(ownerId, mountId, pathId);
    const { setDocumentTitle } = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path ? stripEigenExtension(docInfo.path.name) : '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    const openAccessDialog = useCallback(() => setAccessDialogOpen(true), []);

    const path = docInfo?.path ?? null;
    const mediaFolderId = docInfo?.folderContents?.find((item) => item.name === 'media')?.id ?? null;
    const chatFolderId = docInfo?.folderContents?.find((item) => item.name === 'chat')?.id ?? null;

    return {
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
    };
}
