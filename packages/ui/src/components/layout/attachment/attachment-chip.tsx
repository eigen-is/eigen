import { getDriveDownloadUrl, getDriveThumbnailUrl } from '@workspace/lib/api';
import { useFolderLookup } from '@workspace/lib/drive';
import { usePreview } from '../preview-provider';
import { SimpleAttachmentChip } from './simple-attachment-chip';

type AttachmentChipProps = {
    fileName: string;
    ownerId: string;
    mountId: string;
    mediaFolderId: string;
    onRemove?: () => void;
};

// Drive-backed chip: resolves the filename to a drive item and renders the shared chip with
// its thumbnail. Clicking opens the preview overlay instead of triggering a browser download.
export function AttachmentChip({ fileName, ownerId, mountId, mediaFolderId, onRemove }: AttachmentChipProps) {
    const { findByName } = useFolderLookup(ownerId, mountId, mediaFolderId);
    const fileInfo = findByName(fileName);
    const { openPreview } = usePreview();

    const name = fileInfo?.details?.originalName || fileInfo?.name || fileName;
    const downloadUrl = fileInfo ? getDriveDownloadUrl(ownerId, mountId, fileInfo.id) : '#';
    const thumbnailUrl =
        fileInfo?.thumbnail && fileInfo.mimeType?.startsWith('image/')
            ? getDriveThumbnailUrl(ownerId, mountId, fileInfo.thumbnail)
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
                    openPreview(fileInfo);
                }
            }}
        />
    );
}
