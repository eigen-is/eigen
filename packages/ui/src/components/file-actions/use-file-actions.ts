import { useIsGuest } from '@workspace/lib/auth';
import { fileActionsFor, GUEST_DENIED_ACTIONS } from '@workspace/lib/file-actions';
import type { FileAction, FileActionId, FileSubject } from '@workspace/lib/types/file-subject';

// The registry rows a surface may draw for this viewer. The one caller that knows who is asking: an
// import route refuses a guest, and a registry predicate is handed the file alone. Every menu and the
// quick-look footer read their rows off `useFileActionRunner`, which reads them here.
export function useFileActions(subject: FileSubject | null, exclude?: readonly FileActionId[]): FileAction[] {
    const isGuest = useIsGuest();
    if (!subject) return [];
    return fileActionsFor(subject, isGuest ? [...(exclude ?? []), ...GUEST_DENIED_ACTIONS] : exclude);
}
