import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { Paperclip, X } from 'lucide-react';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    onRemove: (index: number) => void;
};

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DraftAttachments({ attachments, onRemove }: DraftAttachmentsProps) {
    if (attachments.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
            {attachments.map((att, i) => (
                <div
                    key={att.tempId || att.index || i}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground border overflow-hidden min-h-10"
                >
                    {att.localUrl ? (
                        <img src={att.localUrl} alt={att.filename} className="h-10 w-10 object-cover rounded-l-md" />
                    ) : null}
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                        {!att.localUrl && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                        <span className="truncate max-w-[200px]">{att.filename}</span>
                        <span className="text-muted-foreground">({formatSize(att.size)})</span>
                    </div>
                    <button
                        type="button"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20 transition-colors"
                        onClick={() => onRemove(i)}
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}
        </div>
    );
}
