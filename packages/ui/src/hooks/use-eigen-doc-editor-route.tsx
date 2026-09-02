import { useNavigate } from '@tanstack/react-router';
import { useCollabDocumentInfo } from '@workspace/lib/collab';
import { usePaletteDocSelection } from '@workspace/lib/command-palette';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ErrorState } from '../components/layout/app/error-state';
import { useLayout } from '../components/layout/app/layout-context';
import { LoadingState } from '../components/layout/app/loading-state';

type EigenDocEditorRoute = {
    docInfo: CollabDocumentInfo | undefined;
    // The pre-editor screen for the doc-info query, or null once it has an answer: the spinner while
    // it loads, ErrorState when it fails (a failed query is not a verdict on access — the route must
    // not offer to request access to a document the user may already own). All five editor routes
    // render it as their first guard, so the failure treatment exists once, not per app.
    statusView: ReactNode | null;
    path: DrivePath | null;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    accessDialogOpen: boolean;
    openAccessDialog: () => void;
    setAccessDialogOpen: (open: boolean) => void;
};

// The ?q= landing term for the in-document find bar, shared by the doc/slide/board/sheet routes. Latched once:
// the editors defer their subtree until collab sync, so the DocSearchProvider mounts long after the
// route resolves — a clear timed against the consumer's mount would race it and wipe q first.
// Latched, the URL strip is timing-proof (replace: true → no history entry; the link still works on
// the next visit). Latches per MOUNT: unreachable today (palette links full-reload via
// window.location.href), but if CommandContext.navigate ever goes through the router, latch per pathId.
export function useLatchedDocSearchTerm(q: string | undefined): string | undefined {
    const navigate = useNavigate();
    const [initialSearchTerm] = useState(q);
    useEffect(() => {
        if (q) {
            navigate({ to: '.', search: (prev: { q?: string }) => ({ ...prev, q: undefined }), replace: true });
        }
    }, [q, navigate]);
    return initialSearchTerm;
}

// Shared scaffold for the EigenDoc editor routes (docs/slides/sheets/stickies/vector).
// Each route loads the same collab document info, mirrors the doc name into the
// document title, publishes the open doc as a palette selection, derives the media/chat
// folder ids, and owns the access-dialog open state. Editors differ only in the JSX they
// render around this — so the route bodies collapse to a guard plus their own component.
export function useEigenDocEditorRoute(ownerId: string, mountId: string, pathId: string): EigenDocEditorRoute {
    const { data: docInfo, isError, error } = useCollabDocumentInfo(ownerId, mountId, pathId);
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

    // Answer first, state second: a failed background refetch of a document we already have must not
    // unmount the open editor, and `isLoading` dips false between retry attempts — reading it would
    // flash the request-access screen mid-retry.
    const statusView = docInfo ? null : isError ? (
        <ErrorState message="Could not open this document." detail={error.message} />
    ) : (
        <LoadingState />
    );

    const path = docInfo?.path ?? null;
    const mediaFolderId = docInfo?.folderContents?.find((item) => item.name === 'media')?.id ?? null;
    const chatFolderId = docInfo?.folderContents?.find((item) => item.name === 'chat')?.id ?? null;

    return {
        docInfo,
        statusView,
        path,
        mediaFolderId,
        chatFolderId,
        accessDialogOpen,
        openAccessDialog,
        setAccessDialogOpen,
    };
}
