import { getDriveItemThumbnail } from '@workspace/lib/api';
import { useMediaResolver } from '@workspace/lib/drive';
import type { ChatAttachment } from '@workspace/lib/types/chat';

// Board/panel card adornments for attachments: the first image attachment's thumbnail as a
// cover, plus a count. Filename resolution rides MediaResolver's cached folder lookup, so one
// query serves every card on a board. References are skipped for the cover (no thumbnail).
export function useAttachmentMeta(attachments?: ChatAttachment[]): {
    coverThumbnailUrl?: string;
    attachmentCount: number;
} {
    const { resolveMediaPath } = useMediaResolver();
    if (!attachments?.length) return { attachmentCount: 0 };
    for (const attachment of attachments) {
        if (typeof attachment !== 'string') continue;
        const path = resolveMediaPath(attachment);
        if (path?.thumbnail && path.mimeType?.startsWith('image/')) {
            return {
                coverThumbnailUrl: getDriveItemThumbnail(path).thumbnailUrl,
                attachmentCount: attachments.length,
            };
        }
    }
    return { attachmentCount: attachments.length };
}
