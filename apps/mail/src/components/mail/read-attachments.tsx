import { getMailAttachmentUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { Attachment } from '@workspace/lib/types/mail';
import { Download, Paperclip } from 'lucide-react';

type ReadAttachmentsProps = {
    emailId: string;
    attachments: Attachment[] | undefined;
};

export function ReadAttachments({ emailId, attachments }: ReadAttachmentsProps) {
    const { user } = useAuth();
    if (!attachments?.length || !user) return null;

    const visible = attachments
        .map((a, i) => ({ att: a, index: i }))
        .filter(({ att }) => !att.contentType.startsWith('text/calendar'));
    if (visible.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 mb-4">
            {visible.map(({ att, index }) => {
                const filename = att.filename || `Attachment ${index + 1}`;
                const href = getMailAttachmentUrl(user.id, emailId, index, filename);
                return (
                    <a
                        key={index}
                        href={href}
                        download={filename}
                        className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground hover:bg-muted/80 transition-colors border px-2.5 py-1.5"
                    >
                        <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate max-w-[200px]">{filename}</span>
                        <Download className="h-3 w-3 text-muted-foreground shrink-0" />
                    </a>
                );
            })}
        </div>
    );
}
