import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import { cn } from '@workspace/ui/lib/utils';
import { ReferenceAttachmentChip } from './reference-attachment-chip';
import { SimpleAttachmentChip } from './simple-attachment-chip';

type AttachmentDraftChipsProps = {
    items: CardAttachmentDraft[];
    onRemove?: (index: number) => void;
    className?: string;
};

// Renders any mix of staged attachment drafts: device Files, drive picks, settled
// filenames, and references. Pure — resolution/upload is the caller's concern.
export function AttachmentDraftChips({ items, onRemove, className }: AttachmentDraftChipsProps) {
    if (items.length === 0) return null;
    return (
        <div className={cn('flex flex-wrap gap-2', className)}>
            {items.map((item, i) => {
                const remove = onRemove ? () => onRemove(i) : undefined;
                if (item instanceof File) {
                    return <SimpleAttachmentChip key={`file-${i}`} filename={item.name} onRemove={remove} />;
                }
                if (typeof item === 'string') {
                    return <SimpleAttachmentChip key={`name-${item}`} filename={item} onRemove={remove} />;
                }
                if ('driveType' in item) {
                    return <ReferenceAttachmentChip key={`ref-${item.id}`} reference={item} onRemove={remove} />;
                }
                return <SimpleAttachmentChip key={`path-${item.id}`} filename={item.name} onRemove={remove} />;
            })}
        </div>
    );
}
