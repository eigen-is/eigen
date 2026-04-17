import { getMailAttachmentUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { Attachment } from '@workspace/lib/types/mail';
import { SimpleAttachmentChip } from '@workspace/ui/components/layout/attachment';

type ReadAttachmentsProps = {
    emailId: string;
    attachments: Attachment[] | undefined;
};

export function ReadAttachments({ emailId, attachments }: ReadAttachmentsProps) {
    const { user } = useAuth();
    if (!user || !attachments?.length) return null;

    const visible = attachments
        .map((att, index) => ({ att, index }))
        .filter(({ att }) => !att.contentType.startsWith('text/calendar'));
    if (visible.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 mb-4">
            {visible.map(({ att, index }) => {
                const filename = att.filename || `Attachment ${index + 1}`;
                return (
                    <SimpleAttachmentChip
                        key={index}
                        filename={filename}
                        downloadUrl={getMailAttachmentUrl(user.id, emailId, index, filename)}
                    />
                );
            })}
        </div>
    );
}
