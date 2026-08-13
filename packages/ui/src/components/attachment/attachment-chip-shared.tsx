import { X } from 'lucide-react';

// Building blocks shared by SimpleAttachmentChip and ReferenceAttachmentChip. Kept out of the
// barrel on purpose — these are the chips' internals, not public primitives.

export const CHIP_BASE_CLASS =
    'inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground border overflow-hidden min-h-10';

export function AttachmentChipRemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
    return (
        <button
            type="button"
            className="shrink-0 rounded p-1 mr-1 text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20 transition-colors"
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove();
            }}
            aria-label={`Remove ${label}`}
        >
            <X className="h-3 w-3" />
        </button>
    );
}
