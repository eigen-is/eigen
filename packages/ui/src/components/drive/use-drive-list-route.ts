import { useNavigate } from '@tanstack/react-router';
import { openDocument } from '@workspace/lib/api';
import { type DrivePath, isDocumentType, isFolderType, isInlineEditable } from '@workspace/lib/types/drive';
import { useLayout } from '../layout/app/layout-context';
import { usePreview } from '../preview-provider';

type UseDriveListRouteOptions = {
    // The unsorted items backing the list — the fallback preview passes this whole set as siblings.
    items: DrivePath[];
    // Folder-branch target: fs stays in-route, shared/watched jump to /fs, mime clears the selection.
    onOpenFolder: (path: DrivePath) => void;
    // Desktop row-select target: where a single click on a non-openable row navigates.
    onSelectItem: (path: DrivePath) => void;
};

type DriveListRouteHandlers = {
    onRowSelect: (path: DrivePath) => void;
    onRowActivate: (path: DrivePath) => void;
    onQuickLook: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
};

// Shared scaffold for the four Drive list routes (fs, mime, shared, watched). Every view runs the
// same row wiring — quick-look opens the preview; a row activates by kind (folder → route,
// eigen-doc → openDocument, inline-editable → /edit, else preview); selecting a row updates an open
// preview and, on mobile, activates folders/docs straight away. Only the folder target and the
// desktop select target vary, so the routes pass those two closures and keep the rest here.
export function useDriveListRoute({
    items,
    onOpenFolder,
    onSelectItem,
}: UseDriveListRouteOptions): DriveListRouteHandlers {
    const navigate = useNavigate();
    const { isMobile } = useLayout();
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();

    const onQuickLook = (path: DrivePath, sortedSiblings: DrivePath[]) => {
        openPreview(path, sortedSiblings);
    };

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            onOpenFolder(path);
        } else if (isDocumentType(path.type)) {
            openDocument(path);
        } else if (isInlineEditable(path.mimeType, path.name)) {
            navigate({
                to: '/edit/$ownerId/$mountId/$pathId',
                params: { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id },
            });
        } else {
            openPreview(path, items);
        }
    };

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(path);
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            onSelectItem(path);
        }
    };

    return { onRowSelect, onRowActivate, onQuickLook };
}
