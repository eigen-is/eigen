import { useAttachmentSubjects } from '@workspace/lib/drive';
import { subjectInfo } from '@workspace/lib/file-subject';
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
    const { subjectOf, subjectsOf } = useAttachmentSubjects(ownerId, mountId, mediaFolderId);
    const subject = subjectOf(fileName);
    const info = subject && subjectInfo(subject);
    const { openPreview } = usePreview();

    return (
        <SimpleAttachmentChip
            filename={subject?.drive?.details?.originalName || info?.name || fileName}
            mimeType={info?.mimeType}
            attachmentKey={fileName}
            downloadUrl={info?.downloadUrl ?? '#'}
            thumbnailUrl={info?.thumbnailUrl}
            onRemove={onRemove}
            onClick={(e) => {
                if (subject) {
                    e.preventDefault();
                    openPreview(subject, subjectsOf(siblingFileNames));
                }
            }}
        />
    );
}
