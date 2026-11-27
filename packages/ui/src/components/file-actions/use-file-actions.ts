// The registry rows a surface may draw for this viewer on this server. A registry predicate is handed the file
// alone, so this is where the rows pass the viewer filter the Drive actions share, such as an import a guest's route
// refuses or the reads a visitor without a login may use. Every menu and the quick-look footer read their rows off
// `useFileActionRunner`, which reads them here.

import { useViewerMayUse } from '@workspace/lib/drive';
import { fileActionsFor } from '@workspace/lib/file-actions';
import type { FileAction, FileActionId, FileSubject } from '@workspace/lib/types/file-subject';

export function useFileActions(subject: FileSubject | null, exclude?: readonly FileActionId[]): FileAction[] {
    const mayUse = useViewerMayUse();
    if (!subject) return [];
    return fileActionsFor(subject, exclude).filter(mayUse);
}
