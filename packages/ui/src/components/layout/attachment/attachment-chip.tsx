import { getDriveDownloadUrl, getDriveItemThumbnail } from '@workspace/lib/api';
import { useFolderLookup } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { usePreview } from '../preview-provider';
import { SimpleAttachmentChip } from './simple-attachment-chip';

type AttachmentChipProps = {
    fileName: string;
    ownerId: string;
    mountId: string;
    mediaFolderId: string;
    siblingFileNames?: string[];
    onRemove?: () => void;
};

// Drive-backed chip: resolves the filename to a drive item and renders the shared chip with
// its thumbnail. Clicking opens the preview overlay instead of triggering a browser download.
export function AttachmentChip({
    fileName,
    ownerId,
    mountId,
    mediaFolderId,
    siblingFileNames,
    onRemove,
}: AttachmentChipProps) {
    const { findByName } = useFolderLookup(ownerId, mountId, mediaFolderId);
    const fileInfo = findByName(fileName);
    const { openPreview } = usePreview();

    const name = fileInfo?.details?.originalName || fileInfo?.name || fileName;
    const downloadUrl = fileInfo ? getDriveDownloadUrl(ownerId, mountId, fileInfo.id, fileInfo.updatedAt) : '#';
    const thumbnailUrl = fileInfo?.mimeType?.startsWith('image/')
        ? getDriveItemThumbnail(fileInfo).thumbnailUrl
        : undefined;

    return (
        <SimpleAttachmentChip
            filename={name}
            downloadUrl={downloadUrl}
            thumbnailUrl={thumbnailUrl}
            onRemove={onRemove}
            onClick={(e) => {
                if (fileInfo) {
                    e.preventDefault();
                    const siblings = siblingFileNames
                        ?.map((n) => findByName(n))
                        .filter((p): p is DrivePath => p !== undefined);
                    openPreview(fileInfo, siblings, { downloadMode: 'save-to-drive' });
                }
            }}
        />
    );
}
