// The row wiring every Drive list route shares, such as the folder view or Shared with me: what a row
// does when it is selected, activated or quick-looked. A route passes its items and capabilities, where
// a folder opens and where a selected row navigates, and hands the handlers to DriveLayout.

import { useNavigate } from '@tanstack/react-router';
import { openDocument } from '@workspace/lib/api';
import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isDocumentType, isFolderType } from '@workspace/lib/types/drive';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import { isInlineEditable } from '@workspace/lib/types/file-kinds';
import { useLayout } from '../layout/app/layout-context';
import { usePreview } from '../preview-provider';
import { useDriveQuickLook } from './use-drive-quick-look';

type UseDriveListRouteOptions = {
    // The unsorted items backing the list: the fallback preview passes this whole set as siblings.
    items: DrivePath[];
    // The view's own capabilities: the preview's convert rows need somewhere to write.
    capabilities: DriveCapabilities;
    // Where a folder opens: the folder view, for example, stays in its own route.
    onOpenFolder: (path: DrivePath) => void;
    // Where a single click on a desktop row navigates.
    onSelectItem: (path: DrivePath) => void;
};

type DriveListRouteHandlers = {
    onRowSelect: (path: DrivePath) => void;
    onRowActivate: (path: DrivePath) => void;
    onQuickLook: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
};

// A row activates by its kind: a folder opens in the route, a document in its app, an editable text file
// in the editor, anything else in the preview. Selecting a row updates an open preview, and on mobile a
// folder or a document opens straight away.
export function useDriveListRoute({
    items,
    capabilities,
    onOpenFolder,
    onSelectItem,
}: UseDriveListRouteOptions): DriveListRouteHandlers {
    const navigate = useNavigate();
    const { isMobile } = useLayout();
    const { openPreview, updatePreview, isPreviewOpen } = usePreview();
    const onQuickLook = useDriveQuickLook(capabilities.canWrite);

    const subjectOf = (path: DrivePath) => subjectFromPath(path, capabilities.canWrite);

    const onRowActivate = (path: DrivePath) => {
        if (path.type === 'folder') {
            onOpenFolder(path);
        } else if (isDocumentType(path.type)) {
            openDocument(path);
        } else if (isInlineEditable(path.mimeType, path.name)) {
            // Widened like auth-route's `to`: this file compiles in every app's router, and only Drive has the editor.
            const editorPath: string = `/edit/${path.ownerId}/${path.mountId}/${path.id}`;
            navigate({ to: editorPath });
        } else {
            openPreview(subjectOf(path), items.map(subjectOf));
        }
    };

    const onRowSelect = (path: DrivePath) => {
        if (isPreviewOpen) {
            updatePreview(subjectOf(path));
        }

        if (isMobile && (isFolderType(path.type) || isDocumentType(path.type))) {
            onRowActivate(path);
        } else {
            onSelectItem(path);
        }
    };

    return { onRowSelect, onRowActivate, onQuickLook };
}
