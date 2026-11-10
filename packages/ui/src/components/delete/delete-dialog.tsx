// The yes or no before something is deleted, such as a file, a team or a comment: ConfirmDialog with a destructive
// button, the item's name in bold and the prompt ending as a question.

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
    onCloseAutoFocus?: (event: Event) => void;
};

export function DeleteDialog({
    open,
    onOpenChange,
    title,
    description,
    itemName,
    onDelete,
    cancelText = 'Cancel',
    deleteText = 'Delete',
    onCloseAutoFocus,
}: DeleteDialogProps) {
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
            onCloseAutoFocus={onCloseAutoFocus}
        />
    );
}
