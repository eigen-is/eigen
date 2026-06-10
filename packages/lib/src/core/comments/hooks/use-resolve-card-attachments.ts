import { useCopyToMediaFolder, useUploadFile } from '@workspace/lib/drive';
import { useCallback } from 'react';
import type { ChatAttachment } from '../../../types/chat';
import type { CardAttachmentDraft } from '../../../types/comments';
import { isContainerType } from '../../../types/drive';
import { toAttachmentReference } from '../../../types/drive-reference';

// Settles card-form drafts into persistable attachments at Save time (never at pick time, so
// Cancel leaves no orphans). Device files upload into the container's media/ folder; regular
// drive picks are copied there too — the container's ACL must cover them for every collaborator
// (same rule as chat) — while containers stay lightweight references.
export function useResolveCardAttachments(ownerId: string, mountId: string, mediaFolderId: string | null) {
    const uploadFile = useUploadFile(ownerId, mountId);
    const copyToMediaFolder = useCopyToMediaFolder(ownerId, mountId);

    return useCallback(
        async (drafts: CardAttachmentDraft[]): Promise<ChatAttachment[]> => {
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
                    const copied = await copyToMediaFolder.mutateAsync({ paths: [draft], mediaFolderId });
                    if (copied[0]) resolved.push(copied[0].name);
                }
            }
            return resolved;
        },
        [uploadFile.mutateAsync, copyToMediaFolder.mutateAsync, mediaFolderId],
    );
}
