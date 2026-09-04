import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteDocSelection } from '@workspace/lib/command-palette';
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

// Shared scaffold for the EigenDoc editor routes (docs/slides/sheets/stickies/vector).
// Each route loads the same collab document info, mirrors the doc name into the
// document title, publishes the open doc as a palette selection, derives the media/chat
// folder ids, and owns the access-dialog open state. Editors differ only in the JSX they
// render around this — so the route bodies collapse to a guard plus their own component.
export function useEigenDocEditorRoute(ownerId: string, mountId: string, pathId: string): EigenDocEditorRoute {
    const { data: docInfo, isError, error, refetch } = useCollabDocumentInfo(ownerId, mountId, pathId);
    const { setDocumentTitle } = useLayout();
    const [accessDialogOpen, setAccessDialogOpen] = useState(false);

    useEffect(() => {
        const title = docInfo?.path ? stripEigenExtension(docInfo.path.name) : '';
        setDocumentTitle(title);
        return () => setDocumentTitle('');
    }, [docInfo?.path?.name, setDocumentTitle]);

    // Publish the open document as a 1-item palette selection so item-aware commands
    // (Mail to…, Copy link, …) surface from anywhere. DrivePath already carries mountId.
    usePaletteDocSelection(docInfo?.path);

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
