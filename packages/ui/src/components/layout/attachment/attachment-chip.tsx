import { getDriveDownloadUrl, getDriveThumbnailUrl } from '@workspace/lib/api';
import { useFolderLookup } from '@workspace/lib/drive';
import { cn } from '@workspace/ui/lib/utils';
import { Paperclip, X } from 'lucide-react';
import { usePreview } from '../preview-provider';

type AttachmentChipProps = {
    fileName: string;
    ownerId: string;
    mountId: string;
    mediaFolderId: string;
    onRemove?: () => void;
};

export function AttachmentChip({ fileName, ownerId, mountId, mediaFolderId, onRemove }: AttachmentChipProps) {
    const { findByName } = useFolderLookup(ownerId, mountId, mediaFolderId);
    const fileInfo = findByName(fileName);
    const { openPreview } = usePreview();

    const name = fileInfo?.details?.originalName || fileInfo?.name || fileName;
    const downloadUrl = fileInfo ? getDriveDownloadUrl(ownerId, mountId, fileInfo.id) : '#';
    const thumbnailUrl = fileInfo?.thumbnail ? getDriveThumbnailUrl(ownerId, mountId, fileInfo.thumbnail) : null;
    const isImage = fileInfo?.mimeType?.startsWith('image/');

    const handleClick = (e: React.MouseEvent) => {
        if (fileInfo) {
            e.preventDefault();
            openPreview(fileInfo);
        }
    };

    return (
        <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground hover:bg-muted/80 transition-colors border overflow-hidden min-h-10',
                onRemove && 'pr-1',
            )}
            onClick={handleClick}
        >
            {thumbnailUrl && isImage ? (
                <img src={thumbnailUrl} alt={name} className="h-10 w-10 object-cover rounded-l-md" />
            ) : null}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                {!thumbnailUrl && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                <span className="truncate max-w-[200px]">{name}</span>
            </div>
            {onRemove && (
                <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20 transition-colors"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRemove();
                    }}
                >
                    <X className="h-3 w-3" />
                </button>
            )}
        </a>
    );
}
