import { getDriveItemUrl } from '@workspace/lib/api';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { ExternalLink } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { getFileIcon } from '../drive/file-presentation';
import { AttachmentChipRemoveButton, CHIP_BASE_CLASS } from './attachment-chip-shared';

type ReferenceAttachmentChipProps = {
    reference: AttachmentReference;
    // Shows an X button — use for the composer remove action.
    onRemove?: () => void;
    className?: string;
};

// Chip for eigendoc/folder reference attachments in chat messages.
// Clicking opens the referenced item in a new tab. No thumbnail (can't resolve cross-mount).
export function ReferenceAttachmentChip({ reference, onRemove, className }: ReferenceAttachmentChipProps) {
    const displayName = stripEigenExtension(reference.name);

    const outerClass = cn(CHIP_BASE_CLASS, 'hover:bg-muted/80 transition-colors cursor-pointer', className);

    function handleClick() {
        const url = getDriveItemUrl({
            id: reference.id,
            mountId: reference.mountId,
            ownerId: reference.ownerId,
            name: reference.name,
            type: reference.driveType,
            mimeType: reference.mimeType,
        });
        if (url) {
            window.open(url, '_blank');
        }
    }

    return (
        <div
            className={outerClass}
            onClick={handleClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleClick();
            }}
        >
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                {getFileIcon(reference.mimeType, reference.driveType, {
                    className: 'h-3 w-3 text-muted-foreground shrink-0',
                })}
                <span className="truncate max-w-[200px]">{onRemove ? displayName : `Open ${displayName}`}</span>
                {!onRemove && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
            </div>
            {onRemove && <AttachmentChipRemoveButton label={displayName} onRemove={onRemove} />}
        </div>
    );
}
