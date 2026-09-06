import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { CardForm } from './card-form';

type CardFormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode?: 'create' | 'edit';
    initialTitle?: string;
    initialDescription?: string;
    initialColor?: string;
    allowAttachments?: boolean;
    initialAttachments?: ChatAttachment[];
    members?: EffectiveMember[];
    currentUserEmail?: string;
    initialAssignee?: string | null;
    onSave: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        assignee?: string | null,
    ) => void | Promise<void>;
    dialogTitle?: string;
    placeholderTitle?: string;
    placeholderDescription?: string;
    submitLabel?: string;
};

export function CardFormDialog({ open, onOpenChange, onSave, dialogTitle = 'New card', ...rest }: CardFormDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md">
                {open && (
                    <CardForm
                        {...rest}
                        dialogTitle={dialogTitle}
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
