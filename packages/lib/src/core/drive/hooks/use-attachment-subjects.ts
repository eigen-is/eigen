import { useCallback } from 'react';
import type { ChatAttachment } from '../../../types/chat';
import type { FileSubject } from '../../../types/file-subject';
import { subjectFromPath } from '../../file-subject';
import { useFolderLookup } from './reads';

// A container's uploaded attachments as subjects: a chat message, a card or a chip names its files, and
// the media folder resolves them. Reference attachments are not files and yield nothing.
export function useAttachmentSubjects(
    ownerId: string,
    mountId: string,
    mediaFolderId: string | null,
): {
    subjectOf: (name: string | null) => FileSubject | undefined;
    subjectsOf: (attachments: readonly ChatAttachment[] | null | undefined) => FileSubject[];
} {
    const { findByName } = useFolderLookup(ownerId, mountId, mediaFolderId);
    const subjectOf = useCallback(
        (name: string | null) => {
            const path = name ? findByName(name) : undefined;
            return path && { ...subjectFromPath(path), attachment: true as const };
        },
        [findByName],
    );
    const subjectsOf = useCallback(
        (attachments: readonly ChatAttachment[] | null | undefined) =>
            (attachments ?? []).flatMap((attachment) => {
                const subject = typeof attachment === 'string' ? subjectOf(attachment) : undefined;
                return subject ? [subject] : [];
            }),
        [subjectOf],
    );
    return { subjectOf, subjectsOf };
}
