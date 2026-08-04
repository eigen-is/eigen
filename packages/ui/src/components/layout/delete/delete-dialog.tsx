import { useState } from 'react';
import { Button } from './../../button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './../../dialog';

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
    const [pending, setPending] = useState(false);

    // Own the async lifecycle: disable both actions in-flight (no double-submit), close only after
    // the callback fulfils, and stay open on rejection so the caller's error toast reads with the retry.
    const handleDelete = async () => {
        if (pending) return;
        setPending(true);
        try {
            await onDelete();
            onOpenChange(false);
        } catch {
            // Stay open for retry; the mutation's onMutationError already surfaced the toast.
        } finally {
            setPending(false);
        }
    };

    // Confirmation prompts read as questions; append "?" unless the caller already terminated the sentence.
    const terminator = /[.?!]$/.test(description) ? '' : '?';
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {itemName ? (
                            <>
                                {description} <strong>{itemName}</strong>
                                {terminator}
                            </>
                        ) : (
                            `${description}${terminator}`
                        )}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        {cancelText}
                    </Button>
                    <Button variant="destructive" onClick={handleDelete} disabled={pending}>
                        {deleteText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
