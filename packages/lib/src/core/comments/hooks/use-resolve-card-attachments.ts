// Turns the attachments picked in a card form into ones a card can store, when the card is saved. Doing it
// at Save and not at pick time means Cancel leaves no orphan files. A file from the device is uploaded into
// the container's media folder. A file from Drive is copied there too, because every collaborator of the
// container must be able to read it, as in chat. A container, such as a document, stays a reference.

import { useCallback } from 'react';
import type { ChatAttachment } from '../../../types/chat';
import type { CardAttachmentDraft } from '../../../types/comments';
import { isContainerType } from '../../../types/drive';
import { toAttachmentReference } from '../../../types/drive-reference';
import { useCopyToMediaFolder, useUploadFile } from '../../drive';

export function useResolveCardAttachments(
    ownerId: string,
    mountId: string,
    mediaFolderId: string | null,
): (drafts: readonly CardAttachmentDraft[]) => Promise<ChatAttachment[]> {
    const uploadFile = useUploadFile(ownerId, mountId);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, mountId);

    return useCallback(
        async (drafts: readonly CardAttachmentDraft[]): Promise<ChatAttachment[]> => {
            const resolved: ChatAttachment[] = [];
            for (const draft of drafts) {
                if (draft instanceof File) {
                    if (!mediaFolderId) continue;
                    const uploaded = await uploadFile.mutateAsync({ parentId: mediaFolderId, file: draft });
                    resolved.push(uploaded.name);
                } else if (typeof draft === 'string' || 'driveType' in draft) {
                    resolved.push(draft);
                } else if (isContainerType(draft.type)) {
                    resolved.push(toAttachmentReference(draft));
                } else {
                    if (!mediaFolderId) continue;
                    const [copied] = await copyToMediaFolder({ paths: [draft], mediaFolderId });
                    resolved.push(copied.name);
                }
            }
            return resolved;
        },
        [uploadFile.mutateAsync, copyToMediaFolder, mediaFolderId],
    );
}
