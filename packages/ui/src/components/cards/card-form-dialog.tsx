// The dialog that adds a card, to a document as a comment or to a board's column: the card form under the host's
// title, such as "Add comment" in docs or "Add card" on a board. It is as wide as the dialog an existing card opens
// into, so a card looks the same being made as being read. The host saves the card; the dialog closes once that
// resolves, and every close waits while it runs. Esc, the X and a click outside ask "Discard changes?" once the form
// changed; Cancel drops it.

import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { useDiscardChanges } from '../../hooks/use-discard-changes';
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
    const { pending, run } = useDialogPending(onOpenChange);
    const [changed, setChanged] = useState(false);
    const discard = useDiscardChanges({ open, changed, pending, onDiscard: () => onOpenChange(false) });
    return (
        <>
            <Dialog open={open} onOpenChange={discard.onOpenChange}>
                <DialogContent onFocus={discard.onFocus}>
                    {open && (
                        <CardForm
                            {...rest}
                            onSave={(patch, attachments, assignee) => run(() => onSave(patch, attachments, assignee))}
                            pending={pending}
                            onCancel={() => onOpenChange(false)}
                            onChangedChange={setChanged}
                        />
                    )}
                </DialogContent>
            </Dialog>
            {discard.dialog}
        </>
    );
}
