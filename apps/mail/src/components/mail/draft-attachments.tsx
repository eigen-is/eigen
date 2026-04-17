import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { SimpleAttachmentChip } from '@workspace/ui/components/layout/attachment';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    onRemove: (index: number) => void;
};

export function DraftAttachments({ attachments, onRemove }: DraftAttachmentsProps) {
    if (attachments.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
            {attachments.map((att, i) => (
                <SimpleAttachmentChip key={att.key} filename={att.filename} onRemove={() => onRemove(i)} />
            ))}
        </div>
    );
}
