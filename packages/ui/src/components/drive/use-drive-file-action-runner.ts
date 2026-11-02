// The file-action runner of one Drive item, such as its Quick preview, Download or a convert, built the same
// way by every Drive host of those rows, for example the row's menu and the detail column. A multi-selection
// gets a runner with no subject, since it has no file actions.

import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useMemo } from 'react';
import type { FileActionRunner } from '../file-actions/use-file-action-runner';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';

// Quick preview pages through the listing, in its display order. A convert writes beside its source, so it
// needs the view's write access.
export function useDriveFileActionRunner(
    item: DrivePath | null,
    listing: readonly DrivePath[],
    canWrite: boolean,
): FileActionRunner {
    const subject = useMemo(() => (item ? subjectFromPath(item, canWrite) : null), [item, canWrite]);
    // Mapped only for an item: a folder listing can run to thousands of rows.
    const siblings = useMemo(
        () => (item ? listing.map((sibling) => subjectFromPath(sibling, canWrite)) : []),
        [item, listing, canWrite],
    );
    return useFileActionRunner(subject, siblings);
}
