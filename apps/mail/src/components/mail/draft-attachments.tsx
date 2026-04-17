import { useAuth } from '@workspace/lib/auth';
import { uploadDraftAttachment } from '@workspace/lib/mail';
import type { AttachmentMeta } from '@workspace/lib/types/mail';
import { Paperclip, X } from 'lucide-react';
import { useCallback, useRef } from 'react';

type DraftAttachmentsProps = {
    attachments: AttachmentMeta[];
    onAdd: (meta: AttachmentMeta) => void;
    onRemove: (index: number) => void;
    disabled?: boolean;
};

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DraftAttachments({ attachments, onAdd, onRemove, disabled }: DraftAttachmentsProps) {
    const { user } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileSelect = useCallback(
        async (files: FileList | null) => {
            if (!files || !user?.id) return;
            for (const file of Array.from(files)) {
                const result = await uploadDraftAttachment(user.id, file);
                if (result) {
                    const localUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
                    onAdd({
                        tempId: result.tempId,
                        filename: result.filename,
                        size: result.size,
                        contentType: result.contentType,
                        localUrl,
                    });
                }
            }
            if (fileInputRef.current) fileInputRef.current.value = '';
        },
        [user?.id, onAdd],
    );

    return (
        <div className="px-4 pb-2">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files)}
                disabled={disabled}
            />
            <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
            >
                <Paperclip className="h-3.5 w-3.5" />
                Attach file
            </button>
            {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                    {attachments.map((att, i) => (
                        <div
                            key={att.tempId || att.index || i}
                            className="inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground border overflow-hidden min-h-10"
                        >
                            {att.localUrl ? (
                                <img
                                    src={att.localUrl}
                                    alt={att.filename}
                                    className="h-10 w-10 object-cover rounded-l-md"
                                />
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
            )}
        </div>
    );
}
