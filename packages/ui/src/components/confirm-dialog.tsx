// A yes/no dialog for one action, such as deleting a team, that may await a mutation: the buttons wait while it runs,
// and it closes once the action succeeds. With nothing to edit, a server refusal closes it too, since another try gets
// the same no; a failure another try could get past keeps it open beside the error toast.

import type { ReactNode } from 'react';
import { useDialogPending } from '../hooks/use-dialog-pending';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export type ConfirmDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    onConfirm: () => void | Promise<void>;
    cancelText?: string;
    confirmText?: string;
    destructive?: boolean;
};

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    onConfirm,
    cancelText = 'Cancel',
    confirmText = 'Confirm',
    destructive = false,
}: ConfirmDialogProps) {
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange, { closeOnRefusal: true });

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        {cancelText}
                    </Button>
                    <Button
                        variant={destructive ? 'destructive' : 'default'}
                        onClick={() => run(onConfirm)}
                        disabled={pending}
                    >
                        {confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
