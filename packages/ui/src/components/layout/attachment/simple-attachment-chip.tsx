import { Download, Paperclip } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { AttachmentChipRemoveButton, CHIP_BASE_CLASS } from './attachment-chip-shared';

type SimpleAttachmentChipProps = {
    filename: string;
    // Wraps the chip in an anchor with `download` pointing at this URL. Shows a Download icon.
    downloadUrl?: string;
    // Intercepts the anchor click — use when the chip should open a preview instead of downloading.
    onClick?: (e: MouseEvent) => void;
    // Shows a 10x10 thumbnail on the left edge of the chip.
    thumbnailUrl?: string;
    // Shows an X button — use for the composer remove action.
    onRemove?: () => void;
    className?: string;
};

// Shared compact chip for attachment UIs (mail compose, mail reader, chat).
// One visual style, varying actions: remove (X), download (icon), or open-preview (onClick).
export function SimpleAttachmentChip({
    filename,
    downloadUrl,
    onClick,
    thumbnailUrl,
    onRemove,
    className,
}: SimpleAttachmentChipProps) {
    const outerClass = cn(
        CHIP_BASE_CLASS,
        (downloadUrl || onClick) && 'hover:bg-muted/80 transition-colors',
        className,
    );

    // Show the download icon for plain download chips. Drive-backed chips pass onClick to open the
    // preview overlay, and composer chips pass onRemove — both suppress the indicator.
    const showDownloadIcon = !!downloadUrl && !onClick && !onRemove;

    const content: ReactNode = (
        <>
            {thumbnailUrl ? (
                <img src={thumbnailUrl} alt={filename} className="h-10 w-10 object-cover rounded-l-md shrink-0" />
            ) : null}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                {!thumbnailUrl && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                <span className="truncate max-w-[200px]">{filename}</span>
                {showDownloadIcon && <Download className="h-3 w-3 text-muted-foreground shrink-0" />}
            </div>
            {onRemove && <AttachmentChipRemoveButton label={filename} onRemove={onRemove} />}
        </>
    );

    if (downloadUrl) {
        return (
            <a
                href={downloadUrl}
                download={filename}
                target="_blank"
                rel="noopener noreferrer"
                className={outerClass}
                onClick={onClick}
            >
                {content}
            </a>
        );
    }

    return <div className={outerClass}>{content}</div>;
}
