import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { ReferenceAttachmentChip, SimpleAttachmentChip } from '@workspace/ui/components/attachment';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    driveReferences: AttachmentReference[];
    onRemove: (index: number) => void;
    onRemoveReference: (id: string) => void;
};

export function DraftAttachments({ attachments, driveReferences, onRemove, onRemoveReference }: DraftAttachmentsProps) {
    if (attachments.length === 0 && driveReferences.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2 app-gutter-x pb-2">
            {attachments.map((att, i) => (
                <SimpleAttachmentChip key={att.key} filename={att.filename} onRemove={() => onRemove(i)} />
            ))}
            {driveReferences.map((ref) => (
                <ReferenceAttachmentChip key={ref.id} reference={ref} onRemove={() => onRemoveReference(ref.id)} />
            ))}
        </div>
    );
}
