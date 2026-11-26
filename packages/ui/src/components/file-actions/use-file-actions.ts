// The registry rows a surface may draw for this viewer on this server. A registry predicate is handed the file
// alone, so this is the one caller that knows who is asking and whether mail is hosted: an import route refuses a
// guest, and a visitor without a login only reads. Every menu and the quick-look footer read their rows off
// `useFileActionRunner`, which reads them here.

import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { fileActionsFor } from '@workspace/lib/file-actions';
import { useMailEnabled } from '@workspace/lib/public';
import type { FileAction, FileActionId, FileSubject } from '@workspace/lib/types/file-subject';

const VISITOR_ACTIONS: readonly FileActionId[] = ['quick-look', 'download'];

export function useFileActions(subject: FileSubject | null, exclude?: readonly FileActionId[]): FileAction[] {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const mailEnabled = useMailEnabled();
    if (!subject) return [];
    return fileActionsFor(subject, exclude).filter((action) =>
        user
            ? !(isGuest && action.guestDenied) && (mailEnabled || !action.mailOnly)
            : VISITOR_ACTIONS.includes(action.id),
    );
}
