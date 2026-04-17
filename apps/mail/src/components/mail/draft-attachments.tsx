import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { Paperclip, X } from 'lucide-react';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    onRemove: (index: number) => void;
};

export function DraftAttachments({ attachments, onRemove }: DraftAttachmentsProps) {
    if (attachments.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
            {attachments.map((att, i) => (
                <div
                    key={att.tempId || att.index || i}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground border px-2.5 py-1.5"
                >
                    <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate max-w-[200px]">{att.filename}</span>
                    <button
                        type="button"
                        className="shrink-0 rounded text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => onRemove(i)}
                        aria-label={`Remove ${att.filename}`}
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}
        </div>
    );
}
