// The files staged on a mail being written, uploads and Drive picks alike, each chip with a remove
// button. The compose window renders it above the editor.

import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { AttachmentStrip, ReferenceAttachmentChip, SimpleAttachmentChip } from '@workspace/ui/components/attachment';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    driveReferences: AttachmentReference[];
    onRemove: (index: number) => void;
    onRemoveReference: (id: string) => void;
};

export function DraftAttachments({ attachments, driveReferences, onRemove, onRemoveReference }: DraftAttachmentsProps) {
    if (attachments.length === 0 && driveReferences.length === 0) return null;
    return (
        <AttachmentStrip className="app-gutter-x pb-2">
            {attachments.map((att, i) => (
                <SimpleAttachmentChip
                    key={att.key}
                    filename={att.filename}
                    mimeType={att.contentType}
                    onRemove={() => onRemove(i)}
                />
            ))}
            {driveReferences.map((ref) => (
                <ReferenceAttachmentChip key={ref.id} reference={ref} onRemove={() => onRemoveReference(ref.id)} />
            ))}
        </AttachmentStrip>
    );
}
