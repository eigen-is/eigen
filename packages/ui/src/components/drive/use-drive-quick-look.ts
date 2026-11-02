// What Space does on a row of a Drive listing: it opens the quick look, with the listing's other items to
// page through. Drive's list routes and the document apps' own lists, such as the Docs index, both use it.
// It lives apart from the Drive route wiring because that wiring navigates to routes only Drive has.

import { fileActionsFor } from '@workspace/lib/file-actions';
import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types/drive';
import { usePreview } from '../preview-provider';

// Space is the menu's Quick preview row, so it previews only what that row offers: never a folder.
// `canWrite` is the view's, since the preview's convert rows need somewhere to write.
export function useDriveQuickLook(canWrite: boolean): (path: DrivePath, sortedSiblings: DrivePath[]) => void {
    const { openPreview } = usePreview();
    const subjectOf = (path: DrivePath) => subjectFromPath(path, canWrite);
    return (path, sortedSiblings) => {
        const subject = subjectOf(path);
        if (fileActionsFor(subject).some((action) => action.id === 'quick-look')) {
            openPreview(subject, sortedSiblings.map(subjectOf));
        }
    };
}
