import { ConfirmDialog } from '../confirm-dialog';

export type DeleteDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    itemName?: string;
    onDelete: () => void | Promise<void>;
    cancelText?: string;
    deleteText?: string;
};

// Destructive preset over ConfirmDialog: the shared pending/close lifecycle lives there; this adds
// the delete-specific copy — a bolded item name and a "?" terminator on the prompt.
export function DeleteDialog({
    open,
    onOpenChange,
    title,
    description,
    itemName,
    onDelete,
    cancelText = 'Cancel',
    deleteText = 'Delete',
}: DeleteDialogProps) {
    // Confirmation prompts read as questions; append "?" unless the caller already terminated the sentence.
    const terminator = /[.?!]$/.test(description) ? '' : '?';
    return (
        <ConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            description={
                itemName ? (
                    <>
                        {description} <strong>{itemName}</strong>
                        {terminator}
                    </>
                ) : (
                    `${description}${terminator}`
                )
            }
            onConfirm={onDelete}
            cancelText={cancelText}
            confirmText={deleteText}
            destructive
        />
    );
}
