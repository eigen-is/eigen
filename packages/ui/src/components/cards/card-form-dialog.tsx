// The dialog that adds a card, to a document as a comment or to a board's column: the card form under the host's
// title, such as "Add comment" in docs or "Add card" on a board. It is as wide as the dialog an existing card opens
// into, so a card looks the same being made as being read. The host saves the card; the dialog closes once that
// resolves.

import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { Dialog, DialogContent } from '../dialog';
import { CardForm } from './card-form';

type CardFormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    dialogTitle: string;
    submitLabel: string;
    initialTitle?: string;
    allowAttachments?: boolean;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onSave: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        assignee?: string | null,
    ) => void | Promise<void>;
};

export function CardFormDialog({ open, onOpenChange, onSave, ...rest }: CardFormDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                {open && (
                    <CardForm
                        {...rest}
                        onSave={async (patch, attachments, assignee) => {
                            await onSave(patch, attachments, assignee);
                            onOpenChange(false);
                        }}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
